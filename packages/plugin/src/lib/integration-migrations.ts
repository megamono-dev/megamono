import type { Tree } from '@nx/devkit';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const INTEGRATION_MIGRATIONS_PATH =
  '.megamono/playstack-integrations.json';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stage = z.enum(['planned', 'compare', 'shadow', 'cutover', 'rollback']);
const evidence = z.object({ path: z.string(), sha256: digest }).strict();
const transition = z
  .object({
    stage,
    fingerprint: digest,
    verification: evidence.optional(),
    rollback: evidence.optional(),
  })
  .strict();
const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    integrations: z.record(
      z.string(),
      z
        .object({
          version: z.string(),
          fingerprint: digest,
          stage,
          history: z.array(transition).min(1),
        })
        .strict(),
    ),
  })
  .strict();
const requestsSchema = z.record(
  z.string(),
  z
    .object({
      stage: stage.exclude(['planned']),
      verificationReport: z.string().optional(),
      rollbackPlan: z.string().optional(),
    })
    .strict(),
);
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    integration: z.string(),
    fingerprint: digest,
    stage: stage.exclude(['planned', 'compare']),
    result: z.literal('passed'),
    checks: z.array(z.string().min(1)).min(1),
  })
  .strict();

export interface IntegrationMigrationInput {
  readonly key: string;
  readonly version: string;
  readonly fingerprint: string;
  readonly requiredTests: readonly string[];
}

export function integrationFingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : input;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function readEvidence(tree: Tree, path: string) {
  if (
    /^(?:\/|[A-Za-z]:)/.test(path) ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    /(?:^|\/)node_modules\//.test(path)
  )
    throw new Error(
      'Migration evidence must be an application-owned workspace-relative file.',
    );
  const content = tree.read(path, 'utf8');
  if (!content?.trim())
    throw new Error(`Migration evidence ${path} is missing or empty.`);
  return {
    content,
    reference: {
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
    },
  };
}

/** A local reviewed attestation ledger; never executes tests, traffic cutovers or migrations. */
export function planIntegrationMigrations(
  tree: Tree,
  records: readonly IntegrationMigrationInput[],
  input?: string,
) {
  const existing = tree.read(INTEGRATION_MIGRATIONS_PATH, 'utf8');
  const state = stateSchema.parse(
    existing ? JSON.parse(existing) : { schemaVersion: 1, integrations: {} },
  );
  const requests = requestsSchema.parse(input ? JSON.parse(input) : {});
  for (const key of Object.keys(requests))
    if (!records.some((record) => record.key === key))
      throw new Error(`Migration ${key} is not a selected active integration.`);
  for (const record of records) {
    const previous = state.integrations[record.key];
    if (
      previous &&
      (previous.history.at(-1)?.stage !== previous.stage ||
        previous.history.at(-1)?.fingerprint !== previous.fingerprint)
    )
      throw new Error(
        `Migration ledger ${record.key} has inconsistent history.`,
      );
    const request = requests[record.key];
    if (
      previous &&
      previous.fingerprint !== record.fingerprint &&
      ['shadow', 'cutover'].includes(previous.stage)
    )
      throw new Error(
        `Integration ${record.key} changed during ${previous.stage}; record rollback against the previous contract before changing its inputs.`,
      );
    const current: z.infer<typeof stateSchema>['integrations'][string] =
      previous?.fingerprint === record.fingerprint
        ? previous
        : {
            version: record.version,
            fingerprint: record.fingerprint,
            stage: 'planned' as const,
            history: [
              ...(previous?.history ?? []),
              { stage: 'planned' as const, fingerprint: record.fingerprint },
            ],
          };
    state.integrations[record.key] = current;
    if (!request || request.stage === current.stage) continue;
    const allowed: Record<z.infer<typeof stage>, readonly string[]> = {
      planned: ['compare'],
      compare: ['shadow'],
      shadow: ['cutover', 'rollback'],
      cutover: ['rollback'],
      rollback: ['compare'],
    };
    if (!allowed[current.stage].includes(request.stage))
      throw new Error(
        `Invalid migration transition for ${record.key}: ${current.stage} -> ${request.stage}.`,
      );
    let verification: z.infer<typeof evidence> | undefined;
    let rollback: z.infer<typeof evidence> | undefined;
    if (request.stage !== 'compare') {
      if (!request.verificationReport || !request.rollbackPlan)
        throw new Error(
          `${request.stage} requires a passing verificationReport and a reviewed rollbackPlan.`,
        );
      const report = readEvidence(tree, request.verificationReport);
      const receipt = receiptSchema.parse(JSON.parse(report.content));
      if (
        receipt.integration !== record.key ||
        receipt.fingerprint !== record.fingerprint ||
        receipt.stage !== request.stage ||
        record.requiredTests.some((id) => !receipt.checks.includes(id))
      )
        throw new Error(
          `Verification receipt for ${record.key} must match the current fingerprint, transition stage, and all required tests.`,
        );
      verification = report.reference;
      rollback = readEvidence(tree, request.rollbackPlan).reference;
    }
    current.stage = request.stage;
    current.history.push({
      stage: request.stage,
      fingerprint: record.fingerprint,
      ...(verification ? { verification } : {}),
      ...(rollback ? { rollback } : {}),
    });
  }
  return state;
}
