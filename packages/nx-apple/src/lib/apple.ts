import {
  DependencyType,
  normalizePath,
  validateDependency,
  type CreateDependencies,
  type CreateNodes,
  type ProjectConfiguration,
  type RawProjectGraphDependency,
} from '@nx/devkit';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ApplePluginOptions {
  scheme?: string;
  configuration?: string;
  destination?: string;
  derivedDataPath?: string;
  scope?: string;
  buildTargetName?: string;
  testTargetName?: string;
  lintTargetName?: string;
  archiveTargetName?: string;
  deployTargetName?: string;
  fastlaneLane?: string;
  fastlanePlatform?: string;
  targets?: Readonly<Record<string, AppleNamedTargetOptions>>;
}

export interface AppleNamedTargetOptions {
  action: 'build' | 'test' | 'archive' | 'deploy';
  scheme: string;
  project?: string;
  configuration?: string;
  destination?: string;
  derivedDataPath?: string;
  fastlaneLane?: string;
  fastlanePlatform?: string;
  dependsOn?: readonly string[];
}

export interface SwiftPackageDump {
  name: string;
  dependencies?: Array<{
    fileSystem?: Array<{ identity?: string; path: string }>;
  }>;
  targets?: Array<{ name: string; type: string }>;
}

export type SwiftPackageDumpRunner = (
  packageRoot: string,
) => Promise<SwiftPackageDump>;

export interface AppleDiagnostic {
  manifest: string;
  message: string;
}

export interface ApplePreflightDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path: string;
}

export interface AppleRequiredTool {
  executable: string;
  reason: string;
}

export interface AppleManifestRecord {
  manifest: string;
  root: string;
  kind: 'workspace' | 'project' | 'package';
  name: string;
  localPaths: string[];
  application: boolean;
  schemes: string[];
  swiftLint: boolean;
  selected: boolean;
  diagnostics?: AppleDiagnostic[];
}

const PROJECT_PREFLIGHT_METADATA_KEY = 'megamono:preflight';

let diagnostics: AppleDiagnostic[] = [];
let lastRecords:
  { workspaceRoot: string; records: AppleManifestRecord[] } | undefined;

export function getAppleDiagnostics(): readonly AppleDiagnostic[] {
  return diagnostics;
}

function workspacePath(workspaceRoot: string, path: string): string {
  return normalizePath(relative(workspaceRoot, path)) || '.';
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function command(parts: readonly string[]): string {
  return parts.map(quote).join(' ');
}

function manifestKind(path: string): AppleManifestRecord['kind'] {
  if (path.endsWith('contents.xcworkspacedata')) return 'workspace';
  if (path.endsWith('project.pbxproj')) return 'project';
  return 'package';
}

function manifestRoot(path: string, kind: AppleManifestRecord['kind']): string {
  if (kind === 'workspace' || kind === 'project') return dirname(dirname(path));
  return dirname(path);
}

function manifestName(path: string, kind: AppleManifestRecord['kind']): string {
  if (kind === 'workspace') return basename(dirname(path), '.xcworkspace');
  if (kind === 'project') return basename(dirname(path), '.xcodeproj');
  return basename(dirname(path));
}

async function sharedSchemes(manifest: string): Promise<string[]> {
  const schemeRoot = resolve(dirname(manifest), 'xcshareddata/xcschemes');
  try {
    const entries = await readdir(schemeRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.xcscheme'))
      .map((entry) => basename(entry.name, '.xcscheme'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function hasSwiftLintConfig(root: string): boolean {
  return (
    existsSync(resolve(root, '.swiftlint.yml')) ||
    existsSync(resolve(root, '.swiftlint.yaml'))
  );
}

function unquotePbxValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
}

export function parsePbxLocalPackagePaths(source: string): string[] {
  const section = source.match(
    /\/\* Begin XCLocalSwiftPackageReference section \*\/([\s\S]*?)\/\* End XCLocalSwiftPackageReference section \*\//,
  )?.[1];
  if (!section) return [];
  return [
    ...new Set(
      [...section.matchAll(/\brelativePath\s*=\s*("(?:\\.|[^"])*"|[^;]+);/g)]
        .map((match) => unquotePbxValue(match[1]))
        .filter(Boolean),
    ),
  ].sort();
}

export function parseWorkspaceProjectPaths(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/\blocation\s*=\s*"([^"]+)"/g)]
        .map((match) => match[1].replace(/^(?:group|container|self):/, ''))
        .filter((path) => path.endsWith('.xcodeproj')),
    ),
  ].sort();
}

async function dumpSwiftPackage(
  packageRoot: string,
): Promise<SwiftPackageDump> {
  const { stdout } = await execFileAsync(
    'swift',
    ['package', 'dump-package', '--package-path', packageRoot],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as SwiftPackageDump;
}

function swiftLocalPaths(dump: SwiftPackageDump): string[] {
  return [
    ...new Set(
      (dump.dependencies ?? []).flatMap((dependency) =>
        (dependency.fileSystem ?? []).map(({ path }) => path),
      ),
    ),
  ].sort();
}

function isSwiftApplication(dump: SwiftPackageDump): boolean {
  return (dump.targets ?? []).some(({ type }) =>
    ['executable', 'macro', 'plugin'].includes(type),
  );
}

const precedence: Record<AppleManifestRecord['kind'], number> = {
  workspace: 0,
  project: 1,
  package: 2,
};

export async function collectAppleManifests(
  configFiles: readonly string[],
  workspaceRoot: string,
  runner: SwiftPackageDumpRunner = dumpSwiftPackage,
): Promise<{
  records: AppleManifestRecord[];
  diagnostics: AppleDiagnostic[];
}> {
  const records: AppleManifestRecord[] = [];
  const collectedDiagnostics: AppleDiagnostic[] = [];
  for (const file of [...configFiles].sort()) {
    const manifest = resolve(workspaceRoot, file);
    const kind = manifestKind(manifest);
    const root = manifestRoot(manifest, kind);
    let name = manifestName(manifest, kind);
    let localPaths: string[] = [];
    let application = kind !== 'package';
    let schemes: string[] = [];
    const recordDiagnostics: AppleDiagnostic[] = [];
    try {
      if (kind === 'package') {
        const dump = await runner(root);
        name = dump.name;
        localPaths = swiftLocalPaths(dump).map((path) => resolve(root, path));
        application = isSwiftApplication(dump);
      } else {
        const source = await readFile(manifest, 'utf8');
        schemes = await sharedSchemes(manifest);
        if (kind === 'project') {
          if (!/\bisa\s*=\s*PBXProject\s*;/.test(source)) {
            const diagnostic = {
              manifest,
              message: `Malformed Xcode project file: ${manifest} does not contain a PBXProject object.`,
            };
            collectedDiagnostics.push(diagnostic);
            recordDiagnostics.push(diagnostic);
          }
          localPaths = parsePbxLocalPackagePaths(source).map((path) =>
            resolve(root, path),
          );
        } else {
          localPaths = parseWorkspaceProjectPaths(source).map((path) =>
            resolve(root, path),
          );
        }
      }
    } catch (error) {
      const diagnostic = {
        manifest,
        message: `${kind === 'package' ? 'swift package dump-package' : 'Apple manifest parsing'} failed for ${manifest}: ${error instanceof Error ? error.message : String(error)}`,
      };
      collectedDiagnostics.push(diagnostic);
      recordDiagnostics.push(diagnostic);
    }
    records.push({
      manifest: workspacePath(workspaceRoot, manifest),
      root: workspacePath(workspaceRoot, root),
      kind,
      name,
      localPaths,
      application,
      schemes,
      swiftLint: hasSwiftLintConfig(root),
      selected: false,
      diagnostics: recordDiagnostics,
    });
  }

  const recordsByRoot = new Map<string, AppleManifestRecord[]>();
  for (const record of records) {
    const siblings = recordsByRoot.get(record.root) ?? [];
    siblings.push(record);
    recordsByRoot.set(record.root, siblings);
  }
  for (const siblings of recordsByRoot.values()) {
    siblings.sort(
      (left, right) =>
        precedence[left.kind] - precedence[right.kind] ||
        left.manifest.localeCompare(right.manifest),
    );
    siblings[0].selected = true;
  }
  return { records, diagnostics: collectedDiagnostics };
}

function schemeDiagnostic(
  record: AppleManifestRecord,
  options: ApplePluginOptions,
): AppleDiagnostic | undefined {
  if (
    record.kind === 'package' ||
    options.scheme ||
    applicableNamedTargets(record, options).length > 0 ||
    record.schemes.length === 1
  )
    return undefined;
  const reason =
    record.schemes.length > 1
      ? `Multiple shared Xcode schemes were detected for ${record.name}: ${record.schemes.join(', ')}.`
      : `No shared Xcode scheme was detected for ${record.name}.`;
  return {
    manifest: record.manifest,
    message: `${reason} Build, test, and archive targets were omitted; configure scheme in nx.json.`,
  };
}

function applicableNamedTargets(
  record: AppleManifestRecord,
  options: ApplePluginOptions,
): Array<readonly [string, AppleNamedTargetOptions]> {
  return Object.entries(options.targets ?? {})
    .filter(([, target]) =>
      target.project
        ? [record.name, record.root, record.manifest].includes(target.project)
        : true,
    )
    .sort(([left], [right]) => left.localeCompare(right));
}

function namedTargetDiagnostics(
  record: AppleManifestRecord,
  options: ApplePluginOptions,
): ApplePreflightDiagnostic[] {
  const defaultNames = new Set([
    options.buildTargetName ?? 'build',
    options.testTargetName ?? 'test',
    options.archiveTargetName ?? 'archive',
    options.deployTargetName ?? 'deploy',
    options.lintTargetName ?? 'lint',
  ]);
  return applicableNamedTargets(record, options).flatMap(([name, target]) => {
    const messages = [
      ...(!/^[a-z0-9][a-z0-9:_-]*$/.test(name)
        ? [`Named Apple target ${name} is not a valid Nx target name.`]
        : []),
      ...(defaultNames.has(name)
        ? [`Named Apple target ${name} collides with a default target name.`]
        : []),
      ...(record.schemes.length > 0 && !record.schemes.includes(target.scheme)
        ? [
            `Named Apple target ${name} selects unknown scheme ${target.scheme}; detected: ${record.schemes.join(', ')}.`,
          ]
        : []),
      ...(target.action === 'deploy' && !target.fastlaneLane
        ? [`Named Apple deploy target ${name} requires fastlaneLane.`]
        : []),
    ];
    return messages.map((message) => ({
      severity: 'error' as const,
      code: 'apple-target',
      message,
      path: record.manifest,
    }));
  });
}

function preflightMetadata(
  record: AppleManifestRecord,
  workspaceRoot: string,
  options: ApplePluginOptions,
): {
  diagnostics: ApplePreflightDiagnostic[];
  requiredTools: AppleRequiredTool[];
} {
  const diagnostics = [...(record.diagnostics ?? [])];
  const scheme = schemeDiagnostic(record, options);
  if (scheme) diagnostics.push(scheme);
  const requiredTools: AppleRequiredTool[] = [
    record.kind === 'package'
      ? { executable: 'swift', reason: 'Swift package build and test targets' }
      : {
          executable: 'xcodebuild',
          reason: 'Xcode build, test, and archive targets',
        },
  ];
  if (record.swiftLint)
    requiredTools.push({
      executable: 'swiftlint',
      reason: 'the project has a SwiftLint configuration',
    });
  if (options.fastlaneLane)
    requiredTools.push({
      executable: 'bundle',
      reason: 'the configured Fastlane deploy target',
    });
  if (
    applicableNamedTargets(record, options).some(
      ([, target]) => target.action === 'deploy',
    )
  )
    requiredTools.push({
      executable: 'bundle',
      reason: 'a configured named Fastlane deploy target',
    });
  return {
    diagnostics: [
      ...diagnostics.map((diagnostic) => ({
        severity: 'error' as const,
        code: diagnostic === scheme ? 'apple-scheme' : 'apple-manifest',
        message: diagnostic.message,
        path: isAbsolute(diagnostic.manifest)
          ? workspacePath(workspaceRoot, diagnostic.manifest)
          : normalizePath(diagnostic.manifest),
      })),
      ...namedTargetDiagnostics(record, options),
    ],
    requiredTools: requiredTools.sort((left, right) =>
      left.executable.localeCompare(right.executable),
    ),
  };
}

function createPackageTargets(
  record: AppleManifestRecord,
  projectName: string,
  options: ApplePluginOptions,
): ProjectConfiguration['targets'] {
  const scratch = normalizePath(
    `${options.derivedDataPath ?? '.nx/apple'}/${projectName}`,
  );
  const targets: NonNullable<ProjectConfiguration['targets']> = {
    [options.buildTargetName ?? 'build']: {
      executor: 'nx:run-commands',
      cache: true,
      inputs: ['default', '^default'],
      outputs: [`{workspaceRoot}/${scratch}`],
      options: {
        command: command([
          'swift',
          'build',
          '--package-path',
          record.root,
          '--scratch-path',
          scratch,
        ]),
        cwd: '{workspaceRoot}',
      },
      metadata: { description: `Build Swift package ${record.name}.` },
    },
    [options.testTargetName ?? 'test']: {
      executor: 'nx:run-commands',
      cache: true,
      dependsOn: [options.buildTargetName ?? 'build'],
      inputs: ['default', '^default'],
      options: {
        command: command([
          'swift',
          'test',
          '--package-path',
          record.root,
          '--scratch-path',
          scratch,
        ]),
        cwd: '{workspaceRoot}',
      },
      metadata: { description: `Test Swift package ${record.name}.` },
    },
  };
  if (record.swiftLint) {
    targets[options.lintTargetName ?? 'lint'] = {
      executor: 'nx:run-commands',
      cache: true,
      inputs: ['default', '^default'],
      options: {
        command: command([
          'swiftlint',
          'lint',
          '--strict',
          '--path',
          record.root,
        ]),
        cwd: '{workspaceRoot}',
      },
      metadata: { description: `Lint Swift package ${record.name}.` },
    };
  }
  return targets;
}

function xcodeSourceArguments(record: AppleManifestRecord): string[] {
  const container = dirname(record.manifest);
  return record.kind === 'workspace'
    ? ['-workspace', container]
    : ['-project', container];
}

function createXcodeTargets(
  record: AppleManifestRecord,
  projectName: string,
  options: ApplePluginOptions,
): ProjectConfiguration['targets'] {
  const lintTarget = record.swiftLint
    ? {
        executor: 'nx:run-commands',
        cache: true,
        inputs: ['default', '^default'],
        options: {
          command: command([
            'swiftlint',
            'lint',
            '--strict',
            '--path',
            record.root,
          ]),
          cwd: '{workspaceRoot}',
        },
        metadata: { description: `Lint Apple project ${record.name}.` },
      }
    : undefined;
  const scheme =
    options.scheme ??
    (record.schemes.length === 1 ? record.schemes[0] : undefined);
  const outputRoot = normalizePath(
    options.derivedDataPath ?? `.nx/apple/${projectName}`,
  );
  const archivePath = normalizePath(`${outputRoot}/${projectName}.xcarchive`);
  const targets: NonNullable<ProjectConfiguration['targets']> = {};
  if (scheme) {
    const common = [
      ...xcodeSourceArguments(record),
      '-scheme',
      scheme,
      '-configuration',
      options.configuration ?? 'Debug',
      '-destination',
      options.destination ?? 'platform=macOS',
      '-derivedDataPath',
      outputRoot,
    ];
    targets[options.buildTargetName ?? 'build'] = {
      executor: 'nx:run-commands',
      cache: true,
      inputs: ['default', '^default'],
      outputs: [`{workspaceRoot}/${outputRoot}`],
      options: {
        command: command(['xcodebuild', ...common, 'build']),
        cwd: '{workspaceRoot}',
      },
      metadata: { description: `Build Xcode scheme ${scheme}.` },
    };
    targets[options.testTargetName ?? 'test'] = {
      executor: 'nx:run-commands',
      cache: true,
      dependsOn: [options.buildTargetName ?? 'build'],
      inputs: ['default', '^default'],
      options: {
        command: command(['xcodebuild', ...common, 'test']),
        cwd: '{workspaceRoot}',
      },
      metadata: { description: `Test Xcode scheme ${scheme}.` },
    };
    targets[options.archiveTargetName ?? 'archive'] = {
      executor: 'nx:run-commands',
      cache: true,
      inputs: ['default', '^default'],
      outputs: [`{workspaceRoot}/${archivePath}`],
      options: {
        command: command([
          'xcodebuild',
          ...common,
          '-archivePath',
          archivePath,
          'archive',
        ]),
        cwd: '{workspaceRoot}',
      },
      metadata: { description: `Archive Xcode scheme ${scheme}.` },
    };
  }
  if (lintTarget) targets[options.lintTargetName ?? 'lint'] = lintTarget;
  if (scheme && options.fastlaneLane) {
    targets[options.deployTargetName ?? 'deploy'] = {
      executor: 'nx:run-commands',
      cache: false,
      dependsOn: [options.archiveTargetName ?? 'archive'],
      inputs: ['default', '^default'],
      options: {
        command: command([
          'bundle',
          'exec',
          'fastlane',
          ...(options.fastlanePlatform ? [options.fastlanePlatform] : []),
          options.fastlaneLane,
        ]),
        cwd: `{workspaceRoot}/${record.root}`,
      },
      metadata: {
        description: `Deploy with Fastlane ${options.fastlaneLane}.`,
      },
    };
  }
  for (const [targetName, target] of applicableNamedTargets(record, options)) {
    if (
      targets[targetName] ||
      !/^[a-z0-9][a-z0-9:_-]*$/.test(targetName) ||
      (record.schemes.length > 0 && !record.schemes.includes(target.scheme)) ||
      (target.action === 'deploy' && !target.fastlaneLane)
    )
      continue;
    if (target.action === 'deploy') {
      targets[targetName] = {
        executor: 'nx:run-commands',
        cache: false,
        ...(target.dependsOn ? { dependsOn: [...target.dependsOn] } : {}),
        inputs: ['default', '^default'],
        options: {
          command: command([
            'bundle',
            'exec',
            'fastlane',
            ...(target.fastlanePlatform ? [target.fastlanePlatform] : []),
            target.fastlaneLane as string,
          ]),
          cwd: `{workspaceRoot}/${record.root}`,
        },
        metadata: {
          description: `Deploy Xcode scheme ${target.scheme} with Fastlane ${target.fastlaneLane}.`,
        },
      };
      continue;
    }
    const namedOutput = normalizePath(
      target.derivedDataPath ?? `${outputRoot}/${targetName}`,
    );
    const namedArchive = normalizePath(
      `${namedOutput}/${projectName}-${targetName}.xcarchive`,
    );
    const common = [
      ...xcodeSourceArguments(record),
      '-scheme',
      target.scheme,
      '-configuration',
      target.configuration ?? 'Debug',
      '-destination',
      target.destination ?? 'platform=macOS',
      '-derivedDataPath',
      namedOutput,
    ];
    targets[targetName] = {
      executor: 'nx:run-commands',
      cache: true,
      ...(target.dependsOn ? { dependsOn: [...target.dependsOn] } : {}),
      inputs: ['default', '^default'],
      outputs: [
        `{workspaceRoot}/${
          target.action === 'archive' ? namedArchive : namedOutput
        }`,
      ],
      options: {
        command: command([
          'xcodebuild',
          ...common,
          ...(target.action === 'archive'
            ? ['-archivePath', namedArchive]
            : []),
          target.action,
        ]),
        cwd: '{workspaceRoot}',
      },
      metadata: {
        description: `${target.action[0].toUpperCase()}${target.action.slice(1)} Xcode scheme ${target.scheme}.`,
      },
    };
  }
  return targets;
}

export function projectsFromAppleManifests(
  records: readonly AppleManifestRecord[],
  workspaceRoot: string,
  options: ApplePluginOptions = {},
): Array<
  readonly [string, { projects: Record<string, ProjectConfiguration> }]
> {
  const selected = records.filter((record) => record.selected);
  const nameCounts = new Map<string, number>();
  for (const record of selected)
    nameCounts.set(record.name, (nameCounts.get(record.name) ?? 0) + 1);

  return selected.map((record) => {
    const name =
      nameCounts.get(record.name) === 1
        ? record.name
        : `${record.name}-${record.root.replaceAll('/', '-')}`;
    const targets =
      record.kind === 'package'
        ? createPackageTargets(record, name, options)
        : createXcodeTargets(record, name, options);
    return [
      record.manifest,
      {
        projects: {
          [record.root]: {
            name,
            root: record.root,
            sourceRoot: normalizePath(`${record.root}/Sources`),
            projectType: record.application ? 'application' : 'library',
            tags: record.application
              ? [
                  'platform:apple',
                  `scope:${options.scope ?? 'shared'}`,
                  'type:app',
                  'visibility:internal',
                ]
              : [
                  'platform:apple',
                  `scope:${options.scope ?? 'shared'}`,
                  'type:util',
                ],
            targets,
            metadata: {
              technologies: [
                'swift',
                ...(record.kind === 'package' ? ['swiftpm'] : ['xcode']),
              ],
              schemes: record.schemes,
              [PROJECT_PREFLIGHT_METADATA_KEY]: preflightMetadata(
                record,
                workspaceRoot,
                options,
              ),
            },
          },
        },
      },
    ] as const;
  });
}

function projectForRoot(
  root: string,
  projects: Record<string, ProjectConfiguration>,
): string | undefined {
  return Object.entries(projects).find(
    ([, project]) => normalizePath(project.root) === normalizePath(root),
  )?.[0];
}

export function dependenciesFromAppleManifests(
  records: readonly AppleManifestRecord[],
  projects: Record<string, ProjectConfiguration>,
  workspaceRoot: string,
): RawProjectGraphDependency[] {
  const dependencies: Array<
    RawProjectGraphDependency & { sourceFile: string }
  > = [];
  const seen = new Set<string>();
  for (const record of records) {
    const source = projectForRoot(record.root, projects);
    if (!source) continue;
    for (const localPath of record.localPaths) {
      const targetRoot = localPath.endsWith('.xcodeproj')
        ? dirname(localPath)
        : localPath;
      const target = projectForRoot(
        workspacePath(workspaceRoot, targetRoot),
        projects,
      );
      if (!target || target === source) continue;
      const key = `${source}\0${target}\0${record.manifest}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dependencies.push({
        source,
        target,
        sourceFile: record.manifest,
        type: DependencyType.static,
      });
    }
  }
  return dependencies.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.target.localeCompare(right.target) ||
      (left.sourceFile ?? '').localeCompare(right.sourceFile ?? ''),
  );
}

export const createNodes: CreateNodes<ApplePluginOptions> = [
  '**/{Package.swift,*.xcodeproj/project.pbxproj,*.xcworkspace/contents.xcworkspacedata}',
  async (
    configFiles: readonly string[] | string,
    options: ApplePluginOptions = {},
    context: { readonly workspaceRoot: string },
  ) => {
    const singleFileContract = typeof configFiles === 'string';
    const normalizedFiles = singleFileContract ? [configFiles] : configFiles;
    const collected = await collectAppleManifests(
      normalizedFiles,
      context.workspaceRoot,
    );
    diagnostics = [...collected.diagnostics];
    for (const record of collected.records) {
      if (!record.selected) continue;
      const diagnostic = schemeDiagnostic(record, options);
      if (diagnostic)
        diagnostics.push({
          ...diagnostic,
          manifest: resolve(context.workspaceRoot, diagnostic.manifest),
        });
    }
    for (const diagnostic of diagnostics) {
      process.stderr.write(`@megamono/nx-apple: ${diagnostic.message}\n`);
    }
    lastRecords = {
      workspaceRoot: context.workspaceRoot,
      records: collected.records,
    };
    const results = projectsFromAppleManifests(
      collected.records,
      context.workspaceRoot,
      options,
    );
    return singleFileContract
      ? {
          projects: Object.assign(
            {},
            ...results.map(([, result]) => result.projects),
          ),
        }
      : results;
  },
] as unknown as CreateNodes<ApplePluginOptions>;

// Nx 19 prefers this transitional export and Nx 21 requires it. Nx 18 and
// Nx 22+ continue to load createNodes, so both names intentionally share one
// implementation until the Nx 18/19 compatibility window closes.
export const createNodesV2 = createNodes;

export const createDependencies: CreateDependencies<
  ApplePluginOptions
> = async (_options, context) => {
  if (!lastRecords || lastRecords.workspaceRoot !== context.workspaceRoot)
    return [];
  const dependencies = dependenciesFromAppleManifests(
    lastRecords.records,
    context.projects,
    context.workspaceRoot,
  );
  for (const dependency of dependencies)
    validateDependency(dependency, context);
  return dependencies;
};
