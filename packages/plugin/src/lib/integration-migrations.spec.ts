import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_MIGRATIONS_PATH,
  integrationFingerprint,
  planIntegrationMigrations,
} from './integration-migrations';

const record = {
  key: '@playstack/auth:nest-auth',
  version: '1.0.0',
  fingerprint: integrationFingerprint({ contract: 'auth-v1' }),
  requiredTests: ['refresh-reuse'],
};

describe('integration migration ledger', () => {
  it('requires ordered transitions, current verification, and rollback evidence while preserving other integrations', () => {
    const tree = createTreeWithEmptyWorkspace();
    const other = { ...record, key: '@playstack/storage:storage' };
    const persist = (state: ReturnType<typeof planIntegrationMigrations>) =>
      tree.write(INTEGRATION_MIGRATIONS_PATH, JSON.stringify(state));
    persist(planIntegrationMigrations(tree, [record, other]));
    const request = (stage: string) =>
      JSON.stringify({
        [record.key]: {
          stage,
          verificationReport: 'docs/reports/verification.json',
          rollbackPlan: 'docs/plans/rollback.md',
        },
      });
    expect(() =>
      planIntegrationMigrations(tree, [record], request('cutover')),
    ).toThrow('Invalid migration transition');
    persist(planIntegrationMigrations(tree, [record], request('compare')));
    expect(() =>
      planIntegrationMigrations(tree, [record], request('shadow')),
    ).toThrow('missing');
    tree.write(
      'docs/plans/rollback.md',
      'Restore the previous application writer, then verify session compatibility.',
    );
    for (const stage of ['shadow', 'cutover', 'rollback']) {
      tree.write(
        'docs/reports/verification.json',
        JSON.stringify({
          schemaVersion: 1,
          integration: record.key,
          fingerprint: record.fingerprint,
          stage,
          result: 'passed',
          checks: record.requiredTests,
        }),
      );
      const result = planIntegrationMigrations(tree, [record], request(stage));
      persist(result);
      expect(result.integrations[record.key].stage).toBe(stage);
      expect(result.integrations[other.key].stage).toBe('planned');
      expect(planIntegrationMigrations(tree, [record], request(stage))).toEqual(
        result,
      );
    }
    const state = planIntegrationMigrations(tree, [record], request('compare'));
    expect(
      state.integrations[record.key].history.map(({ stage }) => stage),
    ).toEqual([
      'planned',
      'compare',
      'shadow',
      'cutover',
      'rollback',
      'compare',
    ]);
  });

  it.each([
    { fingerprint: '0'.repeat(64) },
    { checks: ['unrelated'] },
    { result: 'failed' },
    { stage: 'cutover' },
    { integration: 'another:integration' },
  ])('rejects stale or incomplete attestations: %j', (change) => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      INTEGRATION_MIGRATIONS_PATH,
      JSON.stringify(
        planIntegrationMigrations(
          tree,
          [record],
          JSON.stringify({ [record.key]: { stage: 'compare' } }),
        ),
      ),
    );
    tree.write('rollback.md', 'Restore previous integration.');
    tree.write(
      'report.json',
      JSON.stringify({
        schemaVersion: 1,
        integration: record.key,
        fingerprint: record.fingerprint,
        stage: 'shadow',
        result: 'passed',
        checks: record.requiredTests,
        ...change,
      }),
    );
    expect(() =>
      planIntegrationMigrations(
        tree,
        [record],
        JSON.stringify({
          [record.key]: {
            stage: 'shadow',
            verificationReport: 'report.json',
            rollbackPlan: 'rollback.md',
          },
        }),
      ),
    ).toThrow();
  });

  it('invalidates preflight state when contracts change and refuses unknown state entries', () => {
    const tree = createTreeWithEmptyWorkspace();
    const compared = planIntegrationMigrations(
      tree,
      [record],
      JSON.stringify({ [record.key]: { stage: 'compare' } }),
    );
    tree.write(INTEGRATION_MIGRATIONS_PATH, JSON.stringify(compared));
    const changed = planIntegrationMigrations(tree, [
      { ...record, fingerprint: 'f'.repeat(64) },
    ]);
    expect(changed.integrations[record.key].stage).toBe('planned');
    expect(() =>
      planIntegrationMigrations(
        tree,
        [record],
        '{"unknown":{"stage":"compare"}}',
      ),
    ).toThrow('not a selected');
    expect(integrationFingerprint({ a: 1, b: 2 })).toBe(
      integrationFingerprint({ b: 2, a: 1 }),
    );
  });
});
