import { createHash } from 'node:crypto';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import {
  MIGRATION_CONTRACTS,
  selectMigrationContracts,
} from './integration-migration-contracts';
import {
  INTEGRATION_MIGRATIONS_PATH,
  integrationFingerprint,
  planIntegrationMigrations,
} from './integration-migrations';

const key = '@playstack/queues:nest-queues';
describe('application migration contracts', () => {
  it('requires explicit reviewed profiles on active integrations', () => {
    expect(selectMigrationContracts([key])).toEqual({});
    expect(() =>
      selectMigrationContracts([key], '{"unknown":["queue-jobs"]}'),
    ).toThrow('active integration');
    expect(() =>
      selectMigrationContracts([key], JSON.stringify({ [key]: ['unknown'] })),
    ).toThrow();
    expect(() =>
      selectMigrationContracts(
        [key],
        JSON.stringify({ [key]: ['queue-jobs', 'queue-jobs'] }),
      ),
    ).toThrow('Duplicate');
  });
  it.each(Object.keys(MIGRATION_CONTRACTS))(
    'requires qualified evidence for %s, not a generic passed label',
    (profile) => {
      const tests = selectMigrationContracts(
        [key],
        JSON.stringify({ [key]: [profile] }),
      )[key].tests;
      expect(tests.length).toBeGreaterThan(0);
      expect(new Set(tests.map(({ id }) => id)).size).toBe(tests.length);
      expect(
        tests.every(
          ({ environments, description }) =>
            environments.length && description.length,
        ),
      ).toBe(true);
    },
  );
  it.each([
    'passed',
    'monitoring-only',
    'wrong-environment',
    'wrong-kind',
    'missing-evidence',
    'stale-evidence',
    'legacy',
  ])('cannot qualify queue job migration with %s evidence', (scenario) => {
    const tree = createTreeWithEmptyWorkspace();
    const tests = MIGRATION_CONTRACTS['queue-jobs'];
    const record = {
      key,
      version: '1',
      fingerprint: integrationFingerprint({ tests }),
      requiredTests: tests.map(({ id }) => id),
      requiredEnvironments: Object.fromEntries(
        tests.map(({ id, environments }) => [id, environments]),
      ),
      requiredTestKinds: Object.fromEntries(
        tests.map(({ id, kind }) => [id, kind]),
      ),
      requireEvidence: true,
    };
    tree.write(
      INTEGRATION_MIGRATIONS_PATH,
      JSON.stringify(
        planIntegrationMigrations(
          tree,
          [record],
          JSON.stringify({ [key]: { stage: 'compare' } }),
        ),
      ),
    );
    tree.write(
      'rollback.md',
      'Drain the queue and restore the previous producer/worker pair without renaming Redis keys.',
    );
    tree.write('jobs.log', 'Application-owned test output.');
    const sha256 = createHash('sha256')
      .update(tree.read('jobs.log') ?? '')
      .digest('hex');
    const receipt = {
      schemaVersion: 2,
      integration: key,
      fingerprint: record.fingerprint,
      stage: 'shadow',
      result: 'passed',
      sourceRevision: 'a'.repeat(40),
      runtime: {
        node: process.version,
        platform: process.platform,
        versions: {},
      },
      checks: tests.map(({ id, kind }) => ({
        id: scenario === 'monitoring-only' ? 'queuebert-monitoring' : id,
        kind: scenario === 'wrong-kind' ? 'compile' : kind,
        status: 'passed',
        environment:
          scenario === 'wrong-environment' ? 'typecheck' : 'real-queue',
        ...(scenario === 'missing-evidence'
          ? {}
          : {
              evidence: {
                path: 'jobs.log',
                sha256: scenario === 'stale-evidence' ? '0'.repeat(64) : sha256,
              },
            }),
      })),
    };
    tree.write(
      'receipt.json',
      JSON.stringify(
        scenario === 'legacy'
          ? {
              schemaVersion: 1,
              integration: key,
              fingerprint: record.fingerprint,
              stage: 'shadow',
              result: 'passed',
              checks: record.requiredTests,
            }
          : receipt,
      ),
    );
    const before = tree.listChanges();
    const transition = () =>
      planIntegrationMigrations(
        tree,
        [record],
        JSON.stringify({
          [key]: {
            stage: 'shadow',
            verificationReport: 'receipt.json',
            rollbackPlan: 'rollback.md',
          },
        }),
      );
    if (scenario === 'passed')
      expect(transition().integrations[key].stage).toBe('shadow');
    else expect(transition).toThrow();
    expect(tree.listChanges()).toEqual(before);
  });
});
