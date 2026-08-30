import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { PACKAGE_MANAGERS } from './package-manager';

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
export const ADOPTION_STRUCTURAL_RULES = [
  'module-boundaries',
  'require-tags',
  'naming-convention',
  'megamono-dev-only',
  'playstack-direction',
  'platform-boundary',
] as const;
const structuralRules = new Set<string>(ADOPTION_STRUCTURAL_RULES);
export const ADOPTION_MODULES = [
  'docs',
  'agents',
  'ci',
  'release',
  'lint',
  'skills',
  'health',
  'inference',
] as const;
export { PACKAGE_MANAGERS, type PackageManager } from './package-manager';
export const DATABASE_ADAPTERS = ['prisma', 'drizzle'] as const;
export type DatabaseAdapter = (typeof DATABASE_ADAPTERS)[number];

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
    packageManager: z.enum(PACKAGE_MANAGERS).default('npm'),
    apps: z
      .object({
        web: z
          .object({
            router: z.literal('pages').default('pages'),
            src: z.literal(true).default(true),
            ui: z.literal('chakra').default('chakra'),
            e2e: z.literal('playwright').default('playwright'),
          })
          .strict()
          .default({
            router: 'pages',
            src: true,
            ui: 'chakra',
            e2e: 'playwright',
          }),
        api: z
          .object({
            framework: z.literal('nest').default('nest'),
            featureLibraries: z.literal(true).default(true),
            e2e: z.literal('jest').default('jest'),
          })
          .strict()
          .default({ framework: 'nest', featureLibraries: true, e2e: 'jest' }),
      })
      .strict()
      .default({
        web: { router: 'pages', src: true, ui: 'chakra', e2e: 'playwright' },
        api: { framework: 'nest', featureLibraries: true, e2e: 'jest' },
      }),
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

const adoptionSchema = z
  .object({
    modules: z
      .array(z.enum(ADOPTION_MODULES))
      .refine((modules) => new Set(modules).size === modules.length, {
        message: 'Adoption modules must be unique.',
      })
      .default([]),
    reductions: z
      .array(
        z
          .object({
            module: z.enum(ADOPTION_MODULES),
            capability: z.string().regex(topicPattern),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    inference: z
      .object({
        apple: z
          .object({
            plugin: z.literal('@megamono/nx-apple'),
            manifests: z.array(z.string().refine(isSafeWorkspaceRelativePath)),
          })
          .strict()
          .optional(),
        cargo: z
          .object({
            plugin: z.literal('@megamono/nx-cargo'),
            manifests: z.array(z.string().refine(isSafeWorkspaceRelativePath)),
          })
          .strict()
          .optional(),
        cloudflare: z
          .object({
            plugin: z.literal('@megamono/nx-cloudflare'),
            manifests: z.array(z.string().refine(isSafeWorkspaceRelativePath)),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
    ratchets: z
      .array(
        z
          .object({
            rule: z.enum(CONVENTION_RULES),
            initialCount: z.number().int().min(0),
            targetSeverity: z.literal('error'),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .default({ modules: [], reductions: [], inference: {}, ratchets: [] });

const databaseSchema = z
  .object({
    adapter: z.enum(DATABASE_ADAPTERS),
    project: z.string().min(1),
    schema: z.string().refine(isSafeWorkspaceRelativePath).optional(),
  })
  .strict();

const legacyPrismaSchema = z
  .object({
    composition: z.literal('native-multi-file'),
    projects: z
      .array(z.string().min(1))
      .refine((projects) => new Set(projects).size === projects.length, {
        message: 'Legacy Prisma projects must be unique.',
      })
      .default([]),
  })
  .strict();

export const megamonoConfigSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(MEGAMONO_CONFIG_VERSION),
    conventions: conventionsSchema,
    adoption: adoptionSchema,
    platforms: z
      .array(
        z.enum(['web', 'node', 'worker', 'apple', 'rust', 'php', 'extension']),
      )
      .default([]),
    ports: z
      .record(
        z.string().regex(topicPattern),
        z.number().int().min(1024).max(65535),
      )
      .default({}),
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
        loader: z
          .string()
          .min(1)
          .refine(isSafeWorkspaceRelativePath)
          .default('content-collections.ts'),
        module: z
          .string()
          .regex(/^[a-z0-9][a-z0-9._/-]*$/)
          .default('content-collections'),
        output: z
          .string()
          .min(1)
          .refine(isSafeWorkspaceRelativePath)
          .default('.content-collections'),
        loaderMode: z.enum(['create', 'adopt']).default('create'),
      })
      .strict()
      .default({
        root: 'docs',
        reportRetentionDays: 84,
        loader: 'content-collections.ts',
        module: 'content-collections',
        output: '.content-collections',
        loaderMode: 'create',
      }),
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
    databases: z
      .record(z.string().regex(topicPattern), databaseSchema)
      .default({}),
    /** @deprecated Read-only compatibility for pre-database-target workspaces. */
    prisma: legacyPrismaSchema.optional(),
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
    packageSources: z
      .object({
        registries: z
          .record(
            z.string().regex(/^@[a-z0-9][a-z0-9._-]*$/),
            z.url().refine((value) => value.startsWith('https://')),
          )
          .default({}),
        forbidLocalInCi: z.boolean().default(true),
      })
      .strict()
      .default({ registries: {}, forbidLocalInCi: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.prisma && Object.keys(value.databases).length > 0) {
      context.addIssue({
        code: 'custom',
        message:
          'Legacy prisma and named databases configuration cannot be used together.',
        path: ['databases'],
      });
    }
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
  })
  .transform(({ prisma, ...value }) => ({
    ...value,
    databases:
      prisma === undefined
        ? value.databases
        : Object.fromEntries(
            prisma.projects.map((project) => [
              project,
              { adapter: 'prisma' as const, project },
            ]),
          ),
  }));

export type MegamonoConfig = z.infer<typeof megamonoConfigSchema>;

export const DEFAULT_MEGAMONO_CONFIG: MegamonoConfig =
  megamonoConfigSchema.parse({
    $schema: './node_modules/@megamono/plugin/schemas/megamono.schema.json',
    version: 1,
    conventions: {
      nestFeatureLibraries: true,
      docsLocation: 'centralized',
      packageManager: 'npm',
      apps: {
        web: { router: 'pages', src: true, ui: 'chakra', e2e: 'playwright' },
        api: { framework: 'nest', featureLibraries: true, e2e: 'jest' },
      },
      rules: {},
    },
    adoption: {
      modules: [],
      reductions: [],
      inference: {},
      ratchets: [],
    },
    platforms: [],
    ports: {},
    topics: { extend: [] },
    docs: {
      root: 'docs',
      reportRetentionDays: 84,
      loader: 'content-collections.ts',
      module: 'content-collections',
      output: '.content-collections',
      loaderMode: 'create',
    },
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
    databases: {},
    services: { runner: 'none', requirements: {} },
    packageSources: { registries: {}, forbidLocalInCi: true },
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
