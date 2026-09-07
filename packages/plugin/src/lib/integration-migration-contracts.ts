import { z } from 'zod';

/** Reviewed application contracts supplement, never replace, package tests. */
export const MIGRATION_CONTRACTS = {
  'queue-jobs': [
    {
      id: 'migration.queue-payload-compatibility',
      kind: 'integration',
      environments: ['real-queue'],
      description:
        'Existing and new producers/workers agree on envelope, job IDs and physical Redis prefix; monitoring alone is insufficient.',
    },
    {
      id: 'migration.queue-scheduler-recovery',
      kind: 'integration',
      environments: ['real-queue'],
      description:
        'Schedulers, delayed/retried jobs and drain/rollback behavior are qualified before replacing workers.',
    },
  ],
  'application-persistence': [
    {
      id: 'migration.persistence-behavior',
      kind: 'persistence',
      environments: ['real-database'],
      description:
        'Exercise implemented adapter methods against the selected schema, including uniqueness and tenant isolation; throwing scaffolds or compile-only checks do not qualify.',
    },
    {
      id: 'migration.persistence-rollback',
      kind: 'persistence',
      environments: ['real-database'],
      description:
        'Failure injection proves participating writes roll back on the same physical transaction.',
    },
  ],
  'auth-policy': [
    {
      id: 'migration.auth-session-policy',
      kind: 'security',
      environments: ['real-database'],
      description:
        'Verify reviewed idle/absolute expiry, concurrent-session limits, refresh/replay grace and live membership policies.',
    },
    {
      id: 'migration.auth-transport',
      kind: 'security',
      environments: ['unit'],
      description:
        'Verify the selected cookie/bearer transport, CSRF/origins and SSO behavior where enabled; preserve or explicitly approve policy changes.',
    },
  ],
  'billing-cutover': [
    {
      id: 'migration.billing-projection-comparison',
      kind: 'integration',
      environments: ['real-database'],
      description:
        'Compare existing and candidate projections, event replay/ordering and entitlements against representative provider events.',
    },
    {
      id: 'migration.billing-authority-recovery',
      kind: 'integration',
      environments: ['real-database'],
      description:
        'Prove single-writer authority at cutover and the reviewed rollback path; comparison success alone does not qualify.',
    },
  ],
} as const;
const schema = z.record(
  z.string(),
  z
    .array(
      z.enum([
        'queue-jobs',
        'application-persistence',
        'auth-policy',
        'billing-cutover',
      ]),
    )
    .min(1),
);

export function selectMigrationContracts(
  active: readonly string[],
  input?: string,
) {
  const selections = schema.parse(JSON.parse(input ?? '{}'));
  for (const [key, profiles] of Object.entries(selections)) {
    if (!active.includes(key))
      throw new Error(
        `Migration contracts ${key} do not reference an active integration.`,
      );
    if (new Set(profiles).size !== profiles.length)
      throw new Error(`Duplicate migration contract profile for ${key}.`);
  }
  return Object.fromEntries(
    Object.entries(selections)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, profiles]) => [
        key,
        {
          profiles: [...profiles].sort(),
          tests: profiles
            .flatMap((profile) => [...MIGRATION_CONTRACTS[profile]])
            .sort((a, b) => a.id.localeCompare(b.id)),
        },
      ]),
  );
}
