import {
  normalizePath,
  type CreateNodes,
  type ProjectConfiguration,
} from '@nx/devkit';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export interface ExtensionPluginOptions {
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
  readonly configPath: string;
  readonly root: string;
  readonly projectName: string;
  readonly packageName?: string;
  readonly tags: readonly string[];
  readonly storeCommands: Readonly<Record<string, string>>;
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
  };
}

function runTarget(
  command: string,
  cache = true,
): NonNullable<ProjectConfiguration['targets']>[string] {
  return {
    executor: 'nx:run-commands',
    cache,
    options: { command },
  };
}

function extensionTargets(
  record: WxtConfigRecord,
  options: ExtensionPluginOptions,
): NonNullable<ProjectConfiguration['targets']> {
  const targets: NonNullable<ProjectConfiguration['targets']> = {
    [options.devChromeTargetName ?? 'dev-chrome']: {
      ...runTarget('wxt --browser chrome', false),
      continuous: true,
    },
    [options.devFirefoxTargetName ?? 'dev-firefox']: {
      ...runTarget('wxt --browser firefox', false),
      continuous: true,
    },
    'build-chrome': {
      ...runTarget('wxt build --browser chrome'),
      outputs: ['{projectRoot}/.output/chrome-mv3'],
    },
    'build-firefox': {
      ...runTarget('wxt build --browser firefox'),
      outputs: ['{projectRoot}/.output/firefox-mv2'],
    },
    [options.buildTargetName ?? 'build']: {
      executor: 'nx:noop',
      cache: true,
      dependsOn: ['build-chrome', 'build-firefox'],
      outputs: ['{projectRoot}/.output'],
    },
    'package-chrome': {
      ...runTarget('wxt zip --browser chrome'),
      dependsOn: ['build-chrome'],
      outputs: ['{projectRoot}/.output/*-chrome.zip'],
    },
    'package-firefox': {
      ...runTarget('wxt zip --browser firefox'),
      dependsOn: ['build-firefox'],
      outputs: ['{projectRoot}/.output/*-firefox.zip'],
    },
    'package-firefox-source': {
      ...runTarget('wxt zip --browser firefox --sources'),
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
        sourceRoot: `${record.root}/entrypoints`,
        projectType: 'application',
        tags: [...record.tags],
        targets: extensionTargets(record, options),
        metadata: {
          technologies: ['wxt', 'vite', 'webextension'],
          description: 'WXT browser extension application',
          'megamono:extension': {
            schemaVersion: 1,
            configPath: record.configPath,
            browsers: ['chrome', 'firefox'],
            safari: 'separate-apple-project',
          },
        },
      },
    ]),
  );
}

export const createNodes: CreateNodes<ExtensionPluginOptions> = [
  '**/wxt.config.{ts,js,mjs,mts}',
  async (
    configFiles: readonly string[] | string,
    options: ExtensionPluginOptions = {},
    context: { readonly workspaceRoot: string },
  ) => {
    diagnostics = [];
    const single = typeof configFiles === 'string';
    const files = single ? [configFiles] : configFiles;
    const records = files
      .map((path) => recordForConfig(path, context.workspaceRoot, options))
      .sort((left, right) => left.configPath.localeCompare(right.configPath));
    for (const diagnostic of diagnostics) {
      process.stderr.write(`@megamono/nx-extension: ${diagnostic.message}\n`);
    }
    const results = records.map(
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
