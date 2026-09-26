import { logger, type ExecutorContext } from '@nx/devkit';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_MEGAMONO_CONFIG,
  megamonoConfigSchema,
  readMegamonoConfig,
} from '../../lib/config';
import { checkWorkspaceStructure } from '../../lib/structural-check';
import type { Diagnostic } from '../../lib/diagnostics';
import check from './check';

vi.mock('../../lib/config', async (original) => ({
  ...(await original<object>()),
  readMegamonoConfig: vi.fn(),
}));
vi.mock('../../lib/structural-check', () => ({
  checkWorkspaceStructure: vi.fn(),
}));
vi.mock('../../lib/project-preflight', () => ({
  checkProjectPreflights: async () => [],
}));
vi.mock('../../lib/managed-skills', () => ({
  validateInstalledSkills: () => [],
}));
vi.mock('../../lib/managed-artifacts', () => ({
  validateManagedArtifactRegistry: () => [],
}));
vi.mock('../../lib/package-sources', () => ({
  validatePackageSources: async () => [],
}));

afterEach(() => vi.restoreAllMocks());

describe('public checker warning budgets', () => {
  it.each([
    ['at ceiling', 2, 2, 'warning', 'platform-boundary', true],
    ['increase', 2, 3, 'warning', 'platform-boundary', false],
    ['unbaselined category', 2, 1, 'warning', 'module-boundaries', false],
    ['fixed debt', 2, 1, 'warning', 'platform-boundary', true],
    ['lowered baseline', 1, 1, 'warning', 'platform-boundary', true],
    ['zero baseline', 0, 1, 'warning', 'platform-boundary', false],
    ['error below budget', 10, 1, 'error', 'platform-boundary', false],
  ] as const)('%s', async (_, budget, count, severity, code, success) => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const config = megamonoConfigSchema.parse({
      ...DEFAULT_MEGAMONO_CONFIG,
      adoption: {
        modules: ['lint'],
        ratchets: [
          {
            rule: 'platform-boundary',
            initialCount: budget,
            targetSeverity: 'error',
          },
        ],
      },
    });
    const before = JSON.stringify(config);
    vi.mocked(readMegamonoConfig).mockResolvedValue(config);
    vi.mocked(checkWorkspaceStructure).mockResolvedValue(
      Array.from({ length: count }, (): Diagnostic => ({
        code,
        severity,
        message: 'fixture',
      })),
    );
    expect(
      await check({}, {
        root: '/fixture',
        projectGraph: { nodes: {}, dependencies: {} },
      } as ExecutorContext),
    ).toEqual({ success });
    expect(JSON.stringify(config)).toBe(before);
  });

  it('rejects duplicate ratchet categories', () => {
    const ratchet = {
      rule: 'platform-boundary',
      initialCount: 1,
      targetSeverity: 'error',
    };
    expect(
      megamonoConfigSchema.safeParse({
        ...DEFAULT_MEGAMONO_CONFIG,
        adoption: { ratchets: [ratchet, ratchet] },
      }).success,
    ).toBe(false);
  });
});
