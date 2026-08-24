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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CargoPluginOptions {
  buildTargetName?: string;
  testTargetName?: string;
  lintTargetName?: string;
  tauriTargetName?: string;
  target?: string;
  features?: string[];
  allFeatures?: boolean;
  noDefaultFeatures?: boolean;
  profile?: string;
  targetDir?: string;
  scope?: string;
}

export interface CargoMetadataDependency {
  name: string;
  path: string | null;
  kind?: 'normal' | 'dev' | 'build' | null;
  target?: string | null;
}

export interface CargoMetadataPackage {
  id: string;
  name: string;
  manifest_path: string;
  dependencies: CargoMetadataDependency[];
  targets: Array<{ kind: string[] }>;
  metadata?: Record<string, unknown>;
}

export interface CargoMetadata {
  packages: CargoMetadataPackage[];
  workspace_members: string[];
  workspace_root: string;
  target_directory: string;
}

export interface CargoDiagnostic {
  manifest: string;
  message: string;
}

export interface CargoMetadataRecord {
  manifest: string;
  metadata: CargoMetadata;
}

let lastMetadata:
  { workspaceRoot: string; records: CargoMetadataRecord[] } | undefined;
let diagnostics: CargoDiagnostic[] = [];

export function getCargoDiagnostics(): readonly CargoDiagnostic[] {
  return diagnostics;
}

function workspacePath(workspaceRoot: string, path: string): string {
  return normalizePath(relative(workspaceRoot, path)) || '.';
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cargoFlags(options: CargoPluginOptions): string[] {
  const flags: string[] = [];
  if (options.target) flags.push('--target', options.target);
  if (options.features?.length)
    flags.push('--features', options.features.join(','));
  if (options.allFeatures) flags.push('--all-features');
  if (options.noDefaultFeatures) flags.push('--no-default-features');
  if (options.profile) flags.push('--profile', options.profile);
  return flags;
}

function command(parts: readonly string[]): string {
  return parts.map(quote).join(' ');
}

function projectRootForPackage(
  pkg: CargoMetadataPackage,
  workspaceRoot: string,
): string {
  const manifestDirectory = dirname(pkg.manifest_path);
  const projectDirectory =
    manifestDirectory.endsWith('/src-tauri') ||
    manifestDirectory.endsWith('\\src-tauri')
      ? dirname(manifestDirectory)
      : manifestDirectory;
  return workspacePath(workspaceRoot, projectDirectory);
}

function isApplication(pkg: CargoMetadataPackage): boolean {
  return pkg.targets.some((target) =>
    target.kind.some((kind) => kind === 'bin' || kind === 'cdylib'),
  );
}

function hasTauriConfig(pkg: CargoMetadataPackage): boolean {
  const root = dirname(pkg.manifest_path);
  return (
    existsSync(resolve(root, 'tauri.conf.json')) ||
    existsSync(resolve(root, 'tauri.conf.json5')) ||
    existsSync(resolve(root, 'Tauri.toml'))
  );
}

function hasTauriNpmCli(
  pkg: CargoMetadataPackage,
  workspaceRoot: string,
): boolean {
  const projectRoot = projectRootForPackage(pkg, workspaceRoot);
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(workspaceRoot, projectRoot, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(
      manifest.dependencies?.['@tauri-apps/cli'] ??
      manifest.devDependencies?.['@tauri-apps/cli'],
    );
  } catch {
    return false;
  }
}

function createTargets(
  pkg: CargoMetadataPackage,
  projectName: string,
  workspaceRoot: string,
  options: CargoPluginOptions,
): ProjectConfiguration['targets'] {
  const manifest = workspacePath(workspaceRoot, pkg.manifest_path);
  const targetDirectory = normalizePath(
    `${options.targetDir ?? '.nx/cargo'}/${projectName}`,
  );
  const common = [
    '--manifest-path',
    manifest,
    '--package',
    pkg.name,
    ...cargoFlags(options),
  ];
  const inputs = ['default', '^default'];
  const targets: NonNullable<ProjectConfiguration['targets']> = {
    [options.buildTargetName ?? 'build']: {
      executor: 'nx:run-commands',
      cache: true,
      inputs,
      outputs: [`{workspaceRoot}/${targetDirectory}`],
      options: {
        command: command([
          'cargo',
          'build',
          ...common,
          '--target-dir',
          targetDirectory,
        ]),
        cwd: '{workspaceRoot}',
      },
      metadata: { description: `Build Cargo package ${pkg.name}.` },
    },
    [options.testTargetName ?? 'test']: {
      executor: 'nx:run-commands',
      cache: true,
      inputs,
      options: {
        command: command([
          'cargo',
          'test',
          ...common,
          '--target-dir',
          targetDirectory,
        ]),
        cwd: '{workspaceRoot}',
      },
      metadata: { description: `Test Cargo package ${pkg.name}.` },
    },
    [options.lintTargetName ?? 'lint']: {
      executor: 'nx:run-commands',
      cache: true,
      inputs,
      options: {
        command: command([
          'cargo',
          'clippy',
          ...common,
          '--target-dir',
          targetDirectory,
        ]),
        cwd: '{workspaceRoot}',
      },
      metadata: { description: `Lint Cargo package ${pkg.name} with Clippy.` },
    },
  };
  if (hasTauriConfig(pkg)) {
    const projectRoot = projectRootForPackage(pkg, workspaceRoot);
    const npmCli = hasTauriNpmCli(pkg, workspaceRoot);
    const tauriCommand = npmCli
      ? [
          'npm',
          'exec',
          'tauri',
          '--',
          'build',
          '--ci',
          '--',
          '--package',
          pkg.name,
          '--target-dir',
          normalizePath(
            relative(
              resolve(workspaceRoot, projectRoot),
              resolve(workspaceRoot, targetDirectory),
            ),
          ),
        ]
      : [
          'cargo',
          'tauri',
          'build',
          '--',
          '--package',
          pkg.name,
          '--target-dir',
          targetDirectory,
        ];
    targets[options.tauriTargetName ?? 'tauri'] = {
      executor: 'nx:run-commands',
      cache: true,
      inputs,
      outputs: [`{workspaceRoot}/${targetDirectory}`],
      options: {
        command: command(tauriCommand),
        cwd: npmCli ? `{workspaceRoot}/${projectRoot}` : '{workspaceRoot}',
      },
      metadata: { description: `Build Tauri package ${pkg.name}.` },
    };
  }
  return targets;
}

export function projectsFromCargoMetadata(
  records: readonly CargoMetadataRecord[],
  workspaceRoot: string,
  options: CargoPluginOptions = {},
): Array<
  readonly [string, { projects: Record<string, ProjectConfiguration> }]
> {
  const counts = new Map<string, number>();
  for (const { metadata } of records) {
    for (const pkg of metadata.packages)
      counts.set(pkg.name, (counts.get(pkg.name) ?? 0) + 1);
  }

  return records.map(({ manifest, metadata }) => {
    const projects: Record<string, ProjectConfiguration> = {};
    for (const pkg of metadata.packages) {
      if (!metadata.workspace_members.includes(pkg.id)) continue;
      const root = projectRootForPackage(pkg, workspaceRoot);
      const name =
        counts.get(pkg.name) === 1
          ? pkg.name
          : `${pkg.name}-${root.replaceAll('/', '-').replace(/[^a-zA-Z0-9-_]/g, '-')}`;
      const application = isApplication(pkg);
      const scope = options.scope ?? 'shared';
      projects[root] = {
        name,
        root,
        sourceRoot: normalizePath(`${root}/src`),
        projectType: application ? 'application' : 'library',
        tags: application
          ? [
              'platform:rust',
              `scope:${scope}`,
              'type:app',
              'visibility:internal',
            ]
          : ['platform:rust', `scope:${scope}`, 'type:util'],
        targets: createTargets(pkg, name, workspaceRoot, options),
        metadata: {
          technologies: ['rust', ...(hasTauriConfig(pkg) ? ['tauri'] : [])],
        },
      };
    }
    return [manifest, { projects }] as const;
  });
}

async function runMetadata(
  manifest: string,
  workspaceRoot: string,
): Promise<CargoMetadata> {
  const { stdout } = await execFileAsync(
    'cargo',
    [
      'metadata',
      '--format-version',
      '1',
      '--no-deps',
      '--manifest-path',
      manifest,
    ],
    { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as CargoMetadata;
}

export type CargoMetadataRunner = (
  manifest: string,
  workspaceRoot: string,
) => Promise<CargoMetadata>;

function metadataRoots(
  configFiles: readonly string[],
  workspaceRoot: string,
): string[] {
  const absolute = configFiles.map((file) => resolve(workspaceRoot, file));
  const workspaceManifests = absolute.filter((manifest) => {
    try {
      return /^\s*\[workspace\](?:\s|$)/m.test(readFileSync(manifest, 'utf8'));
    } catch {
      return false;
    }
  });
  return absolute.filter((manifest) => {
    if (workspaceManifests.includes(manifest)) return true;
    return !workspaceManifests.some((root) =>
      containsPath(dirname(root), dirname(manifest)),
    );
  });
}

export async function collectCargoMetadata(
  configFiles: readonly string[],
  workspaceRoot: string,
  runner: CargoMetadataRunner = runMetadata,
): Promise<{ records: CargoMetadataRecord[]; diagnostics: CargoDiagnostic[] }> {
  const records: CargoMetadataRecord[] = [];
  const collectedDiagnostics: CargoDiagnostic[] = [];
  const attempted = new Set<string>();
  const collect = async (manifest: string) => {
    attempted.add(manifest);
    try {
      records.push({
        manifest: workspacePath(workspaceRoot, manifest),
        metadata: await runner(manifest, workspaceRoot),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      collectedDiagnostics.push({
        manifest,
        message: `cargo metadata failed for ${manifest}: ${detail}`,
      });
    }
  };
  for (const manifest of metadataRoots(configFiles, workspaceRoot).sort()) {
    await collect(manifest);
  }
  const represented = new Set(
    records.flatMap(({ metadata }) =>
      metadata.packages.map((pkg) => resolve(pkg.manifest_path)),
    ),
  );
  for (const manifest of configFiles
    .map((file) => resolve(workspaceRoot, file))
    .filter((file) => !attempted.has(file) && !represented.has(file))
    .sort()) {
    await collect(manifest);
  }
  return { records, diagnostics: collectedDiagnostics };
}

export const createNodes: CreateNodes<CargoPluginOptions> = [
  '**/Cargo.toml',
  async (configFiles, options = {}, context) => {
    const collected = await collectCargoMetadata(
      configFiles,
      context.workspaceRoot,
    );
    diagnostics = collected.diagnostics;
    for (const diagnostic of diagnostics) {
      process.stderr.write(`@megamono/nx-cargo: ${diagnostic.message}\n`);
    }
    lastMetadata = {
      workspaceRoot: context.workspaceRoot,
      records: collected.records,
    };
    return projectsFromCargoMetadata(
      collected.records,
      context.workspaceRoot,
      options,
    );
  },
];

function projectForPackage(
  pkg: CargoMetadataPackage,
  projects: Record<string, ProjectConfiguration>,
  workspaceRoot: string,
): string | undefined {
  const root = projectRootForPackage(pkg, workspaceRoot);
  return Object.entries(projects).find(
    ([, project]) => normalizePath(project.root) === root,
  )?.[0];
}

export const createDependencies: CreateDependencies<
  CargoPluginOptions
> = async (_options, context) => {
  if (!lastMetadata || lastMetadata.workspaceRoot !== context.workspaceRoot)
    return [];
  const dependencies = dependenciesFromCargoMetadata(
    lastMetadata.records,
    context.projects,
    context.workspaceRoot,
  );
  for (const dependency of dependencies)
    validateDependency(dependency, context);
  return dependencies;
};

export function dependenciesFromCargoMetadata(
  records: readonly CargoMetadataRecord[],
  projects: Record<string, ProjectConfiguration>,
  workspaceRoot: string,
): RawProjectGraphDependency[] {
  const packagesByRoot = new Map<string, CargoMetadataPackage>();
  for (const { metadata } of records) {
    for (const pkg of metadata.packages)
      packagesByRoot.set(resolve(dirname(pkg.manifest_path)), pkg);
  }
  const dependencies: RawProjectGraphDependency[] = [];
  const seen = new Set<string>();
  for (const { metadata } of records) {
    for (const pkg of metadata.packages) {
      const source = projectForPackage(pkg, projects, workspaceRoot);
      if (!source) continue;
      for (const cargoDependency of pkg.dependencies) {
        if (!cargoDependency.path) continue;
        const targetPackage = packagesByRoot.get(resolve(cargoDependency.path));
        if (!targetPackage) continue;
        const target = projectForPackage(
          targetPackage,
          projects,
          workspaceRoot,
        );
        if (!target || target === source) continue;
        const sourceFile = workspacePath(workspaceRoot, pkg.manifest_path);
        const key = `${source}\0${target}\0${sourceFile}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const dependency: RawProjectGraphDependency = {
          source,
          target,
          sourceFile,
          type: DependencyType.static,
        };
        dependencies.push(dependency);
      }
    }
  }
  return dependencies.sort((a, b) =>
    `${a.source}:${a.target}:${'sourceFile' in a ? a.sourceFile : ''}`.localeCompare(
      `${b.source}:${b.target}:${'sourceFile' in b ? b.sourceFile : ''}`,
    ),
  );
}
