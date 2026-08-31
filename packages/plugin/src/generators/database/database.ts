import {
  addProjectConfiguration,
  formatFiles,
  getProjects,
  installPackagesTask,
  logger,
  readJson,
  updateJson,
  updateProjectConfiguration,
  writeJson,
  type GeneratorCallback,
  type ProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import { prompt } from 'enquirer';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DATABASE_ADAPTERS,
  isSafeWorkspaceRelativePath,
  megamonoConfigSchema,
  type DatabaseAdapter,
} from '../../lib/config';
import {
  assertWorkspaceMutationGitPreflight,
  collectWorkspaceInitHostState,
} from '../../lib/workspace-init-preflight';
import type { DatabaseGeneratorSchema } from './schema';
import {
  isPackageManager,
  lockfileManagers,
  packageManagerAdapter,
  type PackageManager,
} from '../../lib/package-manager';

interface AdapterCompatibility {
  readonly provider: 'postgresql';
  readonly runtimePackages: Readonly<Record<string, string>>;
  readonly developmentPackages: Readonly<Record<string, string>>;
}

const compatibility = JSON.parse(
  readFileSync(join(__dirname, '../../../compatibility.json'), 'utf8'),
) as {
  readonly scaffoldPackages: Readonly<Record<string, string>>;
  readonly databaseAdapters: Readonly<
    Record<DatabaseAdapter, AdapterCompatibility>
  >;
};

interface NormalizedDatabaseOptions {
  readonly name: string;
  readonly adapter: DatabaseAdapter;
  readonly directory: string;
  readonly project: string;
  readonly packageName: string;
  readonly scope: string;
  readonly packageManager: PackageManager;
  readonly target?: string;
  readonly schema: string;
  readonly existingLayout: boolean;
  readonly dryRun: boolean;
  readonly bootstrap: boolean;
}

const projectTypeTags = new Set([
  'type:app',
  'type:feature',
  'type:ui',
  'type:data',
  'type:util',
]);

function databaseTags(
  options: NormalizedDatabaseOptions,
  existing: readonly string[] = [],
): string[] {
  return [
    ...existing.filter(
      (tag) =>
        !projectTypeTags.has(tag) &&
        !tag.startsWith('platform:') &&
        !tag.startsWith('scope:') &&
        !tag.startsWith('visibility:') &&
        !tag.startsWith('database:'),
    ),
    'platform:node',
    `scope:${options.scope}`,
    'type:data',
    `database:${options.adapter}`,
  ]
    .filter((tag, index, tags) => tags.indexOf(tag) === index)
    .sort();
}

export class DatabaseGeneratorError extends Error {
  readonly diagnosticCode: string;

  constructor(
    message: string,
    readonly exitCode: 2 | 3 | 4,
    diagnostic: string,
  ) {
    super(message);
    this.name = 'DatabaseGeneratorError';
    this.diagnosticCode = `database-${diagnostic}`;
  }
}

function canPrompt(options: DatabaseGeneratorSchema): boolean {
  return (
    options.interactive !== false &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true
  );
}

function slug(value: string, label: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) {
    throw new DatabaseGeneratorError(
      `${label} must contain a letter or number.`,
      2,
      'options',
    );
  }
  return normalized;
}

async function resolveName(options: DatabaseGeneratorSchema): Promise<string> {
  if (options.name) return slug(options.name, 'Database name');
  if (!canPrompt(options)) {
    throw new DatabaseGeneratorError(
      'Database name is required in non-interactive mode.',
      4,
      'decision-required',
    );
  }
  const answer = await prompt<{ name: string }>({
    type: 'input',
    name: 'name',
    message: 'What should this database target be called?',
    initial: 'primary',
  });
  return slug(answer.name, 'Database name');
}

async function resolveAdapter(
  options: DatabaseGeneratorSchema,
): Promise<DatabaseAdapter> {
  if (options.adapter) {
    if (!DATABASE_ADAPTERS.includes(options.adapter)) {
      throw new DatabaseGeneratorError(
        `Unknown database adapter ${options.adapter}.`,
        2,
        'options',
      );
    }
    return options.adapter;
  }
  if (!canPrompt(options)) {
    throw new DatabaseGeneratorError(
      `Database adapter is required in non-interactive mode. Expected one of: ${DATABASE_ADAPTERS.join(', ')}.`,
      4,
      'decision-required',
    );
  }
  const answer = await prompt<{ adapter: DatabaseAdapter }>({
    type: 'select',
    name: 'adapter',
    message: 'Which database toolkit should be scaffolded?',
    choices: [
      { name: 'prisma', message: 'Prisma (recommended)' },
      { name: 'drizzle', message: 'Drizzle' },
    ],
  });
  return answer.adapter;
}

function packageManager(tree: Tree): PackageManager {
  const managers = lockfileManagers((path) => tree.exists(path));
  const declared = readJson<{ packageManager?: string }>(
    tree,
    'package.json',
  ).packageManager?.split('@')[0];
  if (managers.length > 1) {
    throw new DatabaseGeneratorError(
      `Conflicting root package-manager lockfiles are not supported: ${managers.join(', ')}.`,
      3,
      'package-manager',
    );
  }
  const locked = managers[0];
  if (declared && !isPackageManager(declared)) {
    throw new DatabaseGeneratorError(
      `Unsupported package manager ${declared}.`,
      3,
      'package-manager',
    );
  }
  if (declared && locked && declared !== locked) {
    throw new DatabaseGeneratorError(
      `package.json declares ${declared}, but the root lockfile belongs to ${locked}.`,
      3,
      'package-manager',
    );
  }
  const selected = locked ?? (declared as PackageManager | undefined);
  if (!selected) {
    throw new DatabaseGeneratorError(
      'Declare packageManager or commit a supported root lockfile before adding a database.',
      3,
      'package-manager',
    );
  }
  return selected;
}

function workspaceScope(tree: Tree): string {
  const manifest = readJson<{ name?: string }>(tree, 'package.json');
  return slug(
    manifest.name?.replace(/^@/, '').replaceAll('/', '-') ?? 'workspace',
    'Workspace package name',
  );
}

async function normalizeOptions(
  tree: Tree,
  raw: DatabaseGeneratorSchema,
): Promise<NormalizedDatabaseOptions> {
  if (!raw.bootstrap && !tree.exists('megamono.json')) {
    throw new DatabaseGeneratorError(
      'This workspace is not initialized. Run megamono init first.',
      3,
      'not-initialized',
    );
  }
  const name = await resolveName(raw);
  const adapter = await resolveAdapter(raw);
  const scope = slug(raw.scope ?? workspaceScope(tree), 'Database scope');
  const inferredRootPrismaSchema =
    adapter === 'prisma' && tree.exists('prisma/schema.prisma')
      ? 'prisma/schema.prisma'
      : undefined;
  const schema =
    adapter === 'prisma'
      ? (raw.schema?.replace(/^\.\//, '') ?? inferredRootPrismaSchema)
      : undefined;
  const directory =
    raw.directory?.replace(/^\.\//, '').replace(/\/$/, '') ??
    (schema ? dirname(schema) : `packages/database-${name}`);
  if (!isSafeWorkspaceRelativePath(directory)) {
    throw new DatabaseGeneratorError(
      `Database directory must stay inside the workspace; received ${directory}.`,
      2,
      'options',
    );
  }
  const project = raw.project?.trim() || `${scope}-database-${name}`;
  const existingPlaystackTarget = tree.exists('playstack.json')
    ? (
        (
          readJson<Record<string, unknown>>(tree, 'playstack.json')
            .databases as Record<string, unknown> | undefined
        )?.[name] as { target?: unknown } | undefined
      )?.target
    : undefined;
  const existingLayout = tree.exists(
    adapter === 'prisma'
      ? (schema ?? `${directory}/prisma/schema.prisma`)
      : `${directory}/drizzle.config.ts`,
  );
  const target =
    raw.target?.replace(/^\.\//, '').replace(/\/$/, '') ??
    (typeof existingPlaystackTarget === 'string'
      ? existingPlaystackTarget
      : undefined) ??
    (adapter === 'prisma'
      ? existingLayout
        ? undefined
        : `${directory}/prisma/models`
      : `${directory}/src/schema`);
  if (
    target !== undefined &&
    (!isSafeWorkspaceRelativePath(target) ||
      !target.startsWith(`${directory}/`))
  ) {
    throw new DatabaseGeneratorError(
      `Database target must be a safe path inside ${directory}; received ${target}.`,
      2,
      'options',
    );
  }
  const normalizedSchema =
    adapter === 'prisma'
      ? (schema ?? `${directory}/prisma/schema.prisma`)
      : `${directory}/drizzle.config.ts`;
  if (
    !isSafeWorkspaceRelativePath(normalizedSchema) ||
    !normalizedSchema.startsWith(`${directory}/`)
  ) {
    throw new DatabaseGeneratorError(
      `Database schema must be a safe path inside ${directory}; received ${normalizedSchema}.`,
      2,
      'options',
    );
  }
  return {
    name,
    adapter,
    directory,
    project,
    packageName: `@${scope}/database-${name}`,
    scope,
    packageManager: packageManager(tree),
    target,
    schema: normalizedSchema,
    existingLayout,
    dryRun: raw.dryRun === true || process.env.NX_DRY_RUN === 'true',
    bootstrap: raw.bootstrap === true,
  };
}

function projectMatches(
  project: ProjectConfiguration,
  options: NormalizedDatabaseOptions,
): boolean {
  const tags = new Set(project.tags ?? []);
  return (
    project.root === options.directory &&
    project.projectType === 'library' &&
    tags.has('platform:node') &&
    tags.has(`scope:${options.scope}`) &&
    tags.has('type:data') &&
    tags.has(`database:${options.adapter}`)
  );
}

function preflight(
  tree: Tree,
  options: NormalizedDatabaseOptions,
): 'create' | 'adopt' | 'adopt-layout' | 'noop' {
  const configured = options.bootstrap
    ? undefined
    : megamonoConfigSchema.parse(readJson(tree, 'megamono.json')).databases[
        options.name
      ];
  if (
    configured &&
    (configured.adapter !== options.adapter ||
      configured.project !== options.project ||
      ('schema' in configured &&
        configured.schema !== undefined &&
        configured.schema !== options.schema))
  ) {
    throw new DatabaseGeneratorError(
      `Database ${options.name} is already configured as ${configured.adapter} in project ${configured.project}.`,
      3,
      'conflict',
    );
  }
  const projects = getProjects(tree);
  const named = projects.get(options.project);
  const rooted = [...projects.entries()].find(
    ([, project]) => project.root === options.directory,
  );
  assertPlaystackTarget(tree, options);
  if (configured && named && projectMatches(named, options)) return 'noop';
  if (
    !configured &&
    named?.root === options.directory &&
    named.projectType === 'library' &&
    ((options.adapter === 'prisma' && tree.exists(options.schema)) ||
      (options.adapter === 'drizzle' &&
        tree.exists(`${options.directory}/drizzle.config.ts`)))
  ) {
    return 'adopt';
  }
  if (!configured && !named && !rooted && options.existingLayout) {
    return 'adopt-layout';
  }
  if (named || rooted || tree.exists(options.directory)) {
    throw new DatabaseGeneratorError(
      `Cannot add database ${options.name}: project or path ${options.directory} is already occupied by a different contract.`,
      3,
      'conflict',
    );
  }
  return 'create';
}

function assertPlaystackTarget(
  tree: Tree,
  options: NormalizedDatabaseOptions,
): void {
  if (!tree.exists('playstack.json')) return;
  const playstack = readJson<Record<string, unknown>>(tree, 'playstack.json');
  const databases =
    (playstack.databases as Record<string, unknown> | undefined) ?? {};
  const existing = databases[options.name] as
    { adapter?: unknown; dialect?: unknown; target?: unknown } | undefined;
  if (
    existing &&
    (options.target === undefined ||
      existing.adapter !== options.adapter ||
      existing.target !== options.target ||
      (options.adapter === 'drizzle' && existing.dialect !== 'postgresql'))
  ) {
    throw new DatabaseGeneratorError(
      `Playstack database ${options.name} already targets a different adapter, dialect, or path.`,
      3,
      'playstack-conflict',
    );
  }
}

function renderPlan(options: NormalizedDatabaseOptions): string {
  return `# Megamono database plan

- Name: ${options.name}
- Adapter: ${options.adapter}
- Project: ${options.project}
- Root: ${options.directory}
- Playstack target: ${options.target ?? 'deferred until an explicit compatible artifact target is selected'}
- Existing schema: ${options.existingLayout ? options.schema : 'none'}

## Ordered operations

1. Create or adopt the adapter-native database project.
2. Record the database in megamono.json${options.target ? ' and its explicit artifact target in playstack.json' : '; leave Playstack artifact composition deferred'}.
3. Install compatibility-pinned adapter packages.
4. Expose static validation without connecting to a database.
`;
}

function command(
  options: NormalizedDatabaseOptions,
  executable: string,
  args: readonly string[],
): string {
  return packageManagerAdapter(options.packageManager).exec(executable, args);
}

function ensureWorkspacePackagePath(
  tree: Tree,
  options: NormalizedDatabaseOptions,
): void {
  if (options.packageManager !== 'pnpm') {
    updateJson(tree, 'package.json', (value: Record<string, unknown>) => {
      const workspaces = value.workspaces;
      if (workspaces !== undefined && !Array.isArray(workspaces)) {
        throw new DatabaseGeneratorError(
          'The workspace uses an unsupported non-array npm workspaces configuration.',
          3,
          'package-manager',
        );
      }
      return {
        ...value,
        workspaces: [...new Set([...(workspaces ?? []), 'packages/*'])].sort(),
      };
    });
    return;
  }
  const path = 'pnpm-workspace.yaml';
  const current = tree.read(path, 'utf8') ?? 'packages:\n';
  if (!/^packages:\s*$/m.test(current)) {
    throw new DatabaseGeneratorError(
      'pnpm-workspace.yaml must contain a packages list.',
      3,
      'package-manager',
    );
  }
  if (!/^\s*-\s*['"]?packages\/\*['"]?\s*$/m.test(current)) {
    tree.write(path, `${current.replace(/\s*$/, '')}\n  - 'packages/*'\n`);
  }
}

function projectConfiguration(
  options: NormalizedDatabaseOptions,
): ProjectConfiguration {
  const tags = databaseTags(options);
  if (options.adapter === 'prisma') {
    return {
      root: options.directory,
      sourceRoot: `${options.directory}/src`,
      projectType: 'library',
      tags,
      targets: {
        validate: {
          executor: 'nx:run-commands',
          cache: true,
          options: {
            cwd: options.directory,
            command: command(options, 'prisma', [
              'validate',
              '--schema',
              'prisma',
            ]),
          },
        },
        generate: {
          executor: 'nx:run-commands',
          cache: true,
          outputs: ['{projectRoot}/src/generated'],
          options: {
            cwd: options.directory,
            command: command(options, 'prisma', [
              'generate',
              '--schema',
              'prisma',
            ]),
          },
        },
      },
    };
  }
  return {
    root: options.directory,
    sourceRoot: `${options.directory}/src`,
    projectType: 'library',
    tags,
    targets: {
      build: {
        executor: 'nx:run-commands',
        cache: true,
        outputs: ['{projectRoot}/dist'],
        options: {
          cwd: options.directory,
          command: command(options, 'tsc', ['-p', 'tsconfig.json']),
        },
      },
      validate: {
        executor: 'nx:run-commands',
        cache: true,
        options: {
          cwd: options.directory,
          command: command(options, 'tsc', ['--noEmit', '-p', 'tsconfig.json']),
        },
      },
    },
  };
}

function adoptedProjectConfiguration(
  options: NormalizedDatabaseOptions,
): ProjectConfiguration {
  return {
    root: options.directory,
    projectType: 'library',
    tags: databaseTags(options),
    targets: {
      validate: {
        executor: 'nx:run-commands',
        cache: true,
        options: {
          cwd: '.',
          command:
            options.adapter === 'prisma'
              ? command(options, 'prisma', [
                  'validate',
                  '--schema',
                  options.schema,
                ])
              : command(options, 'drizzle-kit', ['check']),
        },
      },
    },
  };
}

function dependencySpecifier(tree: Tree, name: string): string | undefined {
  const manifest = readJson<Record<string, unknown>>(tree, 'package.json');
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const dependencies = manifest[field] as Record<string, unknown> | undefined;
    if (typeof dependencies?.[name] === 'string')
      return dependencies[name] as string;
  }
  return undefined;
}

function writePackage(tree: Tree, options: NormalizedDatabaseOptions): void {
  const adapter = compatibility.databaseAdapters[options.adapter];
  const runtimePackages = Object.fromEntries(
    Object.entries(adapter.runtimePackages).map(([name, pinned]) => [
      name,
      dependencySpecifier(tree, name) ?? pinned,
    ]),
  );
  const developmentPackages = Object.fromEntries(
    Object.entries(adapter.developmentPackages).map(([name, pinned]) => [
      name,
      dependencySpecifier(tree, name) ?? pinned,
    ]),
  );
  writeJson(tree, `${options.directory}/package.json`, {
    name: options.packageName,
    version: '0.0.0',
    private: true,
    type: 'module',
    ...(options.adapter === 'drizzle'
      ? {
          main: './dist/src/index.js',
          types: './dist/src/index.d.ts',
        }
      : {}),
    dependencies: runtimePackages,
    devDependencies: {
      ...developmentPackages,
      typescript:
        dependencySpecifier(tree, 'typescript') ??
        compatibility.scaffoldPackages.typescript,
    },
  });
}

function writePrisma(tree: Tree, options: NormalizedDatabaseOptions): void {
  tree.write(
    `${options.directory}/prisma/schema.prisma`,
    `generator client {\n  provider = "prisma-client"\n  output   = "../src/generated"\n}\n\ndatasource db {\n  provider = "postgresql"\n}\n`,
  );
  tree.write(`${options.directory}/prisma/models/.gitkeep`, '');
  tree.write(
    `${options.directory}/prisma.config.ts`,
    `import { defineConfig } from 'prisma/config';\n\nexport default defineConfig({\n  schema: 'prisma',\n  migrations: { path: 'prisma/migrations' },\n});\n`,
  );
  tree.write(
    `${options.directory}/src/index.ts`,
    `// Generated Prisma client exports are application-owned after running the generate target.\n`,
  );
}

function writeDrizzle(tree: Tree, options: NormalizedDatabaseOptions): void {
  tree.write(`${options.directory}/src/schema/index.ts`, 'export {};\n');
  tree.write(
    `${options.directory}/src/index.ts`,
    `export * from './schema/index.js';\n`,
  );
  tree.write(
    `${options.directory}/drizzle.config.ts`,
    `import { defineConfig } from 'drizzle-kit';\n\nexport default defineConfig({\n  dialect: 'postgresql',\n  schema: './src/schema',\n  out: './drizzle',\n});\n`,
  );
  writeJson(tree, `${options.directory}/tsconfig.json`, {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      declaration: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'dist',
      rootDir: '.',
    },
    include: ['src/**/*.ts', 'drizzle.config.ts'],
  });
}

function writeConfigurations(
  tree: Tree,
  options: NormalizedDatabaseOptions,
): void {
  if (!options.bootstrap) {
    updateJson(tree, 'megamono.json', (value: Record<string, unknown>) => ({
      ...value,
      databases: {
        ...((value.databases as Record<string, unknown> | undefined) ?? {}),
        [options.name]: {
          adapter: options.adapter,
          project: options.project,
          schema: options.schema,
        },
      },
    }));
  }
  if (!options.target) return;
  const playstack = tree.exists('playstack.json')
    ? readJson<Record<string, unknown>>(tree, 'playstack.json')
    : {
        $schema: './node_modules/@playstack/cli/playstack.schema.json',
      };
  const databases =
    (playstack.databases as Record<string, unknown> | undefined) ?? {};
  const existing = databases[options.name] as
    { adapter?: unknown; dialect?: unknown; target?: unknown } | undefined;
  writeJson(tree, 'playstack.json', {
    ...playstack,
    databases: {
      ...databases,
      [options.name]: existing ?? {
        adapter: options.adapter,
        ...(options.adapter === 'drizzle'
          ? { dialect: compatibility.databaseAdapters.drizzle.provider }
          : {}),
        target: options.target,
      },
    },
  });
}

async function confirm(options: DatabaseGeneratorSchema): Promise<boolean> {
  if (options.yes || options.bootstrap) return true;
  if (!canPrompt(options)) {
    throw new DatabaseGeneratorError(
      'Non-interactive database generation requires --yes after all choices are explicit.',
      4,
      'decision-required',
    );
  }
  const answer = await prompt<{ confirmed: boolean }>({
    type: 'confirm',
    name: 'confirmed',
    message: 'Apply this database plan?',
    initial: false,
  });
  return answer.confirmed;
}

export async function databaseGenerator(
  tree: Tree,
  rawOptions: DatabaseGeneratorSchema,
): Promise<GeneratorCallback> {
  const options = await normalizeOptions(tree, rawOptions);
  if (tree.root !== '/virtual' && !options.dryRun && !options.bootstrap) {
    assertWorkspaceMutationGitPreflight(
      await collectWorkspaceInitHostState(tree.root),
      'Database addition',
    );
  }
  const state = preflight(tree, options);
  logger.info(renderPlan(options));
  if (state === 'noop' || options.dryRun) return () => undefined;
  if (!(await confirm(rawOptions))) return () => undefined;

  if (state === 'adopt') {
    const project = getProjects(tree).get(options.project);
    if (!project) {
      throw new DatabaseGeneratorError(
        `Database project ${options.project} disappeared after preflight.`,
        3,
        'conflict',
      );
    }
    updateProjectConfiguration(tree, options.project, {
      ...project,
      tags: databaseTags(options, project.tags),
    });
    writeConfigurations(tree, options);
    await formatFiles(tree);
    return () => undefined;
  }

  if (state === 'adopt-layout') {
    addProjectConfiguration(
      tree,
      options.project,
      adoptedProjectConfiguration(options),
    );
    writeConfigurations(tree, options);
    await formatFiles(tree);
    return () => undefined;
  }

  ensureWorkspacePackagePath(tree, options);
  addProjectConfiguration(tree, options.project, projectConfiguration(options));
  writePackage(tree, options);
  if (options.adapter === 'prisma') writePrisma(tree, options);
  else writeDrizzle(tree, options);
  writeConfigurations(tree, options);
  await formatFiles(tree);
  return () => installPackagesTask(tree);
}

export default databaseGenerator;
