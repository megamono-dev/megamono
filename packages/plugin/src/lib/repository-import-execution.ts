import { execFile, spawn } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { promisify } from 'node:util';
import matter = require('gray-matter');
import { readMegamonoConfig } from './config';
import { repositoryDocumentSchema } from './docs';
import {
  ImportDecisionError,
  ImportPreflightError,
  normalizedImportDestination,
  rewriteAliasCollisionContent,
  rewriteEnvironmentCollisionContent,
  type RepositoryImportAnalysis,
  type ImportHistoryStrategy,
  type ImportRepositoryRoute,
  type RepositoryImportOptions,
} from './repository-import';

const executeFile = promisify(execFile);

export interface ImportExecutionCommand {
  readonly phase:
    'dependencies' | 'docs' | 'config' | 'graph' | 'build' | 'test' | 'lint';
  readonly command: string;
  readonly args: readonly string[];
  readonly display: string;
  readonly captureOutput?: boolean;
}

export type ImportCommandRunner = (
  command: ImportExecutionCommand,
  workspaceRoot: string,
) => Promise<string | void>;

export interface RepositoryImportMarker {
  readonly schemaVersion: 1 | 2;
  readonly name: string;
  readonly source: string;
  readonly sourceSha: string;
  readonly destination: string;
  readonly history: ImportHistoryStrategy;
  readonly baseSha?: string;
  readonly graftCommit: string;
  readonly repositoryRoutes?: readonly ImportRepositoryRoute[];
  readonly collisionRewrites?: readonly {
    readonly kind: 'alias' | 'environment';
    readonly source: string;
    readonly destination: string;
    readonly affectedFiles: readonly string[];
  }[];
  readonly expectedGraphDependencies?: RepositoryImportAnalysis['expectedGraphDependencies'];
}

export interface RepositoryImportExecutionResult {
  readonly graftCommit: string;
  readonly integrationCommit: string;
  readonly marker: RepositoryImportMarker;
}

export class ImportExecutionError extends Error {
  readonly exitCode = 1;

  constructor(
    readonly phase: string,
    readonly command?: string,
    options?: ErrorOptions,
  ) {
    super(
      command
        ? `Repository import failed during ${phase}: ${command}`
        : `Repository import failed during ${phase}.`,
      options,
    );
  }
}

const NX_TASK_ENVIRONMENT_KEYS = [
  'NX_CLI_SET',
  'NX_FORKED_TASK_EXECUTOR',
  'NX_INVOCATION_ROOT_PID',
  'NX_INVOKED_BY_RUNNER',
  'NX_PREFIX_OUTPUT',
  'NX_PROJECT_NAME',
  'NX_PROJECT_ROOT_PATH',
  'NX_SET_CLI',
  'NX_STREAM_OUTPUT',
  'NX_TASK_HASH',
  'NX_TASK_TARGET_CONFIGURATION',
  'NX_TASK_TARGET_PROJECT',
  'NX_TASK_TARGET_TARGET',
  'NX_TERMINAL_CAPTURE_STDERR',
  'NX_TERMINAL_OUTPUT_PATH',
  'NX_WORKSPACE_ROOT',
  'NX_WORKSPACE_ROOT_PATH',
] as const;

function importSubprocessEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of NX_TASK_ENVIRONMENT_KEYS) delete environment[key];
  return environment;
}

export const runImportCommand: ImportCommandRunner = async (
  command,
  workspaceRoot,
) => {
  if (command.captureOutput) {
    const result = await executeFile(command.command, [...command.args], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: importSubprocessEnvironment(),
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout;
  }
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command.command, [...command.args], {
      cwd: workspaceRoot,
      env: importSubprocessEnvironment(),
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        reject(
          new Error(
            `${command.display} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`,
          ),
        );
      }
    });
  });
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runFile(
  workspaceRoot: string,
  command: string,
  args: readonly string[],
): Promise<string> {
  const result = await executeFile(command, [...args], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: importSubprocessEnvironment(),
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function prepareFilterRepoHistory(
  analysis: RepositoryImportAnalysis,
  staging: string,
): Promise<string> {
  try {
    await runFile(tmpdir(), 'git', ['filter-repo', '--version']);
  } catch (error) {
    throw new ImportPreflightError(
      'import-filter-repo-missing',
      'The filter-repo strategy requires a compatible git-filter-repo executable on PATH.',
      { cause: error },
    );
  }

  const root = await mkdtemp(join(tmpdir(), 'megamono-filter-repo-'));
  try {
    await runFile(root, 'git', ['init', '--initial-branch=import-root']);
    await runFile(root, 'git', [
      'fetch',
      '--no-tags',
      analysis.source,
      analysis.sourceSha,
    ]);
    await runFile(root, 'git', ['checkout', '-B', 'import-root', 'FETCH_HEAD']);
    await runFile(root, 'git', [
      'filter-repo',
      '--force',
      '--refs',
      'refs/heads/import-root',
      '--to-subdirectory-filter',
      staging,
    ]);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw new ImportPreflightError(
      'import-filter-repo-incompatible',
      'The installed git-filter-repo could not rewrite the approved source history with the required flags.',
      { cause: error },
    );
  }
}

function markerPath(name: string): string {
  return `.megamono/imports/${name}.json`;
}

function collisionRewritesAreValid(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (rewrite) =>
          rewrite &&
          typeof rewrite === 'object' &&
          ['alias', 'environment'].includes(
            (rewrite as { kind?: string }).kind ?? '',
          ) &&
          typeof (rewrite as { source?: unknown }).source === 'string' &&
          typeof (rewrite as { destination?: unknown }).destination ===
            'string' &&
          Array.isArray(
            (rewrite as { affectedFiles?: unknown }).affectedFiles,
          ) &&
          (rewrite as { affectedFiles: unknown[] }).affectedFiles.every(
            (path) => typeof path === 'string',
          ),
      ))
  );
}

function graphDependenciesAreValid(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (dependency) =>
          dependency &&
          typeof dependency === 'object' &&
          typeof (dependency as { project?: unknown }).project === 'string' &&
          typeof (dependency as { packageName?: unknown }).packageName ===
            'string',
      ))
  );
}

export async function readRepositoryImportMarker(
  workspaceRoot: string,
  name: string,
): Promise<RepositoryImportMarker | undefined> {
  const path = join(workspaceRoot, markerPath(name));
  if (!(await exists(path))) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ImportPreflightError(
      'import-invalid-marker',
      `Completed import marker ${markerPath(name)} is invalid.`,
      { cause: error },
    );
  }
  const marker = value as Partial<RepositoryImportMarker>;
  if (
    ![1, 2].includes(marker.schemaVersion ?? 0) ||
    marker.name !== name ||
    typeof marker.source !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(marker.sourceSha ?? '') ||
    typeof marker.destination !== 'string' ||
    !['subtree', 'filter-repo', 'squash'].includes(marker.history ?? '') ||
    !/^[a-f0-9]{40}$/i.test(marker.graftCommit ?? '') ||
    (marker.schemaVersion === 2 && !Array.isArray(marker.repositoryRoutes)) ||
    !collisionRewritesAreValid(marker.collisionRewrites) ||
    !graphDependenciesAreValid(marker.expectedGraphDependencies)
  ) {
    throw new ImportPreflightError(
      'import-invalid-marker',
      `Completed import marker ${markerPath(name)} does not match schema version 1.`,
    );
  }
  return marker as RepositoryImportMarker;
}

export async function completedRepositoryImport(
  workspaceRoot: string,
  options: RepositoryImportOptions,
): Promise<RepositoryImportMarker | undefined> {
  const marker = await readRepositoryImportMarker(workspaceRoot, options.name);
  if (!marker) return undefined;
  const destination = normalizedImportDestination(
    options.name,
    options.destination,
  );
  if (marker.destination !== destination) {
    throw new ImportPreflightError(
      'import-marker-conflict',
      `Import ${options.name} already uses destination ${marker.destination}.`,
    );
  }
  if (
    options.expectedSourceSha &&
    marker.sourceSha.toLowerCase() !== options.expectedSourceSha.toLowerCase()
  ) {
    throw new ImportPreflightError(
      'import-marker-conflict',
      `Import ${options.name} already records a different source SHA.`,
    );
  }
  if (options.history && marker.history !== options.history) {
    throw new ImportPreflightError(
      'import-marker-conflict',
      `Import ${options.name} already records the ${marker.history} history strategy.`,
    );
  }
  return marker;
}

export async function assertNoPartialRepositoryImport(
  workspaceRoot: string,
  name: string,
): Promise<void> {
  const staging = join(workspaceRoot, '.megamono-import', name);
  const recovery = join(workspaceRoot, 'MEGAMONO-RECOVERY.md');
  if ((await exists(staging)) || (await exists(recovery))) {
    throw new ImportPreflightError(
      'import-partial-state',
      'A prior import is incomplete. Follow MEGAMONO-RECOVERY.md or inspect the staging graft before retrying.',
    );
  }
}

function projectConfiguration(analysis: RepositoryImportAnalysis) {
  const targets = Object.fromEntries(
    Object.entries(analysis.commands).map(([name, command]) => [
      name,
      {
        executor: 'nx:run-commands',
        cache: name !== 'deploy',
        inputs: ['default', '^default'],
        options: { command, cwd: analysis.destination },
      },
    ]),
  );
  return {
    name: analysis.name,
    $schema: posix.relative(
      analysis.destination,
      'node_modules/nx/schemas/project-schema.json',
    ),
    projectType: 'application',
    sourceRoot: analysis.sourceFiles.some((path) => path.startsWith('src/'))
      ? `${analysis.destination}/src`
      : analysis.destination,
    tags: ['platform:node', 'scope:shared', 'type:app', 'visibility:internal'],
    targets,
  };
}

function addWorkspace(
  manifest: Record<string, unknown>,
  destination: string,
): void {
  const workspaces = manifest.workspaces;
  if (
    workspaces &&
    typeof workspaces === 'object' &&
    !Array.isArray(workspaces)
  ) {
    const value = workspaces as { packages?: unknown };
    const packages = Array.isArray(value.packages) ? value.packages : [];
    value.packages = [...new Set([...packages, destination])].sort();
    return;
  }
  const values = Array.isArray(workspaces) ? workspaces : [];
  manifest.workspaces = [...new Set([...values, destination])].sort();
}

async function addPnpmWorkspace(
  workspaceRoot: string,
  destination: string,
): Promise<void> {
  const path = join(workspaceRoot, 'pnpm-workspace.yaml');
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new ImportPreflightError(
      'import-pnpm-workspace-missing',
      'A pnpm target must contain pnpm-workspace.yaml.',
      { cause: error },
    );
  }
  const escapedDestination = destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    new RegExp(
      `^\\s*-\\s*['"]?${escapedDestination}['"]?\\s*(?:#.*)?$`,
      'm',
    ).test(source)
  ) {
    return;
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const packagesIndex = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (packagesIndex === -1) {
    throw new ImportPreflightError(
      'import-pnpm-workspace-shape',
      'pnpm-workspace.yaml must contain a block-style packages list.',
    );
  }
  let end = packagesIndex + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  lines.splice(end, 0, `  - '${destination}'`);
  await writeFile(path, lines.join(newline), 'utf8');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function integratePackageManifests(
  workspaceRoot: string,
  analysis: RepositoryImportAnalysis,
): Promise<void> {
  const rootPath = join(workspaceRoot, 'package.json');
  const appPath = join(workspaceRoot, analysis.destination, 'package.json');
  const root = JSON.parse(await readFile(rootPath, 'utf8')) as Record<
    string,
    unknown
  >;
  const app = JSON.parse(await readFile(appPath, 'utf8')) as Record<
    string,
    unknown
  >;
  if (analysis.packageManager === 'pnpm') {
    await addPnpmWorkspace(workspaceRoot, analysis.destination);
  } else {
    addWorkspace(root, analysis.destination);
  }
  for (const conflict of analysis.dependencyConflicts) {
    if (!conflict.resolution) continue;
    for (const section of ['dependencies', 'devDependencies'] as const) {
      const dependencies = app[section];
      if (
        dependencies &&
        typeof dependencies === 'object' &&
        !Array.isArray(dependencies) &&
        conflict.name in dependencies
      ) {
        (dependencies as Record<string, unknown>)[conflict.name] =
          conflict.resolution;
      }
    }
  }
  await writeJson(rootPath, root);
  await writeJson(appPath, app);
}

async function integrateDocumentationTopics(
  workspaceRoot: string,
  analysis: RepositoryImportAnalysis,
): Promise<void> {
  if (analysis.documentationTopicsToExtend.length === 0) return;
  const configPath = join(workspaceRoot, 'megamono.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    topics?: { extend?: unknown };
  };
  config.topics ??= {};
  const current = Array.isArray(config.topics.extend)
    ? config.topics.extend.filter(
        (topic): topic is string => typeof topic === 'string',
      )
    : [];
  config.topics.extend = [
    ...new Set([...current, ...analysis.documentationTopicsToExtend]),
  ].sort();
  await writeJson(configPath, config);
}

function serializeImportedDocument(
  data: Readonly<Record<string, unknown>>,
  content: string,
): string {
  const frontMatter = Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
  return `---\n${frontMatter}\n---\n\n${content.trim()}\n`;
}

async function migrateRepositoryRoutes(
  workspaceRoot: string,
  analysis: RepositoryImportAnalysis,
): Promise<void> {
  for (const route of analysis.repositoryRoutes) {
    const source = join(workspaceRoot, analysis.destination, route.source);
    const destination = join(workspaceRoot, route.destination);
    await mkdir(dirname(destination), { recursive: true });
    if (route.action !== 'migrate-document') {
      await rename(source, destination);
      continue;
    }
    if (!route.document) {
      throw new ImportPreflightError(
        'import-document-route',
        `Documentation route ${route.source} is missing document metadata.`,
      );
    }
    const sourceContent = await readFile(source, 'utf8');
    let body: string;
    let data: Record<string, unknown>;
    if (route.document.mode === 'preserve') {
      const parsed = matter(sourceContent);
      const result = repositoryDocumentSchema.safeParse(parsed.data);
      if (!result.success || result.data.id !== route.document.id) {
        throw new ImportPreflightError(
          'import-document-changed',
          `Documentation route ${route.source} no longer matches its approved metadata.`,
        );
      }
      body = parsed.content;
      data = {
        ...result.data,
        projects: [analysis.name],
      };
    } else {
      try {
        body = matter(sourceContent).content || sourceContent;
      } catch {
        body = sourceContent;
      }
      data = {
        id: route.document.id,
        type: route.document.type,
        status: route.document.status,
        visibility: 'internal',
        projects: [analysis.name],
        topics: ['docs', 'import', 'migration'],
        summary: `Imported source documentation from ${route.source}.`,
        date: route.document.date,
        supersedes: null,
        references: [],
        external_references: [],
      };
    }
    await writeFile(destination, serializeImportedDocument(data, body), 'utf8');
    await rm(source);
  }
}

function plannedCollisionRewrites(analysis: RepositoryImportAnalysis) {
  return analysis.collisions.flatMap((collision) =>
    (collision.kind === 'alias' || collision.kind === 'environment') &&
    collision.resolution
      ? [
          {
            kind: collision.kind,
            source: collision.name,
            destination: collision.resolution,
            affectedFiles: collision.affectedFiles ?? [],
          },
        ]
      : [],
  );
}

async function applyCollisionRewrites(
  workspaceRoot: string,
  analysis: RepositoryImportAnalysis,
): Promise<void> {
  for (const rewrite of plannedCollisionRewrites(analysis)) {
    for (const path of rewrite.affectedFiles) {
      const absolutePath = join(workspaceRoot, analysis.destination, path);
      if (!(await exists(absolutePath))) {
        throw new ImportPreflightError(
          'import-collision-rewrite-scope-changed',
          `Approved collision rewrite file ${path} is missing after the history graft.`,
        );
      }
      const content = await readFile(absolutePath, 'utf8');
      const rewritten =
        rewrite.kind === 'alias'
          ? rewriteAliasCollisionContent(
              path,
              content,
              rewrite.source,
              rewrite.destination,
            )
          : rewriteEnvironmentCollisionContent(
              path,
              content,
              rewrite.source,
              rewrite.destination,
            );
      if (rewritten === content) {
        throw new ImportPreflightError(
          'import-collision-rewrite-scope-changed',
          `Approved collision rewrite no longer matches ${path}.`,
        );
      }
      await writeFile(absolutePath, rewritten, 'utf8');
    }
  }
}

function importDecision(
  analysis: RepositoryImportAnalysis,
  history: ImportHistoryStrategy,
  generatedAt = new Date(),
): { readonly path: string; readonly content: string } {
  const isoDate = generatedAt.toISOString().slice(0, 10);
  const compactDate = isoDate.replaceAll('-', '');
  const slug = `import-${analysis.name}-${analysis.sourceSha.slice(0, 8)}`;
  const id = `decision-${compactDate}-${slug}`;
  const documentationRoutes = analysis.repositoryRoutes.filter(
    ({ reason }) => reason === 'documentation',
  ).length;
  const archivedInfrastructure = analysis.repositoryRoutes.filter(
    ({ reason }) => reason === 'infrastructure',
  ).length;
  const collisionRewrites = plannedCollisionRewrites(analysis);
  const historyRationale =
    history === 'subtree'
      ? 'Subtree preserves the source commit graph and creates a legible graft point without rewriting source commit SHAs.'
      : history === 'filter-repo'
        ? 'Filter-repo preserves the source commit graph beneath the final destination prefix and improves path-following continuity, while acknowledging that every imported commit receives a new SHA.'
        : 'Squash records the source at its approved immutable SHA as one snapshot commit; the source commit graph is intentionally not carried into the target repository.';
  const historyConsequence =
    history === 'subtree'
      ? 'History before the graft remains reachable, but path-following across the staging-prefix integration move may degrade.'
      : history === 'filter-repo'
        ? 'Imported history remains reachable with rewritten destination-prefixed paths, but its commit SHAs differ from the source repository.'
        : 'Only the approved source snapshot is represented in target history; earlier source commits are not ancestors of the imported project.';
  return {
    path: `decisions/${compactDate}-${slug}.md`,
    content: `---
id: ${JSON.stringify(id)}
type: "decision"
status: "accepted"
visibility: "internal"
projects: ${JSON.stringify([analysis.name])}
topics: ["import", "migration"]
summary: ${JSON.stringify(`Import ${analysis.name} with ${history} history`)}
date: ${JSON.stringify(isoDate)}
supersedes: null
references: []
external_references: []
---

# Import ${analysis.name} with ${history} history

## Decision

Import ${analysis.source} at immutable commit \`${analysis.sourceSha}\` into \`${analysis.destination}\` using the ${history} strategy.

## Why

${historyRationale}

## Consequences

${historyConsequence} ${documentationRoutes} source documentation record(s) were migrated into the host corpus and ${archivedInfrastructure} repository-infrastructure file(s) were preserved under the import record without becoming active. ${collisionRewrites.length} approved alias/environment collision rewrite(s) changed ${new Set(collisionRewrites.flatMap(({ affectedFiles }) => affectedFiles)).size} source-owned file(s). ${analysis.expectedGraphDependencies.length} target-project dependency edge(s) were required during verification. The source repository remains unchanged and is not archived or redirected by this operation.
`,
  };
}

function verificationCommands(
  analysis: RepositoryImportAnalysis,
): ImportExecutionCommand[] {
  if (analysis.verify === 'none') return [];
  const packageManager = analysis.packageManager;
  const nxArgs = (args: readonly string[], separator = false) => [
    'exec',
    'nx',
    ...(separator && packageManager === 'npm' ? ['--'] : []),
    ...args,
  ];
  const nxDisplay = (args: readonly string[], separator = false) =>
    `${packageManager} exec nx${separator && packageManager === 'npm' ? ' --' : ''} ${args.join(' ')}`;
  const commands: ImportExecutionCommand[] = [
    {
      phase: 'config',
      command: packageManager,
      args: nxArgs(['run', 'megamono-docs:validate']),
      display: nxDisplay(['run', 'megamono-docs:validate']),
    },
    {
      phase: 'config',
      command: packageManager,
      args: nxArgs(['run', 'megamono:check']),
      display: nxDisplay(['run', 'megamono:check']),
    },
    {
      phase: 'config',
      command: packageManager,
      args: nxArgs(['show', 'project', analysis.name, '--json']),
      display: nxDisplay(['show', 'project', analysis.name, '--json']),
    },
  ];
  if (analysis.expectedGraphDependencies.length > 0) {
    commands.push({
      phase: 'graph',
      command: packageManager,
      args: nxArgs(['graph', '--print'], true),
      display: nxDisplay(['graph', '--print'], true),
      captureOutput: true,
    });
  }
  if (analysis.verify === 'build') {
    for (const phase of ['build', 'test', 'lint'] as const) {
      if (!analysis.commands[phase]) continue;
      commands.push({
        phase,
        command: packageManager,
        args: nxArgs(['run', `${analysis.name}:${phase}`]),
        display: nxDisplay(['run', `${analysis.name}:${phase}`]),
      });
    }
  }
  return commands;
}

function assertExpectedGraphDependencies(
  analysis: RepositoryImportAnalysis,
  output: string | void,
): void {
  if (analysis.expectedGraphDependencies.length === 0) return;
  if (typeof output !== 'string') {
    throw new Error(
      'Nx graph verification did not return machine-readable output.',
    );
  }
  let graph: {
    graph?: {
      dependencies?: Readonly<
        Record<string, readonly { readonly target?: string }[]>
      >;
    };
  };
  try {
    graph = JSON.parse(output) as typeof graph;
  } catch (error) {
    throw new Error('Nx graph verification returned invalid JSON.', {
      cause: error,
    });
  }
  const actual = new Set(
    (graph.graph?.dependencies?.[analysis.name] ?? []).flatMap(({ target }) =>
      target ? [target] : [],
    ),
  );
  const missing = analysis.expectedGraphDependencies.filter(
    ({ project }) => !actual.has(project),
  );
  if (missing.length > 0) {
    throw new Error(
      `Nx graph is missing required imported-project dependencies: ${missing
        .map(({ project, packageName }) => `${project} (${packageName})`)
        .join(', ')}.`,
    );
  }
}

export function renderRepositoryImportRecovery(
  analysis: RepositoryImportAnalysis,
  history: ImportHistoryStrategy,
  phase: string,
  graftCommit?: string,
  command?: string,
): string {
  return `# Megamono repository import recovery

Import of \`${analysis.name}\` stopped during the \`${phase}\` phase.

- Rollback base: \`${analysis.targetGit.baseSha ?? 'unavailable'}\`
- Source: \`${analysis.source}\`
- Source SHA: \`${analysis.sourceSha}\`
- Destination: \`${analysis.destination}\`
- History strategy: \`${history}\`
- Graft commit: \`${graftCommit ?? 'not created'}\`
${command ? `- Failed command: \`${command}\`\n- Retry command: \`${command}\`\n` : ''}
Inspect the branch and working tree before retrying. Megamono did not reset, revert, push, modify the source repository, or create the final integration commit.
`;
}

export async function executeRepositoryImport(
  workspaceRoot: string,
  analysis: RepositoryImportAnalysis,
  options: RepositoryImportOptions,
  runner: ImportCommandRunner = runImportCommand,
): Promise<RepositoryImportExecutionResult> {
  const history = options.history;
  if (!history) {
    throw new ImportDecisionError(
      'import-history-required',
      'Execution requires an explicit history strategy.',
    );
  }
  if (!options.expectedSourceSha) {
    throw new ImportDecisionError(
      'import-expected-source-sha-required',
      'Execution requires expectedSourceSha from the approved analysis.',
    );
  }
  if (analysis.blockers.length > 0 || analysis.unresolved.length > 0) {
    const issue = analysis.blockers[0] ?? analysis.unresolved[0];
    if (!issue) {
      throw new ImportDecisionError(
        'import-not-ready',
        'Repository import analysis is not ready for execution.',
      );
    }
    throw new ImportDecisionError(issue.code, issue.message);
  }
  let docsRoot: string;
  try {
    docsRoot = (await readMegamonoConfig(workspaceRoot)).docs.root;
  } catch (error) {
    throw new ImportPreflightError(
      'import-host-config',
      'The target megamono.json must be valid before import.',
      { cause: error },
    );
  }
  const decision = importDecision(analysis, history);
  const decisionPath = posix.join(docsRoot, decision.path);
  if (
    (await exists(join(workspaceRoot, decisionPath))) ||
    analysis.repositoryRoutes.some(
      ({ destination }) => destination === decisionPath,
    )
  ) {
    throw new ImportPreflightError(
      'import-decision-collision',
      `Import decision destination ${decisionPath} is already owned.`,
    );
  }

  const staging = `.megamono-import/${analysis.name}`;
  const filteredRepository =
    history === 'filter-repo'
      ? await prepareFilterRepoHistory(analysis, analysis.destination)
      : undefined;
  let phase = 'history';
  let graftCommit: string | undefined;
  let failedCommand: string | undefined;
  try {
    if (history === 'subtree') {
      failedCommand = `git subtree add --prefix=${staging} ${analysis.source} ${analysis.sourceSha}`;
      await runFile(workspaceRoot, 'git', [
        'subtree',
        'add',
        `--prefix=${staging}`,
        analysis.source,
        analysis.sourceSha,
      ]);
      await runFile(workspaceRoot, 'git', [
        'commit',
        '--amend',
        '-m',
        `graft ${analysis.name} history at ${analysis.sourceSha.slice(0, 12)}`,
      ]);
    } else if (history === 'squash') {
      failedCommand = `git fetch --no-tags ${analysis.source} ${analysis.sourceSha}`;
      await runFile(workspaceRoot, 'git', [
        'fetch',
        '--no-tags',
        analysis.source,
        analysis.sourceSha,
      ]);
      failedCommand = `git read-tree --prefix=${staging}/ -u ${analysis.sourceSha}^{tree}`;
      await runFile(workspaceRoot, 'git', [
        'read-tree',
        `--prefix=${staging}/`,
        '-u',
        `${analysis.sourceSha}^{tree}`,
      ]);
      failedCommand = 'git commit';
      await runFile(workspaceRoot, 'git', [
        'commit',
        '-m',
        `graft ${analysis.name} squash at ${analysis.sourceSha.slice(0, 12)}`,
      ]);
    } else {
      if (!filteredRepository) {
        throw new ImportPreflightError(
          'import-filter-repo-incompatible',
          'The rewritten source repository was not prepared.',
        );
      }
      failedCommand = `git fetch --no-tags ${filteredRepository} refs/heads/import-root`;
      await runFile(workspaceRoot, 'git', [
        'fetch',
        '--no-tags',
        filteredRepository,
        'refs/heads/import-root',
      ]);
      failedCommand =
        'git merge --allow-unrelated-histories --no-ff FETCH_HEAD';
      await runFile(workspaceRoot, 'git', [
        'merge',
        '--allow-unrelated-histories',
        '--no-ff',
        '-m',
        `graft ${analysis.name} filter-repo history at ${analysis.sourceSha.slice(0, 12)}`,
        'FETCH_HEAD',
      ]);
    }
    graftCommit = await runFile(workspaceRoot, 'git', ['rev-parse', 'HEAD']);

    phase = 'integration';
    failedCommand = undefined;
    const destination = join(workspaceRoot, analysis.destination);
    await mkdir(dirname(destination), { recursive: true });
    if (history !== 'filter-repo') {
      await rename(join(workspaceRoot, staging), destination);
    }
    await integratePackageManifests(workspaceRoot, analysis);
    await migrateRepositoryRoutes(workspaceRoot, analysis);
    await applyCollisionRewrites(workspaceRoot, analysis);
    await integrateDocumentationTopics(workspaceRoot, analysis);
    await writeJson(
      join(workspaceRoot, analysis.destination, 'project.json'),
      projectConfiguration(analysis),
    );
    await mkdir(dirname(join(workspaceRoot, docsRoot, decision.path)), {
      recursive: true,
    });
    await writeFile(
      join(workspaceRoot, docsRoot, decision.path),
      decision.content,
      'utf8',
    );
    const marker: RepositoryImportMarker = {
      schemaVersion: 2,
      name: analysis.name,
      source: analysis.source,
      sourceSha: analysis.sourceSha,
      destination: analysis.destination,
      history,
      ...(analysis.targetGit.baseSha
        ? { baseSha: analysis.targetGit.baseSha }
        : {}),
      graftCommit,
      repositoryRoutes: analysis.repositoryRoutes,
      collisionRewrites: plannedCollisionRewrites(analysis),
      expectedGraphDependencies: analysis.expectedGraphDependencies,
    };
    await writeJson(join(workspaceRoot, markerPath(analysis.name)), marker);

    const commands: ImportExecutionCommand[] = [
      {
        phase: 'dependencies',
        command: analysis.packageManager,
        args: ['install'],
        display: `${analysis.packageManager} install`,
      },
      {
        phase: 'docs',
        command: analysis.packageManager,
        args: ['exec', 'nx', 'run', 'megamono-docs:index'],
        display: `${analysis.packageManager} exec nx run megamono-docs:index`,
      },
      ...verificationCommands(analysis),
    ];
    for (const command of commands) {
      phase = command.phase;
      failedCommand = command.display;
      try {
        const output = await runner(command, workspaceRoot);
        if (command.phase === 'graph') {
          assertExpectedGraphDependencies(analysis, output);
        }
      } catch (error) {
        throw new ImportExecutionError(command.phase, command.display, {
          cause: error,
        });
      }
    }

    phase = 'commit';
    failedCommand = 'git commit';
    await runFile(workspaceRoot, 'git', ['add', '-A']);
    await runFile(workspaceRoot, 'git', [
      'commit',
      '-m',
      `import ${analysis.name} at ${analysis.sourceSha.slice(0, 12)}`,
    ]);
    const integrationCommit = await runFile(workspaceRoot, 'git', [
      'rev-parse',
      'HEAD',
    ]);
    await rm(join(workspaceRoot, 'MEGAMONO-RECOVERY.md'), { force: true });
    return { graftCommit, integrationCommit, marker };
  } catch (error) {
    await writeFile(
      join(workspaceRoot, 'MEGAMONO-RECOVERY.md'),
      renderRepositoryImportRecovery(
        analysis,
        history,
        phase,
        graftCommit,
        failedCommand,
      ),
      'utf8',
    );
    if (error instanceof ImportExecutionError) throw error;
    throw new ImportExecutionError(phase, failedCommand, { cause: error });
  } finally {
    if (filteredRepository) {
      await rm(filteredRepository, { recursive: true, force: true });
    }
  }
}

/** @deprecated Use executeRepositoryImport, which supports every executable history strategy. */
export const executeSubtreeRepositoryImport = executeRepositoryImport;
