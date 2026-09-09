import { logger, type ExecutorContext } from '@nx/devkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import runExecutor from './verify-runtime';
import { verifyRuntimeDependencies } from '../../lib/runtime-verification';

vi.mock('../../lib/runtime-verification', () => ({
  verifyRuntimeDependencies: vi.fn(),
  serializeRuntimeDependencyReport: (report: unknown) => JSON.stringify(report),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(verifyRuntimeDependencies).mockReset();
});
const context = {
  root: '/virtual',
  projectName: 'api',
  projectGraph: {
    nodes: {
      api: {
        data: {
          root: 'apps/api',
          targets: { build: { options: { outputPath: 'dist/apps/api' } } },
        },
      },
    },
  },
} as unknown as ExecutorContext;
describe('runtime evidence executor', () => {
  it.each([
    { findings: [] },
    { findings: [{ code: 'runtime-evidence-invalid' }] },
  ])(
    'passes evidence through and fails when verification reports findings: %j',
    async ({ findings }) => {
      vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      vi.mocked(verifyRuntimeDependencies).mockResolvedValue({
        findings,
      } as Awaited<ReturnType<typeof verifyRuntimeDependencies>>);
      expect(
        await runExecutor(
          { webpackEvidence: '.megamono/evidence.json' },
          context,
        ),
      ).toEqual({ success: findings.length === 0 });
      expect(verifyRuntimeDependencies).toHaveBeenCalledWith({
        workspaceRoot: '/virtual',
        project: 'api',
        projectRoot: 'apps/api',
        outputPath: 'dist/apps/api',
        webpackEvidence: '.megamono/evidence.json',
      });
    },
  );
  it('rejects an out-of-workspace evidence path before reading', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    expect(
      await runExecutor({ webpackEvidence: '../outside.json' }, context),
    ).toEqual({ success: false });
    expect(verifyRuntimeDependencies).not.toHaveBeenCalled();
  });
});
