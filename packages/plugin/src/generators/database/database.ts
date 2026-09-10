import {
  addProjectConfiguration,
  formatFiles,
  getProjects,
  installPackagesTask,
  logger,
  readJson,
  removeProjectConfiguration,
  updateJson,
  updateProjectConfiguration,
  writeJson,
  type GeneratorCallback,
  type ProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import { prompt } from 'enquirer';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
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
  readonly sourceSchema?: string;
  readonly relocate: boolean;
  readonly clientOutput?: string;
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
  const configuredDatabase = tree.exists('megamono.json')
    ? megamonoConfigSchema.parse(readJson(tree, 'megamono.json')).databases[
        name
      ]
    : undefined;
  const configuredProject = configuredDatabase
    ? getProjects(tree).get(configuredDatabase.project)
    : undefined;
  const configuredSchema =
    configuredDatabase && 'schema' in configuredDatabase
      ? configuredDatabase.schema
      : undefined;
  const completedRelocation =
    raw.relocate === true &&
    configuredDatabase?.adapter === 'prisma' &&
    typeof configuredSchema === 'string' &&
    tree.exists(configuredSchema) &&
    configuredProject?.root !== undefined &&
    configuredSchema.startsWith(`${configuredProject.root}/`) &&
    configuredProject.root !== dirname(configuredSchema);
  const inferredRootPrismaSchema =
    adapter === 'prisma' && tree.exists('prisma/schema.prisma')
      ? 'prisma/schema.prisma'
      : undefined;
  const requestedSchema =
    adapter === 'prisma'
      ? (raw.schema?.replace(/^\.\//, '') ??
        inferredRootPrismaSchema ??
        (completedRelocation ? configuredSchema : undefined))
      : undefined;
  const relocate = raw.relocate === true;
  if (relocate && adapter !== 'prisma') {
    throw new DatabaseGeneratorError(
      'Schema relocation is currently supported only for Prisma databases.',
      2,
      'options',
    );
  }
  if (relocate && !requestedSchema) {
    throw new DatabaseGeneratorError(
      'Prisma relocation requires --schema=<path> or an existing prisma/schema.prisma.',
      4,
      'decision-required',
    );
  }
  const directory =
    raw.directory?.replace(/^\.\//, '').replace(/\/$/, '') ??
    (completedRelocation && configuredProject
      ? configuredProject.root
      : !relocate && requestedSchema
        ? dirname(requestedSchema)
        : `libs/${adapter}/${name}`);
  if (!isSafeWorkspaceRelativePath(directory)) {
    throw new DatabaseGeneratorError(
      `Database directory must stay inside the workspace; received ${directory}.`,
      2,
      'options',
    );
  }
  const project = raw.project?.trim() || `${scope}-${adapter}-${name}`;
  const existingPlaystackTarget = tree.exists('playstack.json')
    ? (
        (
          readJson<Record<string, unknown>>(tree, 'playstack.json')
            .databases as Record<string, unknown> | undefined
        )?.[name] as { target?: unknown } | undefined
      )?.target
    : undefined;
  const relocatedPlaystackTarget =
    relocate &&
    requestedSchema &&
    typeof existingPlaystackTarget === 'string' &&
    (existingPlaystackTarget === requestedSchema ||
      existingPlaystackTarget === dirname(requestedSchema))
      ? `${directory}/prisma`
      : existingPlaystackTarget;
  const normalizedSchema =
    adapter === 'prisma'
      ? relocate && !completedRelocation
        ? `${directory}/prisma/${basename(requestedSchema as string)}`
        : (requestedSchema ?? `${directory}/prisma/schema.prisma`)
      : `${directory}/drizzle.config.ts`;
  const existingLayout = tree.exists(
    relocate && !completedRelocation
      ? (requestedSchema as string)
      : normalizedSchema,
  );
  const target =
    raw.target?.replace(/^\.\//, '').replace(/\/$/, '') ??
    (typeof relocatedPlaystackTarget === 'string'
      ? relocatedPlaystackTarget
      : undefined) ??
    (adapter === 'prisma'
      ? existingLayout && !relocate
        ? undefined
        : `${directory}/prisma`
      : `${directory}/src/schema`);
  if (
    target !== undefined &&
    (!isSafeWorkspaceRelativePath(target) ||
      (target !== directory && !target.startsWith(`${directory}/`)))
  ) {
    throw new DatabaseGeneratorError(
      `Database target must be a safe path inside ${directory}; received ${target}.`,
      2,
      'options',
    );
  }
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
  if (
    adapter === 'prisma' &&
    target !== undefined &&
    normalizedSchema !== target &&
    !normalizedSchema.startsWith(`${target}/`)
  ) {
    throw new DatabaseGeneratorError(
      `Prisma target ${target} excludes the datasource-bearing schema ${normalizedSchema}. Select the complete schema folder so compatibility checks include application-owned models.`,
      3,
      'target-coverage',
    );
  }
  const clientOutput = raw.clientOutput
    ?.replace(/^\.\//, '')
    .replace(/\/$/, '');
  if (
    clientOutput !== undefined &&
    (!relocate ||
      !isSafeWorkspaceRelativePath(clientOutput) ||
      clientOutput.startsWith('../') ||
      clientOutput === '.')
  ) {
    throw new DatabaseGeneratorError(
      '--client-output is available only during Prisma relocation and must be a database-project-relative path such as src/generated.',
      2,
      'options',
    );
  }
  if (
    relocate &&
    !completedRelocation &&
    requestedSchema &&
    (requestedSchema === directory ||
      requestedSchema.startsWith(`${directory}/`))
  ) {
    throw new DatabaseGeneratorError(
      `Relocation source ${requestedSchema} must be outside destination project ${directory}.`,
      2,
      'options',
    );
  }
  return {
    name,
    adapter,
    directory,
    project,
    packageName: `@${scope}/${adapter}-${name}`,
    scope,
    packageManager: packageManager(tree),
    target,
    schema: normalizedSchema,
    ...(requestedSchema && relocate && !completedRelocation
      ? { sourceSchema: requestedSchema }
      : {}),
    relocate,
    ...(clientOutput ? { clientOutput } : {}),
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
): 'create' | 'adopt' | 'adopt-layout' | 'relocate' | 'noop' {
  const configured = tree.exists('megamono.json')
    ? megamonoConfigSchema.parse(readJson(tree, 'megamono.json')).databases[
        options.name
      ]
    : undefined;
  if (
    configured &&
    (configured.adapter !== options.adapter ||
      configured.project !== options.project ||
      ('schema' in configured &&
        configured.schema !== undefined &&
        configured.schema !== options.schema &&
        (!options.relocate || configured.schema !== options.sourceSchema)))
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
  if (options.relocate) {
    if (!options.sourceSchema || !tree.exists(options.sourceSchema)) {
      throw new DatabaseGeneratorError(
        `Cannot relocate Prisma schema: source ${options.sourceSchema ?? '(missing)'} does not exist.`,
        3,
        'relocation-source',
      );
    }
    const sourceRoot = dirname(options.sourceSchema);
    if (
      rooted ||
      tree.exists(options.directory) ||
      (named !== undefined && named.root !== sourceRoot)
    ) {
      throw new DatabaseGeneratorError(
        `Cannot relocate database ${options.name}: destination project or path ${options.directory} is occupied by a different contract.`,
        3,
        'conflict',
      );
    }
    if (tree.exists(`${sourceRoot}/package.json`)) {
      throw new DatabaseGeneratorError(
        `Cannot relocate ${sourceRoot}: it already owns package.json. Adopt that project in place or move its package boundary explicitly first.`,
        3,
        'relocation-package-boundary',
      );
    }
    assertRootPrismaConfigCanRelocate(tree, options);
    return 'relocate';
  }
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
  const relocatableTarget =
    options.relocate &&
    options.sourceSchema &&
    existing?.adapter === 'prisma' &&
    (existing.target === options.sourceSchema ||
      existing.target === dirname(options.sourceSchema));
  if (
    existing &&
    !relocatableTarget &&
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

function assertRootPrismaConfigCanRelocate(
  tree: Tree,
  options: NormalizedDatabaseOptions,
): void {
  if (!tree.exists('prisma.config.ts') || !options.sourceSchema) return;
  const source = tree.read('prisma.config.ts', 'utf8') ?? '';
  const sourceRoot = dirname(options.sourceSchema);
  if (
    /\bschema\s*:/.test(source) &&
    !source.includes(options.sourceSchema) &&
    !new RegExp(
      `schema\\s*:\\s*['"]${sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    ).test(source)
  ) {
    throw new DatabaseGeneratorError(
      'The existing prisma.config.ts owns a schema expression Megamono cannot safely rewrite. Update it to an explicit workspace-relative schema path, then rerun relocation.',
      3,
      'relocation-prisma-config',
    );
  }
}

function filesUnder(tree: Tree, root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const child of tree.children(directory)) {
      const path = directory ? `${directory}/${child}` : child;
      if (tree.read(path) !== null) files.push(path);
      else visit(path);
    }
  };
  visit(root);
  return files.sort();
}

function relocationReferencePaths(tree: Tree): string[] {
  const paths = new Set<string>();
  if (tree.exists('package.json')) paths.add('package.json');
  for (const root of [
    '.github',
    'scripts',
    'tools',
    'apps',
    'libs',
    'packages',
  ]) {
    if (tree.children(root).length === 0) continue;
    for (const path of filesUnder(tree, root)) {
      const filename = basename(path);
      if (
        root === '.github' ||
        root === 'scripts' ||
        root === 'tools' ||
        filename === 'package.json' ||
        filename === 'project.json' ||
        filename === 'Dockerfile' ||
        filename.startsWith('Dockerfile.')
      ) {
        paths.add(path);
      }
    }
  }
  return [...paths].sort();
}

function rewriteRelocationReferences(
  tree: Tree,
  options: NormalizedDatabaseOptions,
): void {
  for (const { path, next } of relocationReferenceEdits(tree, options)) {
    tree.write(path, next);
  }
}

function relocationReferenceEdits(
  tree: Tree,
  options: NormalizedDatabaseOptions,
): { path: string; next: string }[] {
  if (!options.sourceSchema || !options.target) return [];
  const edits: { path: string; next: string }[] = [];
  const sourceRoot = dirname(options.sourceSchema);
  const escapedRoot = sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const path of relocationReferencePaths(tree)) {
    if (path.startsWith(`${options.directory}/`)) continue;
    const current = tree.read(path, 'utf8');
    if (current === null) continue;
    const next = current
      .replaceAll(options.sourceSchema, options.target)
      .replaceAll(`${sourceRoot}/migrations`, `${options.target}/migrations`)
      .replace(
        new RegExp(`(--schema(?:=|\\s+))${escapedRoot}(?=[\\s'"]|$)`, 'g'),
        `$1${options.target}`,
      );
    if (next !== current) edits.push({ path, next });
  }
  return edits;
}

function rewriteRootPrismaConfig(
  tree: Tree,
  options: NormalizedDatabaseOptions,
): void {
  if (!options.sourceSchema || !options.target) return;
  const sourceRoot = dirname(options.sourceSchema);
  if (!tree.exists('prisma.config.ts')) {
    tree.write(
      'prisma.config.ts',
      `import { defineConfig } from 'prisma/config';\n\nexport default defineConfig({\n  schema: '${options.target}',\n  migrations: { path: '${options.target}/migrations' },\n});\n`,
    );
    return;
  }
  const current = tree.read('prisma.config.ts', 'utf8') ?? '';
  let next = current
    .replaceAll(options.sourceSchema, options.target)
    .replaceAll(`${sourceRoot}/migrations`, `${options.target}/migrations`);
  const quotedRoot = new RegExp(
    `(schema\\s*:\\s*['"])${sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(['"])`,
  );
  next = next.replace(quotedRoot, `$1${options.target}$2`);
  if (!/\bschema\s*:/.test(next)) {
    next = next.replace(
      /defineConfig\(\{\s*/,
      `defineConfig({\n  schema: '${options.target}',\n  `,
    );
  }
  tree.write('prisma.config.ts', next);
}

function configureRelocatedClientOutput(
  tree: Tree,
  options: NormalizedDatabaseOptions,
): void {
  if (!options.clientOutput) return;
  const current = tree.read(options.schema, 'utf8');
  if (current === null) {
    throw new DatabaseGeneratorError(
      `Relocated schema ${options.schema} disappeared before client output configuration.`,
      3,
      'relocation-schema',
    );
  }
  const output = relative(
    dirname(options.schema),
    `${options.directory}/${options.clientOutput}`,
  ).replaceAll('\\', '/');
  const client = /generator\s+client\s*\{[\s\S]*?\}/;
  const block = current.match(client)?.[0];
  if (!block) {
    throw new DatabaseGeneratorError(
      `Prisma schema ${options.schema} has no generator client block to configure.`,
      3,
      'relocation-client',
    );
  }
  const nextBlock = /\n\s*output\s*=/.test(block)
    ? block.replace(/(\n\s*output\s*=\s*)[^\n]+/, `$1"${output}"`)
    : block.replace(/\n\}/, `\n  output   = "${output}"\n}`);
  tree.write(options.schema, current.replace(client, nextBlock));
}

function relocatePrismaLayout(
  tree: Tree,
  options: NormalizedDatabaseOptions,
): void {
  if (!options.sourceSchema || !options.target) {
    throw new DatabaseGeneratorError(
      'Prisma relocation lost its source schema or destination target.',
      3,
      'relocation-state',
    );
  }
  const sourceRoot = dirname(options.sourceSchema);
  const sourceProject = [...getProjects(tree).entries()].find(
    ([, project]) => project.root === sourceRoot,
  );
  if (sourceProject) removeProjectConfiguration(tree, sourceProject[0]);
  const sourceFiles = filesUnder(tree, sourceRoot).filter(
    (path) => !['project.json', 'package.json'].includes(basename(path)),
  );
  for (const source of sourceFiles) {
    const destination = `${options.target}/${relative(sourceRoot, source)}`;
    tree.rename(source, destination);
  }
  ensureWorkspacePackagePath(tree, options);
  addProjectConfiguration(tree, options.project, projectConfiguration(options));
  writePackage(tree, options);
  if (!tree.exists(`${options.directory}/prisma.config.ts`)) {
    tree.write(
      `${options.directory}/prisma.config.ts`,
      `import { defineConfig } from 'prisma/config';\n\nexport default defineConfig({\n  schema: 'prisma',\n  migrations: { path: 'prisma/migrations' },\n});\n`,
    );
  }
  if (!tree.exists(`${options.directory}/src/index.ts`)) {
    tree.write(
      `${options.directory}/src/index.ts`,
      '// Export the repository-owned Prisma client boundary from this package.\n',
    );
  }
  configureRelocatedClientOutput(tree, options);
  rewriteRelocationReferences(tree, options);
  rewriteRootPrismaConfig(tree, options);
}

function relocationHandoff(
  tree: Tree,
  options: NormalizedDatabaseOptions,
): string {
  if (!options.relocate) return '';
  const files = [
    'Dockerfile',
    'prisma.config.ts',
    ...['apps', 'libs', 'packages', 'scripts', 'tools', '.github'].flatMap(
      (root) => filesUnder(tree, root),
    ),
  ];
  const imports = files.filter(
    (path) =>
      /\.[cm]?[jt]sx?$/.test(path) &&
      (tree.read(path, 'utf8') ?? '').includes('@prisma/client'),
  );
  const deployment = files.filter(
    (path) =>
      /(?:Dockerfile|entrypoint|docker-compose|compose\.ya?ml$)/i.test(path) &&
      tree.exists(path),
  );
  const list = (paths: string[]) =>
    paths.length
      ? [...new Set(paths)]
          .sort()
          .map((path) => `\`${path}\``)
          .join(', ')
      : 'none detected (manual review still required)';
  return `
## Relocation handoff — application verification: not-run

### Automatic relocation scope (${options.sourceSchema ? 'proposed; not yet applied' : 'layout already recorded'})

- Schema directory and migration history: move intact; do not run migrations or rewrite model fields/native timestamp types.
- Known command references: ${list(relocationReferenceEdits(tree, options).map(({ path }) => path))}.
- Prisma configuration: preserve root discovery in \`prisma.config.ts\`; configure the named database project.
- Client output: ${options.clientOutput ? `configure \`${options.directory}/${options.clientOutput}\`` : 'preserve existing output'}; this does not generate or export a client.

### Pending application-owned work (not automatically completed)

- Client boundary: implement/review \`${options.directory}/src/index.ts\`, generated-client exports and singleton/lifecycle ownership. A new index is only a comment placeholder.
- Imports: review ${list(imports)}. Update runtime and type imports to the chosen library boundary; also find custom aliases, dynamic imports and old generated paths. These textual candidates are not an exhaustive import analysis.
- Deployment: review ${list(deployment)}. Update Docker COPY paths, entrypoint migration commands, build/prune configuration and generated runtime assets. A rewritten --schema command does not qualify container packaging.
- Timestamp policy: preserve existing native types (including @db.Timestamptz precision); explicitly review incoming artifacts and test non-UTC round trips before schema adoption.
- Project identity: retain \`${options.project}\`; project renaming is not part of relocation.

### Required acceptance gates

- Validate the complete schema and generate the client; typecheck/build all consumers after import migration.
- Run an isolated container/migration smoke test against an explicitly approved disposable database; verify migration history and packaged runtime assets.
- Review timestamp round trips and application regressions. No database connection, reset, migration, client generation or runtime qualification is performed by this plan.
`;
}

function renderPlan(tree: Tree, options: NormalizedDatabaseOptions): string {
  return `# Megamono database plan

- Name: ${options.name}
- Adapter: ${options.adapter}
- Project: ${options.project}
- Root: ${options.directory}
- Playstack target: ${options.target ?? 'deferred until an explicit compatible artifact target is selected'}
- Existing schema: ${options.existingLayout ? (options.sourceSchema ?? options.schema) : 'none'}
- Relocation: ${options.relocate ? (options.sourceSchema ? `${options.sourceSchema} -> ${dirname(options.schema)}` : 'already complete') : 'no'}
- Generated client: ${options.clientOutput ? `move output to ${options.clientOutput}` : 'preserve existing ownership'}

## Ordered operations

1. ${options.relocate ? 'Move the complete Prisma schema directory into the named context project without running migrations.' : 'Create or adopt the adapter-native database project.'}
2. Record the database in megamono.json${options.target ? ' and its explicit artifact target in playstack.json' : '; leave Playstack artifact composition deferred'}.
3. ${options.relocate ? 'Retarget known repository commands and preserve root Prisma CLI discovery.' : 'Install compatibility-pinned adapter packages.'}
4. Expose static validation and generation without connecting to a database.
${relocationHandoff(tree, options)}
`;
}

function workspacePattern(options: NormalizedDatabaseOptions): string {
  return options.directory;
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
        workspaces: [
          ...new Set([...(workspaces ?? []), workspacePattern(options)]),
        ].sort(),
      };
    });
    return;
  }
  const path = 'pnpm-workspace.yaml';
  const current = tree.read(path, 'utf8') ?? 'packages:\n';
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current.split(/\r?\n/);
  const packagesIndex = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (packagesIndex === -1) {
    throw new DatabaseGeneratorError(
      'pnpm-workspace.yaml must contain a packages list.',
      3,
      'package-manager',
    );
  }
  const pattern = workspacePattern(options);
  let packagesEnd = packagesIndex + 1;
  while (packagesEnd < lines.length && /^\s+\S/.test(lines[packagesEnd])) {
    packagesEnd += 1;
  }
  const entries = lines
    .slice(packagesIndex + 1, packagesEnd)
    .map((line) =>
      line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/)?.[1].trim(),
    )
    .filter((entry): entry is string => Boolean(entry));
  if (!entries.includes(pattern)) {
    lines.splice(packagesEnd, 0, `  - '${pattern}'`);
    tree.write(path, lines.join(newline));
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
            command: 'prisma validate --schema prisma',
          },
        },
        generate: {
          executor: 'nx:run-commands',
          cache: true,
          ...(!options.relocate || options.clientOutput
            ? {
                outputs: [
                  `{projectRoot}/${options.clientOutput ?? 'src/generated'}`,
                ],
              }
            : {}),
          options: {
            cwd: options.directory,
            command: 'prisma generate --schema prisma',
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
          command: 'tsc -p tsconfig.json',
        },
      },
      validate: {
        executor: 'nx:run-commands',
        cache: true,
        options: {
          cwd: options.directory,
          command: 'tsc --noEmit -p tsconfig.json',
        },
      },
    },
  };
}

function adoptedProjectConfiguration(
  options: NormalizedDatabaseOptions,
): ProjectConfiguration {
  const prismaInput = options.target ?? options.schema;
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
              ? `prisma validate --schema ${prismaInput}`
              : 'drizzle-kit check',
        },
      },
      ...(options.adapter === 'prisma' && options.target
        ? {
            generate: {
              executor: 'nx:run-commands',
              cache: true,
              options: {
                cwd: '.',
                command: `prisma generate --schema ${prismaInput}`,
              },
            },
          }
        : {}),
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
    extends: relative(options.directory, 'tsconfig.base.json'),
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
  if (tree.exists('megamono.json')) {
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
      [options.name]: existing
        ? {
            ...existing,
            ...(options.relocate ? { target: options.target } : {}),
          }
        : {
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
  logger.info(renderPlan(tree, options));
  if (state === 'noop' || options.dryRun) return () => undefined;
  if (!(await confirm(rawOptions))) return () => undefined;

  if (state === 'relocate') {
    relocatePrismaLayout(tree, options);
    writeConfigurations(tree, options);
    await formatFiles(tree);
    return () => installPackagesTask(tree);
  }

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
