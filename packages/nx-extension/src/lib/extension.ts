import {
  normalizePath,
  type CreateNodes,
  type ProjectConfiguration,
} from '@nx/devkit';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  manifestVersions,
  wxtCommand,
  wxtOutput,
  type BrowserManifestVersions,
} from './wxt-targets';

export interface ExtensionPluginOptions {
  readonly manifestVersions?: BrowserManifestVersions;
  readonly scope?: string;
  readonly devChromeTargetName?: string;
  readonly devFirefoxTargetName?: string;
  readonly buildTargetName?: string;
  readonly packageTargetName?: string;
}

export interface ExtensionDiagnostic {
  readonly configPath: string;
  readonly message: string;
}

export interface WxtConfigRecord {
  readonly browserManifestVersions?: BrowserManifestVersions;
  readonly configPath: string;
  readonly root: string;
  readonly projectName: string;
  readonly packageName?: string;
  readonly tags: readonly string[];
  readonly storeCommands: Readonly<Record<string, string>>;
  readonly framework?: 'wxt' | 'manifest';
  readonly manifestVersion?: 2 | 3;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly manifestPaths?: readonly string[];
}

let diagnostics: ExtensionDiagnostic[] = [];

export function getExtensionDiagnostics(): readonly ExtensionDiagnostic[] {
  return diagnostics;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function recordForConfig(
  configPath: string,
  workspaceRoot: string,
  options: ExtensionPluginOptions,
): WxtConfigRecord {
  const normalizedConfig = normalizePath(configPath);
  const root = normalizePath(dirname(normalizedConfig));
  const absoluteRoot = resolve(workspaceRoot, root);
  const manifestPath = resolve(absoluteRoot, 'package.json');
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        readonly name?: unknown;
        readonly megamono?: {
          readonly extension?: { readonly manifestVersions?: unknown };
        };
        readonly nx?: {
          readonly name?: unknown;
          readonly tags?: unknown;
        };
      })
    : {};
  const packageName =
    typeof manifest.name === 'string' ? manifest.name : undefined;
  const projectName =
    (typeof manifest.nx?.name === 'string' ? manifest.nx.name : undefined) ??
    packageName ??
    basename(root);
  const configuredTags = Array.isArray(manifest.nx?.tags)
    ? manifest.nx.tags.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  const storePath = resolve(absoluteRoot, 'extension.store.json');
  let storeCommands: Readonly<Record<string, string>> = {};
  if (existsSync(storePath)) {
    try {
      const store = JSON.parse(readFileSync(storePath, 'utf8')) as {
        readonly commands?: unknown;
      };
      storeCommands = stringRecord(store.commands);
    } catch (error) {
      diagnostics.push({
        configPath: normalizedConfig,
        message: `Invalid extension.store.json: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return {
    configPath: normalizedConfig,
    root,
    projectName,
    ...(packageName ? { packageName } : {}),
    tags: [
      ...new Set([
        ...configuredTags,
        'platform:extension',
        `scope:${options.scope ?? 'shared'}`,
        'type:app',
      ]),
    ].sort(),
    storeCommands,
    framework: 'wxt',
    browserManifestVersions: manifestVersions(
      manifest.megamono?.extension?.manifestVersions,
    ),
    scripts: {},
  };
}

function nearestPackageRoot(path: string, workspaceRoot: string): string {
  let current = dirname(resolve(workspaceRoot, path));
  const boundary = resolve(workspaceRoot);
  while (current.startsWith(boundary)) {
    if (
      existsSync(resolve(current, 'package.json')) ||
      existsSync(resolve(current, 'project.json'))
    )
      return (
        normalizePath(current.slice(boundary.length).replace(/^\//, '')) || '.'
      );
    if (current === boundary) break;
    current = dirname(current);
  }
  const directory = normalizePath(dirname(path));
  return basename(directory) === 'public' ? dirname(directory) : directory;
}

const generatedSegments = new Set([
  'node_modules',
  '.yalc',
  'dist',
  'build',
  '.output',
  'generated',
  '.git',
]);

function sourcePath(path: string): boolean {
  return !normalizePath(path)
    .split('/')
    .some((part) => generatedSegments.has(part));
}

/** Explicit source manifests are package-relative, never executable configuration. */
function configuredManifests(path: string, workspaceRoot: string): string[] {
  const manifest = JSON.parse(
    readFileSync(resolve(workspaceRoot, path), 'utf8'),
  );
  const names: unknown = manifest?.megamono?.extension?.manifests;
  if (names === undefined) return [];
  if (
    !Array.isArray(names) ||
    names.some(
      (name) =>
        typeof name !== 'string' ||
        !name.endsWith('.json') ||
        name.startsWith('/') ||
        name.includes('\\') ||
        name
          .split('/')
          .some((part: string) => !part || part === '.' || part === '..') ||
        !sourcePath(name),
    )
  ) {
    throw new Error(
      `${path}: megamono.extension.manifests must contain source-only package-relative JSON paths.`,
    );
  }
  return names.map((name: string) => normalizePath(`${dirname(path)}/${name}`));
}

function recordForManifest(
  manifestPath: string,
  workspaceRoot: string,
  options: ExtensionPluginOptions,
): WxtConfigRecord | null {
  const normalizedConfig = normalizePath(manifestPath);
  const root = nearestPackageRoot(normalizedConfig, workspaceRoot);
  if (
    ['ts', 'js', 'mjs', 'mts'].some((extension) =>
      existsSync(resolve(workspaceRoot, root, `wxt.config.${extension}`)),
    )
  )
    return null;
  let extensionManifest: {
    readonly manifest_version?: unknown;
    readonly name?: unknown;
    readonly version?: unknown;
  };
  try {
    extensionManifest = JSON.parse(
      readFileSync(resolve(workspaceRoot, normalizedConfig), 'utf8'),
    ) as typeof extensionManifest;
  } catch (error) {
    diagnostics.push({
      configPath: normalizedConfig,
      message: `Invalid browser extension manifest: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
  if (
    (extensionManifest.manifest_version !== 2 &&
      extensionManifest.manifest_version !== 3) ||
    typeof extensionManifest.name !== 'string' ||
    typeof extensionManifest.version !== 'string'
  )
    return null;
  const packagePath = resolve(workspaceRoot, root, 'package.json');
  const packageManifest = existsSync(packagePath)
    ? (JSON.parse(readFileSync(packagePath, 'utf8')) as {
        readonly name?: unknown;
        readonly scripts?: unknown;
        readonly nx?: { readonly name?: unknown; readonly tags?: unknown };
      })
    : {};
  const packageName =
    typeof packageManifest.name === 'string' ? packageManifest.name : undefined;
  const configuredTags = Array.isArray(packageManifest.nx?.tags)
    ? packageManifest.nx.tags.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  return {
    configPath: normalizedConfig,
    root,
    projectName:
      (typeof packageManifest.nx?.name === 'string'
        ? packageManifest.nx.name
        : packageName) ?? basename(root),
    ...(packageName ? { packageName } : {}),
    tags: [
      ...new Set([
        ...configuredTags,
        'platform:extension',
        `scope:${options.scope ?? 'shared'}`,
        'type:app',
      ]),
    ].sort(),
    storeCommands: {},
    framework: 'manifest',
    manifestVersion: extensionManifest.manifest_version,
    scripts: stringRecord(packageManifest.scripts),
  };
}

function runTarget(
  command: string,
  cache = true,
): NonNullable<ProjectConfiguration['targets']>[string] {
  return {
    executor: 'nx:run-commands',
    cache,
    options: { command, cwd: '{projectRoot}' },
  };
}

function extensionTargets(
  record: WxtConfigRecord,
  options: ExtensionPluginOptions,
): NonNullable<ProjectConfiguration['targets']> {
  const versions = {
    ...manifestVersions(options.manifestVersions),
    ...manifestVersions(record.browserManifestVersions),
  };
  const targets: NonNullable<ProjectConfiguration['targets']> = {
    [options.devChromeTargetName ?? 'dev-chrome']: {
      ...runTarget(wxtCommand('', 'chrome', versions.chrome), false),
      continuous: true,
    },
    [options.devFirefoxTargetName ?? 'dev-firefox']: {
      ...runTarget(wxtCommand('', 'firefox', versions.firefox), false),
      continuous: true,
    },
    'build-chrome': {
      ...runTarget(wxtCommand('build', 'chrome', versions.chrome)),
      outputs: [wxtOutput('chrome', versions.chrome)],
    },
    'build-firefox': {
      ...runTarget(wxtCommand('build', 'firefox', versions.firefox)),
      outputs: [wxtOutput('firefox', versions.firefox)],
    },
    [options.buildTargetName ?? 'build']: {
      executor: 'nx:noop',
      cache: true,
      dependsOn: ['build-chrome', 'build-firefox'],
      outputs: ['{projectRoot}/.output'],
    },
    'package-chrome': {
      ...runTarget(wxtCommand('zip', 'chrome', versions.chrome)),
      dependsOn: ['build-chrome'],
      outputs: ['{projectRoot}/.output/*-chrome.zip'],
    },
    'package-firefox': {
      ...runTarget(wxtCommand('zip', 'firefox', versions.firefox)),
      dependsOn: ['build-firefox'],
      outputs: ['{projectRoot}/.output/*-firefox.zip'],
    },
    'package-firefox-source': {
      ...runTarget(
        `${wxtCommand('zip', 'firefox', versions.firefox)} --sources`,
      ),
      outputs: ['{projectRoot}/.output/*-sources.zip'],
    },
    [options.packageTargetName ?? 'package']: {
      executor: 'nx:noop',
      cache: true,
      dependsOn: [
        'package-chrome',
        'package-firefox',
        'package-firefox-source',
      ],
      outputs: ['{projectRoot}/.output/*.zip'],
    },
    test: runTarget('vitest run'),
    lint: runTarget('eslint .'),
  };
  for (const [store, command] of Object.entries(record.storeCommands).sort()) {
    targets[`deploy-${store}`] = {
      ...runTarget(command, false),
      dependsOn: [store === 'firefox' ? 'package-firefox' : 'package-chrome'],
    };
  }
  if (Object.keys(record.storeCommands).length > 0) {
    targets.deploy = {
      executor: 'nx:noop',
      cache: false,
      dependsOn: Object.keys(record.storeCommands)
        .sort()
        .map((store) => `deploy-${store}`),
    };
  }
  return targets;
}

function genericExtensionTargets(
  record: WxtConfigRecord,
  options: ExtensionPluginOptions,
): NonNullable<ProjectConfiguration['targets']> {
  const targets: NonNullable<ProjectConfiguration['targets']> = {};
  const scripts = record.scripts ?? {};
  const mappings = [
    [options.buildTargetName ?? 'build', 'build', true],
    ['dev', 'dev', false],
    ['test', 'test', true],
    ['lint', 'lint', true],
  ] as const;
  for (const [target, script, cache] of mappings)
    if (scripts[script])
      targets[target] = {
        executor: 'nx:run-script',
        cache,
        options: { script },
        ...(script === 'dev' ? { continuous: true } : {}),
      };
  return targets;
}

export function projectsFromWxtConfigs(
  records: readonly WxtConfigRecord[],
  options: ExtensionPluginOptions = {},
): Record<string, ProjectConfiguration> {
  return Object.fromEntries(
    records.map((record) => [
      record.root,
      {
        name: record.projectName,
        root: record.root,
        sourceRoot:
          record.framework === 'manifest'
            ? `${record.root}/src`
            : `${record.root}/entrypoints`,
        projectType: 'application',
        tags: [...record.tags],
        targets:
          record.framework === 'manifest'
            ? genericExtensionTargets(record, options)
            : extensionTargets(record, options),
        metadata: {
          technologies:
            record.framework === 'manifest'
              ? ['webextension']
              : ['wxt', 'vite', 'webextension'],
          description:
            record.framework === 'manifest'
              ? 'Repository-authored browser extension application'
              : 'WXT browser extension application',
          'megamono:extension': {
            schemaVersion: 1,
            configPath: record.configPath,
            ...(record.manifestPaths
              ? { manifestPaths: record.manifestPaths }
              : {}),
            framework: record.framework ?? 'wxt',
            ...(record.manifestVersion
              ? { manifestVersion: record.manifestVersion }
              : {}),
            browsers:
              record.framework === 'manifest'
                ? ['declared-by-repository']
                : ['chrome', 'firefox'],
            safari: 'separate-apple-project',
          },
        },
      },
    ]),
  );
}

export const createNodes: CreateNodes<ExtensionPluginOptions> = [
  '**/{wxt.config.{ts,js,mjs,mts},manifest{,.chrome,.firefox}.json,package.json}',
  async (
    configFiles: readonly string[] | string,
    options: ExtensionPluginOptions = {},
    context: { readonly workspaceRoot: string },
  ) => {
    diagnostics = [];
    const single = typeof configFiles === 'string';
    const inputs = (single ? [configFiles] : configFiles).filter(sourcePath);
    const files = [
      ...new Set(
        inputs.flatMap((path) =>
          basename(path) === 'package.json'
            ? configuredManifests(path, context.workspaceRoot)
            : [path],
        ),
      ),
    ];
    const records = files
      .map((path) =>
        !basename(path).startsWith('wxt.config.')
          ? recordForManifest(path, context.workspaceRoot, options)
          : recordForConfig(path, context.workspaceRoot, options),
      )
      .filter((record): record is WxtConfigRecord => record !== null)
      .sort((left, right) => left.configPath.localeCompare(right.configPath));
    const grouped = new Map<string, WxtConfigRecord>();
    for (const record of records) {
      const previous = grouped.get(record.root);
      grouped.set(record.root, {
        ...(previous ?? record),
        ...(record.framework === 'manifest'
          ? {
              manifestPaths: [
                ...new Set([
                  ...(previous?.manifestPaths ?? []),
                  record.configPath,
                ]),
              ].sort(),
            }
          : {}),
      });
    }
    for (const diagnostic of diagnostics) {
      process.stderr.write(`@megamono/nx-extension: ${diagnostic.message}\n`);
    }
    const results = [...grouped.values()].map(
      (record) =>
        [
          [record.configPath],
          { projects: projectsFromWxtConfigs([record], options) },
        ] as const,
    );
    return single
      ? {
          projects: Object.assign(
            {},
            ...results.map(([, result]) => result.projects),
          ),
        }
      : results;
  },
] as unknown as CreateNodes<ExtensionPluginOptions>;

// Nx 19 prefers this transitional export and Nx 21 requires it. Nx 18 and
// Nx 22+ continue to load createNodes, so both names intentionally share one
// implementation until the Nx 18/19 compatibility window closes.
export const createNodesV2 = createNodes;
