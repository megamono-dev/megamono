import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

export const BUILT_IN_TOPICS = [
  'agents',
  'apple',
  'architecture',
  'bootstrap',
  'cargo',
  'ci',
  'content-collections',
  'convert',
  'dependencies',
  'docs',
  'email',
  'generators',
  'git',
  'graph',
  'health',
  'import',
  'integrations',
  'lifecycle',
  'lint',
  'migration',
  'nx',
  'observability',
  'plans',
  'playstack',
  'positioning',
  'release',
  'skills',
  'testing',
] as const;

const topicPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const decisionIdPattern = /^decision-\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CONVENTION_RULES = [
  'module-boundaries',
  'docs-visibility-boundary',
  'no-deep-relative-imports',
  'require-tags',
  'naming-convention',
  'megamono-dev-only',
  'playstack-direction',
  'platform-boundary',
  'no-bare-jsx-strings',
] as const;
const structuralRules = new Set<string>([
  'module-boundaries',
  'require-tags',
  'naming-convention',
  'megamono-dev-only',
  'playstack-direction',
  'platform-boundary',
]);

export const MEGAMONO_CONFIG_VERSION = 1 as const;

export function assertSupportedMegamonoConfigVersion(
  value: unknown,
  configPath: string,
): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Object.prototype.hasOwnProperty.call(value, 'version')
  ) {
    return;
  }
  const version = (value as { readonly version?: unknown }).version;
  if (version === MEGAMONO_CONFIG_VERSION) return;

  const renderedVersion = JSON.stringify(version) ?? String(version);
  throw new Error(
    `Unsupported Megamono configuration version ${renderedVersion} at ${configPath}. ` +
      `This @megamono/plugin release supports version ${MEGAMONO_CONFIG_VERSION}. ` +
      `Install a plugin release that supports version ${renderedVersion}, run that release's documented configuration migration, then retry.`,
  );
}

export function isSafeWorkspaceRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}

const ruleOverrideSchema = z
  .object({
    severity: z.enum(['off', 'warning', 'error']),
    decision: z.string().regex(decisionIdPattern).optional(),
  })
  .strict();

const conventionsSchema = z
  .object({
    nestFeatureLibraries: z.boolean().default(true),
    docsLocation: z.literal('centralized').default('centralized'),
    packageManager: z.literal('npm').default('npm'),
    rules: z
      .partialRecord(z.enum(CONVENTION_RULES), ruleOverrideSchema)
      .default({}),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [rule, override] of Object.entries(value.rules)) {
      if (
        override?.severity === 'off' &&
        structuralRules.has(rule) &&
        !override.decision
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'A disabled structural rule must reference an accepted decision ID.',
          path: ['rules', rule, 'decision'],
        });
      }
    }
  });

export const megamonoConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(MEGAMONO_CONFIG_VERSION),
    conventions: conventionsSchema,
    platforms: z
      .array(
        z.enum(['web', 'node', 'worker', 'apple', 'rust', 'php', 'extension']),
      )
      .default([]),
    topics: z
      .object({
        extend: z.array(z.string().regex(topicPattern)).default([]),
      })
      .strict()
      .default({ extend: [] }),
    docs: z
      .object({
        root: z
          .string()
          .min(1)
          .refine(isSafeWorkspaceRelativePath, {
            message: 'Docs root must be a safe workspace-relative path.',
          })
          .default('docs'),
        reportRetentionDays: z.number().int().min(1).max(3650).default(84),
      })
      .strict()
      .default({ root: 'docs', reportRetentionDays: 84 }),
    health: z
      .object({
        cadence: z.enum(['disabled', 'weekly', 'daily']).default('weekly'),
        stalePlanDays: z.number().int().min(7).max(365).default(30),
        checks: z
          .partialRecord(
            z.enum([
              'dependency-alignment',
              'spec-drift',
              'stale-plans',
              'orphaned-libraries',
              'integration-template-drift',
            ]),
            z.boolean(),
          )
          .default({}),
        suppressions: z
          .array(
            z
              .object({
                check: z.enum([
                  'dependency-alignment',
                  'spec-drift',
                  'stale-plans',
                  'orphaned-libraries',
                  'integration-template-drift',
                ]),
                fingerprint: z
                  .string()
                  .min(1)
                  .refine((value) => !value.includes('*'), {
                    message:
                      'Wildcard suppression fingerprints are not allowed.',
                  }),
                decision: z.string().regex(decisionIdPattern),
                expires_at: z.iso.date().optional(),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .default({
        cadence: 'weekly',
        stalePlanDays: 30,
        checks: {},
        suppressions: [],
      }),
    prisma: z
      .object({
        composition: z.literal('native-multi-file'),
        projects: z.array(z.string()).default([]),
      })
      .strict()
      .optional(),
    services: z
      .object({
        runner: z.enum(['none', 'springbar']).default('none'),
        requirements: z
          .partialRecord(
            z.enum(['postgres', 'redis', 'clickhouse', 'typesense']),
            z.string().min(1),
          )
          .default({}),
      })
      .strict()
      .default({ runner: 'none', requirements: {} }),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>(BUILT_IN_TOPICS);
    for (const [index, topic] of value.topics.extend.entries()) {
      if (seen.has(topic)) {
        context.addIssue({
          code: 'custom',
          message: `Topic "${topic}" duplicates the built-in vocabulary.`,
          path: ['topics', 'extend', index],
        });
      }
      seen.add(topic);
    }
  });

export type MegamonoConfig = z.infer<typeof megamonoConfigSchema>;

export const DEFAULT_MEGAMONO_CONFIG: MegamonoConfig =
  megamonoConfigSchema.parse({
    $schema: './node_modules/@megamono/plugin/schemas/megamono.schema.json',
    version: 1,
    conventions: {
      nestFeatureLibraries: true,
      docsLocation: 'centralized',
      packageManager: 'npm',
      rules: {},
    },
    platforms: [],
    topics: { extend: [] },
    docs: { root: 'docs', reportRetentionDays: 84 },
    health: {
      cadence: 'weekly',
      stalePlanDays: 30,
      checks: {
        'dependency-alignment': true,
        'spec-drift': true,
        'stale-plans': true,
        'orphaned-libraries': true,
        'integration-template-drift': true,
      },
      suppressions: [],
    },
    services: { runner: 'none', requirements: {} },
  });

export async function readMegamonoConfig(
  workspaceRoot: string,
  configPath = 'megamono.json',
): Promise<MegamonoConfig> {
  const absolutePath = resolve(workspaceRoot, configPath);
  let source: string;
  try {
    source = await readFile(absolutePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Megamono configuration not found at ${absolutePath}. Run @megamono/plugin:workspace-init first.`,
        { cause: error },
      );
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${absolutePath}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  assertSupportedMegamonoConfigVersion(value, absolutePath);

  const result = megamonoConfigSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid Megamono configuration at ${absolutePath}:\n${details}`,
    );
  }
  return result.data;
}

export function getTopicVocabulary(
  config: MegamonoConfig,
): ReadonlySet<string> {
  return new Set([...BUILT_IN_TOPICS, ...config.topics.extend]);
}
