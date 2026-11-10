import { logger, type ExecutorContext } from '@nx/devkit';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_MEGAMONO_CONFIG,
  megamonoConfigSchema,
  readMegamonoConfig,
} from '../../lib/config';
import { analyzeWorkspaceStructure } from '../../lib/structural-check';
import type { Diagnostic } from '../../lib/diagnostics';
import type { DependencyFindingIdentity } from '../../lib/dependency-policy-contract';
import check from './check';

vi.mock('../../lib/config', async (original) => ({
  ...(await original<object>()),
  readMegamonoConfig: vi.fn(),
}));
vi.mock('../../lib/structural-check', () => ({
  analyzeWorkspaceStructure: vi.fn(),
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
  validatePackageSources: vi.fn(async () => []),
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
    const findings = Array.from({ length: count }, (): Diagnostic => ({
      code,
      severity,
      message: 'fixture',
    }));
    vi.mocked(analyzeWorkspaceStructure).mockResolvedValue({
      diagnostics: findings,
      rawDiagnostics: findings,
      allowed: [],
    });
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

describe('public checker identity reports', () => {
  const identity = (): DependencyFindingIdentity => ({
    rule: 'module-boundaries',
    constraint: 'module-boundaries:type-direction',
    source: 'consumer',
    target: 'provider',
    classification: {
      dependencyKind: 'static',
      source: { kind: 'lib', tags: ['scope:shared', 'type:util'] },
      target: { kind: 'lib', tags: ['scope:shared', 'type:feature'] },
    },
  });
  const finding = (): Diagnostic => ({
    severity: 'warning',
    code: 'module-boundaries',
    message: 'fixture',
    path: 'consumer',
    identity: identity(),
  });
  const policy = () =>
    megamonoConfigSchema.parse({
      ...DEFAULT_MEGAMONO_CONFIG,
      version: 2,
      adoption: {
        modules: ['lint'],
        warningBaseline: {
          identityVersion: 1,
          rules: ['module-boundaries'],
          entries: [
            {
              identity: identity(),
              reason: 'Reviewed debt',
              reviewReference: 'review-123',
              revision: 'b'.repeat(40),
            },
          ],
        },
      },
    });
  async function run(
    config: ReturnType<typeof policy>,
    analysis: Awaited<ReturnType<typeof analyzeWorkspaceStructure>>,
  ) {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.mocked(readMegamonoConfig).mockResolvedValue(config);
    vi.mocked(analyzeWorkspaceStructure).mockResolvedValue(analysis);
    const before = JSON.stringify(config);
    const result = await check({ json: true }, {
      root: '/fixture',
      projectGraph: { nodes: {}, dependencies: {} },
    } as ExecutorContext);
    expect(JSON.stringify(config)).toBe(before);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    return { result, report: JSON.parse(String(info.mock.calls[0][0])) };
  }

  it('reports raw warning severity and reviewed baseline evidence without changing policy', async () => {
    const diagnostic = finding();
    const { result, report } = await run(policy(), {
      diagnostics: [diagnostic],
      rawDiagnostics: [diagnostic],
      allowed: [],
    });
    expect(result).toEqual({ success: true });
    expect(report.raw).toEqual([diagnostic]);
    expect(report.baselined).toEqual([
      {
        diagnostic,
        entry: expect.objectContaining({
          reviewReference: 'review-123',
          revision: 'b'.repeat(40),
        }),
      },
    ]);
    expect(report.new).toEqual([]);
    expect(report.resolved).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it('assesses identity-governed rules even without the lint adoption module', async () => {
    const config = policy();
    config.adoption.modules = [];
    const diagnostic = finding();
    const { result } = await run(config, {
      diagnostics: [diagnostic],
      rawDiagnostics: [diagnostic],
      allowed: [],
    });
    expect(result).toEqual({ success: true });
    expect(vi.mocked(analyzeWorkspaceStructure).mock.calls.at(-1)?.[4]).toEqual(
      new Set([
        'megamono-dev-only',
        'playstack-direction',
        'module-boundaries',
      ]),
    );
    expect(config.adoption.modules).toEqual([]);
  });

  it('fails same-count substitution and makes both new and resolved debt reviewable', async () => {
    const diagnostic = {
      ...finding(),
      identity: { ...identity(), target: 'replacement' },
    };
    const { result, report } = await run(policy(), {
      diagnostics: [diagnostic],
      rawDiagnostics: [diagnostic],
      allowed: [],
    });
    expect(result).toEqual({ success: false });
    expect(report.new[0].identity.target).toBe('replacement');
    expect(report.resolved[0].identity.target).toBe('provider');
    expect(report.errors.map((entry: Diagnostic) => entry.code)).toEqual([
      'adoption-baseline-new',
      'adoption-baseline-resolved',
    ]);
  });

  it('separates reviewed allowances from effective warnings and identity baseline consumption', async () => {
    const config = policy();
    if (!config.adoption.warningBaseline)
      throw new Error('Fixture requires identity mode.');
    config.adoption.warningBaseline = {
      ...config.adoption.warningBaseline,
      entries: [],
    };
    const diagnostic = finding();
    const allowance = {
      source: 'consumer',
      target: 'provider',
      constraint: identity().constraint,
      classification: identity().classification,
      rationale: 'Reviewed design',
      decision: 'decision-20261105-reviewed-edge',
    };
    const { result, report } = await run(config, {
      diagnostics: [],
      rawDiagnostics: [diagnostic],
      allowed: [{ diagnostic, allowance }],
    });
    expect(result).toEqual({ success: true });
    expect(report.raw).toEqual([diagnostic]);
    expect(report.allowed).toEqual([{ diagnostic, allowance }]);
    expect(report.baselined).toEqual([]);
    expect(report.new).toEqual([]);
  });

  it('retains errors and rejects unsupported identity warnings or zero-budget structural categories', async () => {
    const error: Diagnostic = { ...finding(), severity: 'error' };
    const unsupported: Diagnostic = {
      severity: 'warning',
      code: 'module-boundaries',
      message: 'Missing metadata',
    };
    const other: Diagnostic = {
      severity: 'warning',
      code: 'platform-boundary',
      message: 'Other warning',
    };
    const { result, report } = await run(policy(), {
      diagnostics: [error, unsupported, other],
      rawDiagnostics: [error, unsupported, other],
      allowed: [],
    });
    expect(result).toEqual({ success: false });
    expect(report.errors).toContainEqual(error);
    expect(report.errors).toContainEqual(
      expect.objectContaining({ code: 'adoption-baseline-unsupported' }),
    );
    expect(report.errors).toContainEqual(
      expect.objectContaining({ code: 'adoption-ratchet-exceeded' }),
    );
    expect(report.baselined).toEqual([]);
    expect(report.raw[0].severity).toBe('error');
  });

  it('requires reviewed baseline pruning when an exact allowance resolves the warning', async () => {
    const config = policy();
    const diagnostic = finding();
    const allowance = {
      source: 'consumer',
      target: 'provider',
      constraint: identity().constraint,
      classification: identity().classification,
      rationale: 'Reviewed design',
      decision: 'decision-20261105-reviewed-edge',
    };
    config.conventions.boundaryAllowances = [allowance];
    const { result, report } = await run(config, {
      diagnostics: [],
      rawDiagnostics: [diagnostic],
      allowed: [{ diagnostic, allowance }],
    });
    expect(result).toEqual({ success: false });
    expect(report.allowed).toEqual([{ diagnostic, allowance }]);
    expect(report.baselined).toEqual([]);
    expect(report.resolved).toEqual(config.adoption.warningBaseline?.entries);
    expect(report.errors).toEqual([
      expect.objectContaining({ code: 'adoption-baseline-resolved' }),
    ]);
  });

  it('emits structured failure JSON when configuration cannot be read', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.mocked(readMegamonoConfig).mockRejectedValue(
      new Error('Invalid reviewed policy'),
    );
    expect(
      await check({ json: true }, { root: '/fixture' } as ExecutorContext),
    ).toEqual({ success: false });
    expect(JSON.parse(String(info.mock.calls[0][0]))).toMatchObject({
      success: false,
      raw: [],
      allowed: [],
      baselined: [],
      new: [],
      resolved: [],
      errors: [{ severity: 'error', message: 'Invalid reviewed policy' }],
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('does not label accepted legacy count-budget warnings as new identities', async () => {
    const config = megamonoConfigSchema.parse({
      ...DEFAULT_MEGAMONO_CONFIG,
      adoption: {
        modules: ['lint'],
        ratchets: [
          {
            rule: 'module-boundaries',
            initialCount: 2,
            targetSeverity: 'error',
          },
        ],
      },
    });
    const diagnostic: Diagnostic = {
      severity: 'warning',
      code: 'module-boundaries',
      message: 'Count-based legacy debt',
    };
    const { result, report } = await run(config, {
      diagnostics: [diagnostic],
      rawDiagnostics: [diagnostic],
      allowed: [],
    });
    expect(result).toEqual({ success: true });
    expect(report.raw).toEqual([diagnostic]);
    expect(report.policy.ratchets).toEqual(config.adoption.ratchets);
    expect(report.new).toEqual([]);
    expect(report.baselined).toEqual([]);
  });
});

describe('package-source exclusions', () => {
  it('passes excluded project roots to package-source validation and rejects unknown names', async () => {
    const { validatePackageSources } =
      await import('../../lib/package-sources');
    const spy = vi.mocked(validatePackageSources);
    spy.mockClear();
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.mocked(readMegamonoConfig).mockResolvedValue(
      megamonoConfigSchema.parse(DEFAULT_MEGAMONO_CONFIG),
    );
    vi.mocked(analyzeWorkspaceStructure).mockResolvedValue({
      diagnostics: [],
      rawDiagnostics: [],
      allowed: [],
    });
    const context = {
      root: '/fixture',
      projectGraph: {
        nodes: {
          api: { name: 'api', type: 'app', data: { root: 'apps/api' } },
          'api-e2e': {
            name: 'api-e2e',
            type: 'e2e',
            data: { root: 'apps/api-e2e' },
          },
        },
        dependencies: {},
      },
    } as unknown as ExecutorContext;
    expect(
      await check({ profile: 'ci', excludeProjects: 'api, api-e2e' }, context),
    ).toEqual({ success: true });
    expect(spy).toHaveBeenCalledWith('/fixture', expect.anything(), {
      profile: 'ci',
      excludedProjects: [
        { name: 'api', root: 'apps/api' },
        { name: 'api-e2e', root: 'apps/api-e2e' },
      ],
    });
    expect(
      await check({ profile: 'ci', excludeProjects: ['missing'] }, context),
    ).toEqual({ success: false });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('unknown projects: missing'),
    );
    expect(await check({ excludeProjects: ['api'] }, context)).toEqual({
      success: false,
    });
  });
});
