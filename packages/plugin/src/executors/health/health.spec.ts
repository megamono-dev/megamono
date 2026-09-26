import { logger, type ExecutorContext } from '@nx/devkit';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_MEGAMONO_CONFIG } from '../../lib/config';
import healthExecutor from './health';

describe('profile-aware health executor', () => {
  it.each(['pilot', 'docs', 'pilot-findings', 'pilot-suppression'])(
    '%s preserves its actual verification boundary',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'megamono-pilot-health-'));
      const errors = vi
        .spyOn(logger, 'error')
        .mockImplementation(() => undefined);
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      try {
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(
          join(root, 'docs/invalid.md'),
          '---\nid: [invalid\n---\n',
        );
        await writeFile(
          join(root, 'package.json'),
          '{"name":"fixture","private":true}',
        );
        await writeFile(join(root, 'nx.json'), '{}');
        await writeFile(
          join(root, 'megamono.json'),
          JSON.stringify({
            ...DEFAULT_MEGAMONO_CONFIG,
            adoption: {
              ...DEFAULT_MEGAMONO_CONFIG.adoption,
              modules:
                mode === 'docs'
                  ? ['docs', 'health']
                  : ['lint', 'health', 'inference'],
              ratchets:
                mode === 'pilot-findings'
                  ? [
                      {
                        rule: 'platform-boundary',
                        initialCount: 1,
                        targetSeverity: 'error',
                      },
                    ]
                  : [],
            },
            health: {
              ...DEFAULT_MEGAMONO_CONFIG.health,
              suppressions:
                mode === 'pilot-suppression'
                  ? [
                      {
                        check: 'spec-drift',
                        fingerprint: 'fixture',
                        decision: 'decision-20260908-test',
                      },
                    ]
                  : [],
            },
          }),
        );
        const result = await healthExecutor(
          { checks: ['spec-drift', 'stale-plans'], failOnFindings: true },
          {
            root,
            projectGraph: {
              nodes: {
                api: {
                  name: 'api',
                  type: 'app',
                  data: { root: 'apps/api', tags: [] },
                },
              },
              dependencies: { api: [] },
            },
          } as unknown as ExecutorContext,
        );
        expect(result.success).toBe(mode === 'pilot');
        if (mode.startsWith('pilot') && mode !== 'pilot-suppression') {
          const report = JSON.parse(
            await readFile(join(root, '.megamono/health.json'), 'utf8'),
          );
          expect(report.reductions.join(' ')).toContain('not adopted');
          expect(report.purpose).toBe('advisory');
          expect(report.readiness).toBe('not-assessed');
          expect(report.coverage['stale-plans']).toEqual({
            status: 'skipped',
            reason: 'docs-not-adopted',
          });
          expect(report.coverage['spec-drift'].status).toBe('partial');
          expect(report.coverage['dependency-alignment'].reason).toBe(
            'not-selected',
          );
          expect(report.gate).toEqual({
            mode: 'fail-on-findings',
            passed: mode === 'pilot',
          });
          expect(
            report.findings.some(
              ({ state }: { state: string }) =>
                state === 'undocumented-project',
            ),
          ).toBe(false);
          if (mode === 'pilot-findings')
            expect(
              report.findings.some(
                ({
                  state,
                  category,
                  severity,
                }: {
                  state: string;
                  category: string;
                  severity: string;
                }) =>
                  state === 'adoption-ratchet' &&
                  category === 'adoption-debt' &&
                  severity === 'warning',
              ),
            ).toBe(true);
        }
        if (mode === 'pilot-suppression')
          expect(errors.mock.calls.flat().join(' ')).toContain(
            'suppressions require docs adoption',
          );
      } finally {
        errors.mockRestore();
        info.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
