import {
  addProjectConfiguration,
  getProjects,
  updateJson,
  writeJson,
  type GeneratorCallback,
  type ProjectConfiguration,
  type TargetConfiguration,
  type Tree,
} from '@nx/devkit';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import type {
  ConvertAnalysis,
  ConvertPlanOperation,
  ConvertVerifyMode,
} from './convert';
import { CONVENTION_RULES } from './config';

interface PackageManifest extends Record<string, unknown> {
  name?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

export interface ConvertExecutionResult {
  readonly appPackageName: string;
  readonly installedPlugins: readonly (
    '@megamono/nx-apple' | '@megamono/nx-cargo'
  )[];
}

export interface ConvertVerificationCommand {
  readonly phase: 'dependencies' | 'docs' | 'config' | 'build' | 'test';
  readonly command: string;
  readonly args: readonly string[];
  readonly display: string;
}

export type ConvertCommandRunner = (
  command: ConvertVerificationCommand,
  workspaceRoot: string,
) => Promise<void>;

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

export function convertSubprocessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of NX_TASK_ENVIRONMENT_KEYS) delete environment[key];
  return environment;
}

export class ConvertVerificationError extends Error {
  constructor(
    readonly verification: ConvertVerificationCommand,
    options?: ErrorOptions,
  ) {
    super(`Conversion verification failed: ${verification.display}`, options);
  }
}

function readManifest(tree: Tree, path: string): PackageManifest {
  const source = tree.read(path, 'utf8');
  if (!source) throw new Error(`Package manifest is missing at ${path}.`);
  return JSON.parse(source) as PackageManifest;
}

function listFiles(tree: Tree, directory: string): string[] {
  if (tree.isFile(directory)) return [directory];
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

function movePath(tree: Tree, source: string, destination: string): void {
  const files = listFiles(tree, source);
  if (files.length === 0) {
    throw new Error(`Planned move source is missing: ${source}.`);
  }
  for (const path of files) {
    const suffix = path === source ? '' : path.slice(source.length + 1);
    const target = suffix ? `${destination}/${suffix}` : destination;
    if (tree.exists(target)) {
      throw new Error(`Planned move destination already exists: ${target}.`);
    }
    tree.rename(path, target);
  }
}

function workspacePatterns(manifest: PackageManifest): string[] {
  const value = manifest.workspaces;
  return Array.isArray(value) ? value : (value?.packages ?? []);
}

function setWorkspacePatterns(
  manifest: PackageManifest,
  patterns: readonly string[],
): void {
  const next = [...new Set(patterns)].sort();
  if (
    manifest.workspaces &&
    !Array.isArray(manifest.workspaces) &&
    typeof manifest.workspaces === 'object'
  ) {
    manifest.workspaces = { ...manifest.workspaces, packages: next };
  } else {
    manifest.workspaces = next;
  }
}

function pnpmWorkspacePatterns(tree: Tree): string[] {
  const source = tree.read('pnpm-workspace.yaml', 'utf8') ?? 'packages:\n';
  const lines = source.split(/\r?\n/);
  const packagesIndex = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (packagesIndex === -1) {
    throw new Error(
      'pnpm-workspace.yaml must contain a block-style packages list.',
    );
  }
  const patterns: string[] = [];
  for (const line of lines.slice(packagesIndex + 1)) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break;
    const match = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
    if (match) patterns.push(match[1].trim());
  }
  return patterns;
}

function setPnpmWorkspacePatterns(
  tree: Tree,
  patterns: readonly string[],
): void {
  const source = tree.read('pnpm-workspace.yaml', 'utf8') ?? 'packages:\n';
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const packagesIndex = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (packagesIndex === -1) {
    throw new Error(
      'pnpm-workspace.yaml must contain a block-style packages list.',
    );
  }
  let end = packagesIndex + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  const replacement = [...new Set(patterns)]
    .sort()
    .map((pattern) => `  - '${pattern}'`);
  lines.splice(packagesIndex + 1, end - packagesIndex - 1, ...replacement);
  tree.write('pnpm-workspace.yaml', lines.join(newline));
}

function targetConfiguration(command: string): TargetConfiguration {
  return {
    executor: 'nx:run-commands',
    cache: true,
    inputs: ['default', '^default'],
    options: { command },
  };
}

function projectTargets(
  analysis: ConvertAnalysis,
): NonNullable<ProjectConfiguration['targets']> {
  return Object.fromEntries(
    Object.entries(analysis.detection.commands).map(([name, command]) => [
      name,
      {
        ...targetConfiguration(command),
        cache: name !== 'deploy',
        options: { command, cwd: analysis.destination },
      },
    ]),
  );
}

function appPlatform(analysis: ConvertAnalysis): 'web' | 'node' {
  return ['next', 'vite', 'expo'].includes(analysis.detection.framework)
    ? 'web'
    : 'node';
}

function extractionOperations(
  analysis: ConvertAnalysis,
): ConvertPlanOperation[] {
  return analysis.operations.filter(({ kind }) => kind === 'extract');
}

function extractionAlias(
  operation: ConvertPlanOperation,
  scope: string,
): string {
  return `@${scope}/${basename(operation.destination ?? '')}`;
}

function rewriteExtractionImports(
  tree: Tree,
  analysis: ConvertAnalysis,
  scope: string,
): void {
  const extractions = extractionOperations(analysis);
  if (extractions.length === 0) return;
  const codeExtensions = /\.[cm]?[jt]sx?$/;
  const sourceRoot = analysis.source === '.' ? '' : analysis.source;
  for (const file of listFiles(tree, sourceRoot).filter((path) =>
    codeExtensions.test(path),
  )) {
    const source = tree.read(file, 'utf8');
    if (source === null) continue;
    const next = source.replace(
      /((?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*))(['"])(\.\.?\/[^'"]+)\2/g,
      (match, prefix: string, quote: string, specifier: string) => {
        const resolved = posix.normalize(posix.join(dirname(file), specifier));
        const extraction = extractions.find(
          ({ source: extractionSource }) =>
            extractionSource &&
            (resolved === extractionSource ||
              resolved.startsWith(`${extractionSource}/`)),
        );
        if (!extraction?.source) return match;
        const remainder = resolved
          .slice(extraction.source.length)
          .replace(/^\/src(?=\/|$)/, '')
          .replace(/^\//, '')
          .replace(/\.[cm]?[jt]sx?$/, '')
          .replace(/\/index$/, '');
        const alias = extractionAlias(extraction, scope);
        return `${prefix}${quote}${alias}${remainder ? `/${remainder}` : ''}${quote}`;
      },
    );
    if (next !== source) tree.write(file, next);
  }
}

function configureExtractionAliases(
  tree: Tree,
  analysis: ConvertAnalysis,
  scope: string,
): void {
  const extractions = extractionOperations(analysis);
  if (extractions.length === 0) return;
  if (!tree.exists('tsconfig.base.json')) {
    throw new Error('Explicit library extraction requires tsconfig.base.json.');
  }
  updateJson(tree, 'tsconfig.base.json', (value) => {
    const compilerOptions = value.compilerOptions ?? {};
    const paths = compilerOptions.paths ?? {};
    for (const operation of extractions) {
      if (!operation.destination) continue;
      const alias = extractionAlias(operation, scope);
      const sourceDirectory =
        tree.children(`${operation.destination}/src`).length > 0
          ? `${operation.destination}/src`
          : operation.destination;
      paths[alias] = [`./${sourceDirectory}/index.ts`];
      paths[`${alias}/*`] = [`./${sourceDirectory}/*`];
    }
    return { ...value, compilerOptions: { ...compilerOptions, paths } };
  });
}

function addExtractedProjects(
  tree: Tree,
  analysis: ConvertAnalysis,
  scope: string,
): void {
  const projects = getProjects(tree);
  for (const operation of extractionOperations(analysis)) {
    if (!operation.destination) continue;
    const name = basename(operation.destination);
    if (projects.has(name)) {
      throw new Error(
        `Extracted library project name already exists: ${name}.`,
      );
    }
    addProjectConfiguration(tree, name, {
      root: operation.destination,
      projectType: 'library',
      tags: [`scope:${scope}`, 'type:util'],
    });
    projects.set(name, { root: operation.destination });
  }
}

function configureInferencePlugins(
  tree: Tree,
  analysis: ConvertAnalysis,
): ConvertExecutionResult['installedPlugins'] {
  const installed = [
    ...new Set(
      analysis.detection.nonJsSurfaces.flatMap(({ plugin }) =>
        plugin ? [plugin] : [],
      ),
    ),
  ].sort();
  if (installed.length === 0) return installed;
  updateJson(tree, 'nx.json', (value) => {
    const plugins = Array.isArray(value.plugins) ? [...value.plugins] : [];
    for (const plugin of installed) {
      if (
        plugins.some(
          (entry: unknown) =>
            entry === plugin ||
            (typeof entry === 'object' &&
              entry !== null &&
              (entry as { plugin?: unknown }).plugin === plugin),
        )
      ) {
        continue;
      }
      plugins.push(plugin);
    }
    return { ...value, plugins };
  });
  return installed;
}

export function applyConversionPlan(
  tree: Tree,
  analysis: ConvertAnalysis,
  scope = 'shared',
): ConvertExecutionResult {
  if (!analysis.ready) {
    throw new Error('Conversion plan must be ready before execution.');
  }
  const manifestPath =
    analysis.source === '.'
      ? 'package.json'
      : `${analysis.source}/package.json`;
  const sourceManifest = readManifest(tree, manifestPath);
  const rootManifest = readManifest(tree, 'package.json');
  const appManifest: PackageManifest = { ...sourceManifest };
  delete appManifest.workspaces;
  delete appManifest.packageManager;
  delete appManifest.nx;
  appManifest.name = sourceManifest.name || analysis.appName;
  appManifest.private = sourceManifest.private ?? true;

  rewriteExtractionImports(tree, analysis, scope);
  for (const operation of analysis.operations) {
    if (
      (operation.kind === 'extract' || operation.kind === 'move') &&
      operation.source &&
      operation.destination
    ) {
      movePath(tree, operation.source, operation.destination);
    }
  }
  writeJson(tree, `${analysis.destination}/package.json`, appManifest);
  if (analysis.source === '.') {
    const rootScripts = sourceManifest.scripts ?? {};
    rootManifest.name = sourceManifest.name
      ? `${sourceManifest.name}-workspace`
      : `${analysis.appName}-workspace`;
    rootManifest.private = true;
    rootManifest.scripts = Object.fromEntries(
      Object.keys(rootScripts)
        .sort()
        .map((name) => [
          name,
          analysis.detection.commands[
            name as keyof typeof analysis.detection.commands
          ]
            ? `nx run ${analysis.appName}:${name}`
            : analysis.detection.packageManager === 'pnpm'
              ? `pnpm --dir ${analysis.destination} run ${name}`
              : `npm --prefix ${analysis.destination} run ${name}`,
        ]),
    );
  } else {
    tree.delete(manifestPath);
  }
  const extractionDestinations = extractionOperations(analysis).flatMap(
    ({ destination }) => (destination ? [destination] : []),
  );
  if (analysis.detection.packageManager === 'pnpm') {
    setPnpmWorkspacePatterns(tree, [
      ...pnpmWorkspacePatterns(tree),
      analysis.destination,
      ...extractionDestinations,
    ]);
  } else {
    setWorkspacePatterns(rootManifest, [
      ...workspacePatterns(rootManifest),
      analysis.destination,
      ...extractionDestinations,
    ]);
  }
  writeJson(tree, 'package.json', rootManifest);

  addProjectConfiguration(tree, analysis.appName, {
    root: analysis.destination,
    ...(tree.children(`${analysis.destination}/src`).length > 0
      ? { sourceRoot: `${analysis.destination}/src` }
      : {}),
    projectType: 'application',
    tags: [
      `platform:${appPlatform(analysis)}`,
      `scope:${scope}`,
      'type:app',
      'visibility:internal',
    ],
    targets: projectTargets(analysis),
  });
  addExtractedProjects(tree, analysis, scope);
  configureExtractionAliases(tree, analysis, scope);
  const configuredPlugins = configureInferencePlugins(tree, analysis);
  const rootDependencies = new Set([
    ...Object.keys(rootManifest.dependencies ?? {}),
    ...Object.keys(rootManifest.devDependencies ?? {}),
  ]);
  const installedPlugins = configuredPlugins.filter(
    (plugin) => !rootDependencies.has(plugin),
  );
  return { appPackageName: appManifest.name, installedPlugins };
}

export function setConvertWarningMode(
  tree: Tree,
  analysis?: ConvertAnalysis,
): void {
  updateJson(tree, 'megamono.json', (value) => {
    const conventions = value.conventions ?? {};
    const existingRules = conventions.rules ?? {};
    const rules = Object.fromEntries(
      CONVENTION_RULES.map((name) => [
        name,
        { ...existingRules[name], severity: 'warning' },
      ]),
    );
    return {
      ...value,
      conventions: { ...conventions, rules },
      ...(analysis
        ? {
            platforms: [
              ...new Set([
                ...(Array.isArray(value.platforms) ? value.platforms : []),
                appPlatform(analysis),
                ...analysis.detection.nonJsSurfaces.flatMap(({ ecosystem }) =>
                  ecosystem === 'apple'
                    ? ['apple']
                    : ecosystem === 'cargo'
                      ? ['rust']
                      : [],
                ),
              ]),
            ].sort(),
          }
        : {}),
    };
  });
}

export function conversionVerificationCommands(
  analysis: ConvertAnalysis,
): readonly ConvertVerificationCommand[] {
  if (analysis.verify === 'none') return [];
  const packageManager = analysis.detection.packageManager;
  const nxArgs = (args: readonly string[]) => ['exec', 'nx', ...args];
  const nxDisplay = (args: readonly string[]) =>
    `${packageManager} exec nx ${args.join(' ')}`;
  const commands: ConvertVerificationCommand[] = [
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
      args: nxArgs(['show', 'project', analysis.appName, '--json']),
      display: nxDisplay(['show', 'project', analysis.appName, '--json']),
    },
    {
      phase: 'config',
      command: packageManager,
      args: nxArgs(['run', 'megamono-docs:health']),
      display: nxDisplay(['run', 'megamono-docs:health']),
    },
  ];
  if (analysis.verify === 'build') {
    if (analysis.detection.commands.build) {
      commands.push({
        phase: 'build',
        command: packageManager,
        args: nxArgs(['run', `${analysis.appName}:build`]),
        display: nxDisplay(['run', `${analysis.appName}:build`]),
      });
    }
    if (analysis.detection.commands.test) {
      commands.push({
        phase: 'test',
        command: packageManager,
        args: nxArgs(['run', `${analysis.appName}:test`]),
        display: nxDisplay(['run', `${analysis.appName}:test`]),
      });
    }
  }
  return commands;
}

export const runConvertCommand: ConvertCommandRunner = (
  command,
  workspaceRoot,
) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, [...command.args], {
      cwd: workspaceRoot,
      env: convertSubprocessEnvironment(),
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command.display} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`,
          ),
        );
      }
    });
  });

export async function runConversionVerification(
  workspaceRoot: string,
  analysis: ConvertAnalysis,
  runner: ConvertCommandRunner = runConvertCommand,
): Promise<void> {
  for (const command of conversionVerificationCommands(analysis)) {
    try {
      await runner(command, workspaceRoot);
    } catch (error) {
      throw new ConvertVerificationError(command, { cause: error });
    }
  }
}

export function renderConversionRecovery(
  analysis: ConvertAnalysis,
  verification: ConvertVerificationCommand,
): string {
  return `# Megamono conversion recovery

Conversion of \`${analysis.appName}\` stopped during the \`${verification.phase}\` phase.

- Rollback base: \`${analysis.git.baseSha ?? 'unavailable'}\`
- Failed command: \`${verification.display}\`
- Retry command: \`${verification.display}\`

Inspect the working tree before retrying. To abandon the conversion, return to the recorded base and discard this unmerged conversion branch. Megamono did not commit, revert, or change branches.
`;
}

function recoveryCommand(
  phase: 'dependencies' | 'docs',
  packageManager: ConvertAnalysis['detection']['packageManager'],
): ConvertVerificationCommand {
  return phase === 'dependencies'
    ? {
        phase,
        command: packageManager,
        args: ['install'],
        display: `${packageManager} install`,
      }
    : {
        phase,
        command: packageManager,
        args: ['exec', 'nx', 'run', 'megamono-docs:index'],
        display: `${packageManager} exec nx run megamono-docs:index`,
      };
}

async function runCallback(
  callback: GeneratorCallback | undefined,
): Promise<void> {
  if (callback) await callback();
}

export function createConvertPostFlushCallback(
  workspaceRoot: string,
  analysis: ConvertAnalysis,
  dependencyCallbacks: readonly (GeneratorCallback | undefined)[],
  docsCallback: GeneratorCallback | undefined,
  runner: ConvertCommandRunner = runConvertCommand,
): GeneratorCallback {
  return async () => {
    let failedCommand = recoveryCommand(
      'dependencies',
      analysis.detection.packageManager,
    );
    try {
      for (const callback of dependencyCallbacks) {
        await runCallback(callback);
      }
      failedCommand = recoveryCommand(
        'docs',
        analysis.detection.packageManager,
      );
      await runCallback(docsCallback);
      await runConversionVerification(workspaceRoot, analysis, runner);
    } catch (error) {
      if (error instanceof ConvertVerificationError) {
        failedCommand = error.verification;
      }
      await writeFile(
        join(workspaceRoot, 'MEGAMONO-RECOVERY.md'),
        renderConversionRecovery(analysis, failedCommand),
        'utf8',
      );
      throw error;
    }
  };
}

export function convertDefaultPlatform(
  analysis: ConvertAnalysis,
): 'web' | 'node' {
  return appPlatform(analysis);
}

export function normalizedConvertScope(value: string | undefined): string {
  const scope = value?.trim() || 'shared';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scope)) {
    throw new Error('scope must be a lowercase hyphenated tag value.');
  }
  return scope;
}

export function reportDirectory(path: string): string {
  return dirname(path);
}

export function convertMarkerPath(appName: string): string {
  return `.megamono/conversions/${appName}.json`;
}

export function writeConvertMarker(
  tree: Tree,
  analysis: ConvertAnalysis,
  report: string,
): void {
  writeJson(tree, convertMarkerPath(analysis.appName), {
    schemaVersion: 1,
    appName: analysis.appName,
    source: analysis.source,
    destination: analysis.destination,
    baseSha: analysis.git.baseSha,
    report,
  });
}

export function readConvertMarker(
  tree: Tree,
  appName: string,
):
  | {
      readonly schemaVersion: 1;
      readonly appName: string;
      readonly source: string;
      readonly destination: string;
      readonly baseSha?: string;
      readonly report: string;
    }
  | undefined {
  const path = convertMarkerPath(appName);
  if (!tree.exists(path)) return undefined;
  const value = JSON.parse(tree.read(path, 'utf8') ?? '') as Record<
    string,
    unknown
  >;
  if (
    value.schemaVersion !== 1 ||
    value.appName !== appName ||
    typeof value.source !== 'string' ||
    typeof value.destination !== 'string' ||
    typeof value.report !== 'string' ||
    (value.baseSha !== undefined && typeof value.baseSha !== 'string')
  ) {
    throw new Error(`Invalid conversion marker at ${path}.`);
  }
  return value as ReturnType<typeof readConvertMarker>;
}

export function hasCompletedConversion(
  tree: Tree,
  appName: string,
  source: string,
  destination: string,
): ReturnType<typeof readConvertMarker> {
  const marker = readConvertMarker(tree, appName);
  if (!marker) return undefined;
  if (marker.source !== source || marker.destination !== destination) {
    throw new Error(
      `Conversion ${appName} already uses source=${marker.source} and destination=${marker.destination}.`,
    );
  }
  if (
    !tree.exists(`${destination}/package.json`) ||
    !tree.exists(`${destination}/project.json`)
  ) {
    throw new Error(
      `Conversion marker for ${appName} exists but ${destination} is incomplete.`,
    );
  }
  return marker;
}

export function convertVerifyMode(value: unknown): ConvertVerifyMode {
  if (value === undefined) return 'config';
  if (value === 'none' || value === 'config' || value === 'build') return value;
  throw new Error('verify must be none, config, or build.');
}
