import type { Tree } from '@nx/devkit';
import { execFile } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  isPackageManager,
  lockfileManagers as detectLockfileManagers,
  type PackageManager,
} from './package-manager';

export type ConvertFramework = 'next' | 'nest' | 'expo' | 'vite' | 'node';
export type ConvertPackageManager = PackageManager;
export type ConvertRepositoryShape =
  'single-package' | 'pnpm-workspaces' | 'package-json-workspaces';
export type ConvertVerifyMode = 'none' | 'config' | 'build';
export type ConvertPlanPhase =
  'restructure' | 'targets' | 'conventions' | 'docs';

export interface ConvertAnalysisOptions {
  readonly appName: string;
  readonly source?: string;
  readonly destination?: string;
  readonly interactive?: boolean;
  readonly acceptPlan?: boolean;
  readonly verify?: ConvertVerifyMode;
  readonly extract?: readonly string[];
  readonly resolutions?: Readonly<
    Record<string, 'application' | 'infrastructure'>
  >;
}

export interface ConvertGitState {
  readonly available: boolean;
  readonly clean: boolean;
  readonly branch?: string;
  readonly defaultBranch?: string;
  readonly baseSha?: string;
}

export interface ConvertDetection {
  readonly packageManager: ConvertPackageManager;
  readonly shape: ConvertRepositoryShape;
  readonly framework: ConvertFramework;
  readonly testRunner?: 'vitest' | 'jest' | 'node-test';
  readonly workspacePatterns: readonly string[];
  readonly commands: Readonly<
    Partial<Record<'build' | 'test' | 'lint' | 'deploy', string>>
  >;
  readonly nonJsSurfaces: readonly {
    readonly ecosystem: 'apple' | 'cargo' | 'php';
    readonly manifest: string;
    readonly plugin?: '@megamono/nx-apple' | '@megamono/nx-cargo';
  }[];
}

export interface ConvertPlanOperation {
  readonly phase: ConvertPlanPhase;
  readonly kind:
    | 'move'
    | 'split-manifest'
    | 'wrap-target'
    | 'install-plugin'
    | 'initialize-conventions'
    | 'seed-decision'
    | 'extract';
  readonly source?: string;
  readonly destination?: string;
  readonly target?: string;
  readonly command?: string;
  readonly detail: string;
}

export interface ConvertIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface ConvertAnalysis {
  readonly schemaVersion: 1;
  readonly appName: string;
  readonly source: string;
  readonly destination: string;
  readonly verify: ConvertVerifyMode;
  readonly git: ConvertGitState;
  readonly detection: ConvertDetection;
  readonly operations: readonly ConvertPlanOperation[];
  readonly blockers: readonly ConvertIssue[];
  readonly unresolved: readonly ConvertIssue[];
  readonly ready: boolean;
}

export class ConvertOptionsError extends Error {
  readonly exitCode = 2;
}

export class ConvertPreflightError extends Error {
  readonly exitCode = 3;
}

export class ConvertDecisionError extends Error {
  readonly exitCode = 4;
}

interface PackageManifest {
  readonly name?: string;
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly workspaces?:
    readonly string[] | { readonly packages?: readonly string[] };
}

const executeFile = promisify(execFile);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const phaseOrder: Readonly<Record<ConvertPlanPhase, number>> = {
  restructure: 0,
  targets: 1,
  conventions: 2,
  docs: 3,
};

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function normalizeWorkspacePath(value: string, label: string): string {
  const normalized = normalizePath(value === '.' ? '' : value).replace(
    /^\.\//,
    '',
  );
  if (
    isAbsolute(value) ||
    value.includes('\\') ||
    normalized.split('/').includes('..')
  ) {
    throw new ConvertOptionsError(
      `${label} must be a safe workspace-relative path.`,
    );
  }
  return normalized;
}

function joinWorkspace(...parts: readonly string[]): string {
  return parts.filter(Boolean).join('/');
}

function listTreeFiles(tree: Tree, directory = ''): string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const child of tree.children(current).sort()) {
      const path = current ? `${current}/${child}` : child;
      if (tree.isFile(path)) files.push(path);
      else visit(path);
    }
  };
  visit(directory);
  return files;
}

function readJson<T>(tree: Tree, path: string, label: string): T {
  const source = tree.read(path, 'utf8');
  if (!source)
    throw new ConvertPreflightError(`${label} is missing at ${path}.`);
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new ConvertPreflightError(
      `${label} at ${path} is invalid JSON: ${(error as Error).message}`,
    );
  }
}

function workspacePatterns(manifest: PackageManifest): string[] {
  const value = manifest.workspaces;
  const patterns = Array.isArray(value)
    ? value
    : ((value as { readonly packages?: readonly string[] } | undefined)
        ?.packages ?? []);
  return [...new Set(patterns)].sort();
}

function pnpmWorkspacePatterns(tree: Tree): string[] {
  const source = tree.read('pnpm-workspace.yaml', 'utf8');
  if (!source) return [];
  const lines = source.split(/\r?\n/);
  const packagesIndex = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (packagesIndex === -1) return [];
  const patterns: string[] = [];
  for (const line of lines.slice(packagesIndex + 1)) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break;
    const match = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
    if (match) patterns.push(match[1].trim());
  }
  return [...new Set(patterns)].sort();
}

function dependencyNames(manifest: PackageManifest): Set<string> {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
}

function detectFramework(
  files: ReadonlySet<string>,
  dependencies: ReadonlySet<string>,
  unresolved: ConvertIssue[],
): ConvertFramework {
  const primary = [
    dependencies.has('next') ||
    [...files].some((path) => /(^|\/)next\.config\./.test(path))
      ? 'next'
      : undefined,
    dependencies.has('@nestjs/core') || files.has('nest-cli.json')
      ? 'nest'
      : undefined,
    dependencies.has('expo') || files.has('app.json') ? 'expo' : undefined,
  ].filter((value): value is 'next' | 'nest' | 'expo' => Boolean(value));
  if (primary.length > 1) {
    unresolved.push({
      code: 'convert-framework-ambiguous',
      message: `Multiple application frameworks were detected: ${primary.join(', ')}.`,
    });
  }
  if (primary[0]) return primary[0];
  if (
    dependencies.has('vite') ||
    [...files].some((path) => /(^|\/)vite\.config\./.test(path))
  ) {
    return 'vite';
  }
  return 'node';
}

function detectTestRunner(
  manifest: PackageManifest,
  dependencies: ReadonlySet<string>,
  unresolved: ConvertIssue[],
): ConvertDetection['testRunner'] {
  const runners = [
    dependencies.has('vitest') ? ('vitest' as const) : undefined,
    dependencies.has('jest') ? ('jest' as const) : undefined,
    /(^|\s)node\s+--test(\s|$)/.test(manifest.scripts?.test ?? '')
      ? ('node-test' as const)
      : undefined,
  ].filter((value): value is NonNullable<typeof value> => Boolean(value));
  if (runners.length > 1) {
    unresolved.push({
      code: 'convert-test-runner-ambiguous',
      message: `Multiple test runners were detected: ${runners.join(', ')}.`,
    });
  }
  return runners[0];
}

function globRoot(pattern: string): string {
  return pattern.split('/')[0];
}

function rootEntry(path: string, source: string): string {
  const relativePath = source ? path.slice(source.length + 1) : path;
  return relativePath.split('/')[0];
}

function isRepositoryInfrastructure(
  path: string,
  source: string,
  workspaces: readonly string[],
  tree: Tree,
): boolean {
  if (source) return false;
  const entry = rootEntry(path, source);
  const infrastructureDirectories = new Set([
    '.agents',
    '.claude',
    '.codex',
    '.content-collections',
    '.cursor',
    '.gemini',
    '.git',
    '.github',
    '.megamono',
    '.nx',
    '.opencode',
    '.verdaccio',
    '.vscode',
    'apps',
    'docs',
    'libs',
    'node_modules',
    'packages',
    'tools',
  ]);
  if (infrastructureDirectories.has(entry)) return true;
  if (workspaces.some((pattern) => globRoot(pattern) === entry)) return true;
  if (
    /^(?:\.DS_Store|AGENTS\.md|CLAUDE\.md|README(?:\.[^.]+)?|LICENSE(?:\.[^.]+)?|package(?:-lock)?\.json|pnpm-(?:lock|workspace)\.yaml|nx\.json|project\.json|megamono\.json|opencode\.json|content-collections\.ts|tsconfig\.base\.json|eslint\.config\.[cm]?[jt]s|\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.prettierignore|\.prettierrc(?:\..+)?)$/.test(
      entry,
    )
  ) {
    return true;
  }
  if (entry === 'tsconfig.json') {
    try {
      const config = JSON.parse(tree.read(path, 'utf8') ?? '') as {
        readonly references?: unknown;
      };
      return Array.isArray(config.references);
    } catch {
      return false;
    }
  }
  return false;
}

function isAppOwned(path: string, source: string): boolean {
  const entry = rootEntry(path, source);
  if (
    new Set([
      '__tests__',
      'app',
      'e2e',
      'pages',
      'prisma',
      'public',
      'src',
      'test',
      'tests',
    ]).has(entry)
  ) {
    return true;
  }
  return /^(?:Dockerfile|app\.json|babel\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|metro\.config\.[cm]?[jt]s|nest-cli\.json|next\.config\.[cm]?[jt]s|playwright\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|tsconfig\.json|vite\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s)$/.test(
    entry,
  );
}

function detectNonJsSurfaces(
  files: readonly string[],
): ConvertDetection['nonJsSurfaces'] {
  const surfaces: ConvertDetection['nonJsSurfaces'][number][] = [];
  for (const path of files) {
    if (path.endsWith('Package.swift')) {
      surfaces.push({
        ecosystem: 'apple',
        manifest: path,
        plugin: '@megamono/nx-apple',
      });
    } else if (path.endsWith('Cargo.toml')) {
      surfaces.push({
        ecosystem: 'cargo',
        manifest: path,
        plugin: '@megamono/nx-cargo',
      });
    } else if (path.endsWith('composer.json')) {
      surfaces.push({ ecosystem: 'php', manifest: path });
    }
  }
  return surfaces.sort(
    (left, right) =>
      left.ecosystem.localeCompare(right.ecosystem) ||
      left.manifest.localeCompare(right.manifest),
  );
}

function isNonJsOwned(
  path: string,
  surfaces: ConvertDetection['nonJsSurfaces'],
): boolean {
  return surfaces.some((surface) => {
    const segments = surface.manifest.split('/');
    if (segments.length > 1) {
      const directory = segments.slice(0, -1).join('/');
      return path === surface.manifest || path.startsWith(`${directory}/`);
    }
    if (path === surface.manifest) return true;
    if (surface.ecosystem === 'apple') {
      return /^(?:Package\.resolved|Sources|Tests|\.swiftpm)(?:\/|$)/.test(
        path,
      );
    }
    if (surface.ecosystem === 'cargo') {
      return /^(?:Cargo\.lock|crates|src|tests)(?:\/|$)/.test(path);
    }
    return /^(?:composer\.lock|vendor)(?:\/|$)/.test(path);
  });
}

function parseExtractions(
  values: readonly string[],
  source: string,
  unresolved: ConvertIssue[],
): ConvertPlanOperation[] {
  const operations: ConvertPlanOperation[] = [];
  for (const value of values) {
    const separator = value.indexOf(':');
    if (separator < 1 || separator === value.length - 1) {
      throw new ConvertOptionsError(
        `Invalid extraction ${value}; expected <source>:<destination>.`,
      );
    }
    const from = normalizeWorkspacePath(
      value.slice(0, separator),
      'extract source',
    );
    const to = normalizeWorkspacePath(
      value.slice(separator + 1),
      'extract destination',
    );
    if (source && !from.startsWith(`${source}/`)) {
      unresolved.push({
        code: 'convert-extraction-source',
        message: `Extraction source ${from} is outside ${source}.`,
        path: from,
      });
      continue;
    }
    operations.push({
      phase: 'restructure',
      kind: 'extract',
      source: from,
      destination: to,
      detail: `Extract ${from} to ${to} after explicit approval.`,
    });
  }
  return operations;
}

function parseResolutions(
  values: ConvertAnalysisOptions['resolutions'],
): Map<string, 'application' | 'infrastructure'> {
  const resolutions = new Map<string, 'application' | 'infrastructure'>();
  for (const [rawPath, owner] of Object.entries(values ?? {})) {
    const path = normalizeWorkspacePath(rawPath, 'resolution path');
    if (!path) {
      throw new ConvertOptionsError('resolution path must not be empty.');
    }
    if (owner !== 'application' && owner !== 'infrastructure') {
      throw new ConvertOptionsError(
        `Resolution for ${path} must be application or infrastructure.`,
      );
    }
    resolutions.set(path, owner);
  }
  return resolutions;
}

function operationSort(
  left: ConvertPlanOperation,
  right: ConvertPlanOperation,
): number {
  return (
    phaseOrder[left.phase] - phaseOrder[right.phase] ||
    left.kind.localeCompare(right.kind) ||
    (left.source ?? '').localeCompare(right.source ?? '') ||
    (left.destination ?? '').localeCompare(right.destination ?? '') ||
    (left.target ?? '').localeCompare(right.target ?? '')
  );
}

export function analyzeConversion(
  tree: Tree,
  rawOptions: ConvertAnalysisOptions,
  git: ConvertGitState,
): ConvertAnalysis {
  if (!slugPattern.test(rawOptions.appName)) {
    throw new ConvertOptionsError(
      'appName must be a lowercase hyphenated project name.',
    );
  }
  const source = normalizeWorkspacePath(rawOptions.source ?? '.', 'source');
  const destination = normalizeWorkspacePath(
    rawOptions.destination ?? `apps/${rawOptions.appName}`,
    'destination',
  );
  if (!destination) throw new ConvertOptionsError('destination is required.');
  if (source && destination.startsWith(`${source}/`)) {
    throw new ConvertOptionsError(
      'destination must not be nested inside a non-root source directory.',
    );
  }
  const verify = rawOptions.verify ?? 'config';
  if (!(['none', 'config', 'build'] as readonly string[]).includes(verify)) {
    throw new ConvertOptionsError(
      'verify must be one of none, config, or build.',
    );
  }
  const manifestPath = joinWorkspace(source, 'package.json');
  const manifest = readJson<PackageManifest>(
    tree,
    manifestPath,
    'Source package manifest',
  );
  const allFiles = listTreeFiles(tree);
  const sourceFiles = allFiles.filter(
    (path) => !source || path === source || path.startsWith(`${source}/`),
  );
  const relativeFiles = new Set(
    sourceFiles.map((path) => (source ? path.slice(source.length + 1) : path)),
  );
  const blockers: ConvertIssue[] = [];
  const unresolved: ConvertIssue[] = [];

  if (!tree.exists('nx.json')) {
    blockers.push({
      code: 'convert-nx-required',
      message: 'nx.json is missing; commit nx init before conversion.',
      path: 'nx.json',
    });
  }
  if (!git.available) {
    blockers.push({
      code: 'convert-git-required',
      message: 'Conversion requires a Git worktree.',
    });
  } else {
    if (!git.clean) {
      blockers.push({
        code: 'convert-dirty-tree',
        message: 'Conversion requires a clean working tree.',
      });
    }
    if (!git.branch) {
      blockers.push({
        code: 'convert-detached-head',
        message: 'Conversion requires a named branch.',
      });
    }
    if (!git.defaultBranch || !git.baseSha) {
      blockers.push({
        code: 'convert-default-branch',
        message: 'An upstream default branch and rollback base are required.',
      });
    } else if (git.branch === git.defaultBranch) {
      blockers.push({
        code: 'convert-default-branch',
        message: `Conversion must not run on the default branch ${git.defaultBranch}.`,
      });
    }
  }

  const unsupportedMarkers = [
    ['turbo.json', 'Turborepo'],
    ['lerna.json', 'Lerna'],
    ['rush.json', 'Rush'],
  ] as const;
  for (const [path, tool] of unsupportedMarkers) {
    if (tree.exists(path)) {
      blockers.push({
        code: 'convert-unsupported-orchestrator',
        message: `${tool} repositories are analysis-only in v1.`,
        path,
      });
    }
  }
  const declaredPackageManager = manifest.packageManager?.split('@')[0];
  if (declaredPackageManager && !isPackageManager(declaredPackageManager)) {
    blockers.push({
      code: 'convert-unsupported-package-manager',
      message: `Conversion supports npm, pnpm, Yarn, and Bun, not ${manifest.packageManager}.`,
      path: manifestPath,
    });
  }
  const detectedManagers = detectLockfileManagers((path) => tree.exists(path));
  if (detectedManagers.length > 1) {
    blockers.push({
      code: 'convert-package-lock',
      message: `Conversion refuses conflicting root package-manager lockfiles: ${detectedManagers.join(', ')}.`,
    });
  }
  const packageManager: ConvertPackageManager =
    detectedManagers[0] ??
    (declaredPackageManager && isPackageManager(declaredPackageManager)
      ? declaredPackageManager
      : 'npm');
  if (
    declaredPackageManager &&
    isPackageManager(declaredPackageManager) &&
    detectedManagers.length === 1 &&
    declaredPackageManager !== packageManager
  ) {
    blockers.push({
      code: 'convert-package-manager-mismatch',
      message: `package.json declares ${manifest.packageManager}, but the repository has the ${packageManager} lockfile.`,
      path: manifestPath,
    });
  }
  if (
    allFiles.some(
      (path) => path === destination || path.startsWith(`${destination}/`),
    )
  ) {
    blockers.push({
      code: 'convert-destination-conflict',
      message: `Destination ${destination} is not empty.`,
      path: destination,
    });
  }

  const patterns =
    packageManager === 'pnpm'
      ? pnpmWorkspacePatterns(tree)
      : workspacePatterns(manifest);
  const dependencies = dependencyNames(manifest);
  const framework = detectFramework(relativeFiles, dependencies, unresolved);
  const testRunner = detectTestRunner(manifest, dependencies, unresolved);
  const commands = Object.fromEntries(
    (['build', 'test', 'lint', 'deploy'] as const).flatMap((name) => {
      const script = manifest.scripts?.[name];
      return script ? [[name, `${packageManager} run ${name}`]] : [];
    }),
  ) as ConvertDetection['commands'];
  const nonJsSurfaces = detectNonJsSurfaces(sourceFiles);
  for (const surface of nonJsSurfaces) {
    if (!surface.plugin) {
      blockers.push({
        code: 'convert-plugin-unavailable',
        message: `No published Megamono inference plugin is available for ${surface.ecosystem}.`,
        path: surface.manifest,
      });
    }
  }

  const moveEntries = new Map<string, string>();
  const unclassified = new Set<string>();
  const resolutions = parseResolutions(rawOptions.resolutions);
  const usedResolutions = new Set<string>();
  for (const path of sourceFiles) {
    const relativePath = source ? path.slice(source.length + 1) : path;
    if (!relativePath || relativePath === 'package.json') continue;
    if (isRepositoryInfrastructure(path, source, patterns, tree)) continue;
    const entry = relativePath.split('/')[0];
    const workspaceEntry = joinWorkspace(source, entry);
    if (isAppOwned(path, source)) {
      moveEntries.set(workspaceEntry, joinWorkspace(destination, entry));
      continue;
    }
    if (isNonJsOwned(path, nonJsSurfaces)) {
      continue;
    }
    const resolution = resolutions.get(workspaceEntry);
    if (resolution) usedResolutions.add(workspaceEntry);
    if (resolution === 'infrastructure') continue;
    if (resolution === 'application') {
      moveEntries.set(workspaceEntry, joinWorkspace(destination, entry));
      continue;
    }
    unclassified.add(workspaceEntry);
  }
  for (const path of [...unclassified].sort()) {
    unresolved.push({
      code: 'convert-unclassified-path',
      message: `Classify ${path} as repository infrastructure or application-owned before conversion.`,
      path,
    });
  }
  for (const path of [...resolutions.keys()]
    .filter((candidate) => !usedResolutions.has(candidate))
    .sort()) {
    unresolved.push({
      code: 'convert-unused-resolution',
      message: `Resolution for ${path} does not match an ambiguous source-root entry.`,
      path,
    });
  }

  const operations: ConvertPlanOperation[] = [
    ...[...moveEntries]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([from, to]) =>
          ({
            phase: 'restructure',
            kind: 'move',
            source: from,
            destination: to,
            detail: `Move ${from} to ${to} through the Nx virtual tree.`,
          }) satisfies ConvertPlanOperation,
      ),
    {
      phase: 'restructure',
      kind: 'split-manifest',
      source: manifestPath,
      destination: joinWorkspace(destination, 'package.json'),
      detail:
        source === ''
          ? `Split application scripts and dependencies from the root manifest into ${destination}.`
          : `Move the source package manifest into ${destination}.`,
    } satisfies ConvertPlanOperation,
    ...Object.entries(commands).map(
      ([target, command]) =>
        ({
          phase: 'targets',
          kind: 'wrap-target',
          target,
          command,
          detail: `Preserve the existing ${target} behavior as ${command}.`,
        }) satisfies ConvertPlanOperation,
    ),
    ...nonJsSurfaces.flatMap((surface) =>
      surface.plugin && !dependencies.has(surface.plugin)
        ? [
            {
              phase: 'conventions',
              kind: 'install-plugin',
              detail: `Install ${surface.plugin} for ${surface.manifest}.`,
            } satisfies ConvertPlanOperation,
          ]
        : [],
    ),
    {
      phase: 'conventions',
      kind: 'initialize-conventions',
      detail:
        'Initialize Megamono conventions with boundary lint rules in warning mode.',
    } satisfies ConvertPlanOperation,
    {
      phase: 'docs',
      kind: 'seed-decision',
      detail: `Record the conversion of ${rawOptions.appName} as the first repository decision.`,
    } satisfies ConvertPlanOperation,
    ...parseExtractions(rawOptions.extract ?? [], source, unresolved),
  ].sort(operationSort);

  if (!rawOptions.acceptPlan) {
    unresolved.push({
      code: 'convert-plan-acceptance',
      message:
        rawOptions.interactive === false
          ? 'Non-interactive conversion requires acceptPlan=true.'
          : 'Conversion requires explicit plan acceptance before mutation.',
    });
  }
  const sortedBlockers = blockers.sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      (left.path ?? '').localeCompare(right.path ?? ''),
  );
  const sortedUnresolved = unresolved.sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      (left.path ?? '').localeCompare(right.path ?? ''),
  );
  return {
    schemaVersion: 1,
    appName: rawOptions.appName,
    source: source || '.',
    destination,
    verify,
    git,
    detection: {
      packageManager,
      shape:
        patterns.length > 0
          ? packageManager === 'pnpm'
            ? 'pnpm-workspaces'
            : 'package-json-workspaces'
          : 'single-package',
      framework,
      ...(testRunner ? { testRunner } : {}),
      workspacePatterns: patterns,
      commands,
      nonJsSurfaces,
    },
    operations,
    blockers: sortedBlockers,
    unresolved: sortedUnresolved,
    ready: sortedBlockers.length === 0 && sortedUnresolved.length === 0,
  };
}

async function gitOutput(
  workspaceRoot: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const result = await executeFile('git', [...args], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

export async function collectConvertGitState(
  workspaceRoot: string,
): Promise<ConvertGitState> {
  const inside = await gitOutput(workspaceRoot, [
    'rev-parse',
    '--is-inside-work-tree',
  ]);
  if (inside !== 'true') return { available: false, clean: false };
  const status = await gitOutput(workspaceRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  const branch = await gitOutput(workspaceRoot, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const remoteDefault = await gitOutput(workspaceRoot, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  const defaultBranch = remoteDefault?.replace(/^origin\//, '');
  const baseSha = remoteDefault
    ? await gitOutput(workspaceRoot, ['rev-parse', remoteDefault])
    : undefined;
  return {
    available: true,
    clean: status === '',
    ...(branch ? { branch } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(baseSha ? { baseSha } : {}),
  };
}

function issueLines(issues: readonly ConvertIssue[]): string[] {
  return issues.length === 0
    ? ['- None']
    : issues.map(
        ({ code, message, path }) =>
          `- \`${code}\`${path ? ` (${path})` : ''}: ${message}`,
      );
}

export function renderConvertReport(analysis: ConvertAnalysis): string {
  const operationLines = analysis.operations.map(
    (operation, index) =>
      `${index + 1}. **${operation.phase} / ${operation.kind}** — ${operation.detail}`,
  );
  const commands = Object.entries(analysis.detection.commands);
  return `${[
    '# Megamono conversion analysis',
    '',
    `- Source: \`${analysis.source}\``,
    `- Destination: \`${analysis.destination}\``,
    `- Application: \`${analysis.appName}\``,
    `- Repository shape: \`${analysis.detection.shape}\``,
    `- Framework: \`${analysis.detection.framework}\``,
    `- Test runner: \`${analysis.detection.testRunner ?? 'not detected'}\``,
    `- Git branch: \`${analysis.git.branch ?? 'unavailable'}\``,
    `- Rollback base: \`${analysis.git.baseSha ?? 'unavailable'}\``,
    `- Verification: \`${analysis.verify}\``,
    `- Ready: \`${analysis.ready}\``,
    '',
    '## Existing commands',
    '',
    ...(commands.length === 0
      ? ['- None detected']
      : commands.map(([target, command]) => `- \`${target}\`: \`${command}\``)),
    '',
    '## Non-JS surfaces',
    '',
    ...(analysis.detection.nonJsSurfaces.length === 0
      ? ['- None detected']
      : analysis.detection.nonJsSurfaces.map(
          ({ ecosystem, manifest, plugin }) =>
            `- \`${ecosystem}\`: ${manifest}${plugin ? ` via \`${plugin}\`` : ' — no published plugin'}`,
        )),
    '',
    '## Preflight blockers',
    '',
    ...issueLines(analysis.blockers),
    '',
    '## Unresolved decisions',
    '',
    ...issueLines(analysis.unresolved),
    '',
    '## Ordered plan',
    '',
    ...(operationLines.length === 0 ? ['- No operations'] : operationLines),
    '',
  ].join('\n')}\n`;
}

export function renderPersistedConvertReport(
  analysis: ConvertAnalysis,
  generatedAt = new Date(),
): string {
  const generatedAtIso = generatedAt.toISOString();
  const isoDate = generatedAtIso.slice(0, 10);
  const compactDate = isoDate.replaceAll('-', '');
  const compactTimestamp = generatedAtIso
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${[
    '---',
    `id: ${JSON.stringify(`report-convert-${analysis.appName}-${compactTimestamp}`)}`,
    'type: "report"',
    'status: "generated"',
    'visibility: "internal"',
    `projects: ${JSON.stringify([analysis.appName])}`,
    'topics: ["convert", "migration"]',
    `summary: ${JSON.stringify(`Records the accepted conversion plan for ${analysis.appName}.`)}`,
    `date: ${JSON.stringify(isoDate)}`,
    'supersedes: null',
    `references: ${JSON.stringify([
      `decision-${compactDate}-adopt-megamono-repository-structure`,
    ])}`,
    'external_references: []',
    'producer: "@megamono/plugin:convert"',
    `generated_at: ${JSON.stringify(generatedAtIso)}`,
    '---',
    '',
    renderConvertReport(analysis).trimEnd(),
    '',
  ].join('\n')}\n`;
}

export function assertConversionReady(analysis: ConvertAnalysis): void {
  if (analysis.blockers.length > 0) {
    throw new ConvertPreflightError(renderConvertReport(analysis));
  }
  if (analysis.unresolved.length > 0) {
    throw new ConvertDecisionError(renderConvertReport(analysis));
  }
}

export function workspaceRelativeReportPath(
  workspaceRoot: string,
  reportPath: string,
): string {
  const absolute = resolve(workspaceRoot, reportPath);
  const relativePath = normalizePath(relative(workspaceRoot, absolute));
  if (relativePath.startsWith('../') || relativePath === '..') {
    throw new ConvertOptionsError('report must stay inside the workspace.');
  }
  return relativePath;
}
