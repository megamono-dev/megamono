import {
  addDependenciesToPackageJson,
  names,
  normalizePath,
  updateJson,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { relative } from 'node:path';
import { subset, validRange } from 'semver';
import {
  CLOUDFLARE_COMPATIBILITY_DATE,
  WRANGLER_VERSION,
  WRANGLER_VERSION_RANGE,
} from '../../lib/compatibility';
import type { WorkerGeneratorSchema } from './schema';
import {
  assertFileCanWrite,
  CloudflareGeneratorError,
  createPostFlushCallback,
  printCloudflareGeneratorPlan,
  readTreeText,
  safeWorkspacePath,
  typegenTask,
  type CloudflareGeneratorPlanOperation,
} from '../shared';

const PLUGIN_NAME = '@megamono/nx-cloudflare';
const PLUGIN_VERSION = '0.0.1';

interface NormalizedWorkerOptions {
  readonly projectName: string;
  readonly workerName: string;
  readonly directory: string;
  readonly scope: string;
  readonly tags: string[];
  readonly dryRun: boolean;
}

function normalizedOptions(
  options: WorkerGeneratorSchema,
): NormalizedWorkerOptions {
  if (options.pages)
    throw new CloudflareGeneratorError(
      'options',
      'Cloudflare Pages and Pages Functions are outside the v1 generator contract.',
    );
  const projectName = names(options.name?.trim() ?? '').fileName;
  if (!projectName || !/^[a-z0-9][a-z0-9-]*$/.test(projectName))
    throw new CloudflareGeneratorError(
      'options',
      'Worker name must contain letters or numbers and normalize to kebab-case.',
    );
  const directory = safeWorkspacePath(
    options.directory?.trim() || `apps/${projectName}`,
  );
  const scope = names(options.scope?.trim() || 'shared').fileName;
  if (!scope)
    throw new CloudflareGeneratorError('options', 'Scope cannot be empty.');
  const workerName = options.workerName?.trim() || projectName;
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(workerName))
    throw new CloudflareGeneratorError(
      'options',
      'Worker binding identity must use lowercase letters, numbers, hyphens, or underscores.',
    );
  const tags = [
    'platform:worker',
    `scope:${scope}`,
    'type:app',
    'visibility:internal',
    ...(options.tags ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
  ];
  return {
    projectName,
    workerName,
    directory,
    scope,
    tags: [...new Set(tags)].sort(),
    dryRun: options.dryRun ?? false,
  };
}

function relativeJsonPath(fromDirectory: string, target: string): string {
  const path = normalizePath(relative(fromDirectory, target));
  return path.startsWith('.') ? path : `./${path}`;
}

function renderedFiles(
  options: NormalizedWorkerOptions,
): Record<string, string> {
  const schema = relativeJsonPath(
    options.directory,
    'node_modules/wrangler/config-schema.json',
  );
  const baseTsconfig = relativeJsonPath(
    options.directory,
    'tsconfig.base.json',
  );
  return {
    [`${options.directory}/project.json`]: `${JSON.stringify(
      {
        name: options.projectName,
        projectType: 'application',
        sourceRoot: `${options.directory}/src`,
        tags: options.tags,
      },
      null,
      2,
    )}\n`,
    [`${options.directory}/wrangler.jsonc`]: `${JSON.stringify(
      {
        $schema: schema,
        name: options.workerName,
        main: 'src/index.ts',
        compatibility_date: CLOUDFLARE_COMPATIBILITY_DATE,
      },
      null,
      2,
    )}\n`,
    [`${options.directory}/tsconfig.json`]: `${JSON.stringify(
      {
        extends: baseTsconfig,
        compilerOptions: {
          lib: ['ES2022', 'WebWorker'],
          types: ['./worker-configuration.d.ts'],
        },
        include: ['src/**/*.ts', 'worker-configuration.d.ts'],
      },
      null,
      2,
    )}\n`,
    [`${options.directory}/src/index.ts`]: `export default {
  async fetch(): Promise<Response> {
    return new Response('Hello from ${options.workerName}.');
  },
};
`,
  };
}

interface ConfiguredPlugin {
  plugin: string;
  options?: Record<string, unknown>;
}

function cloudflarePluginRegistration(
  tree: Tree,
  scope: string,
): { configured: boolean } {
  const nx = readTreeText(tree, 'nx.json');
  if (!nx)
    throw new CloudflareGeneratorError(
      'preflight',
      'nx.json is required before generating a Worker.',
    );
  try {
    const value = JSON.parse(nx) as {
      plugins?: Array<string | ConfiguredPlugin>;
    };
    const matches = (value.plugins ?? []).filter((entry) =>
      typeof entry === 'string'
        ? entry === PLUGIN_NAME
        : entry.plugin === PLUGIN_NAME,
    );
    if (matches.length > 1)
      throw new CloudflareGeneratorError(
        'conflict',
        `${PLUGIN_NAME} is registered more than once in nx.json.`,
      );
    const entry = matches[0];
    return {
      configured: typeof entry === 'object' && entry.options?.scope === scope,
    };
  } catch (error) {
    if (error instanceof CloudflareGeneratorError) throw error;
    throw new CloudflareGeneratorError('preflight', 'nx.json is malformed.');
  }
}

function isExactYalcPackage(
  tree: Tree,
  name: string,
  version: string,
  declaration: string,
): boolean {
  if (declaration !== `file:.yalc/${name}`) return false;
  const source = readTreeText(tree, `.yalc/${name}/package.json`);
  if (!source) return false;
  try {
    const manifest = JSON.parse(source) as {
      name?: unknown;
      version?: unknown;
    };
    return manifest.name === name && manifest.version === version;
  } catch {
    return false;
  }
}

function missingDependencies(tree: Tree): Record<string, string> {
  const source = readTreeText(tree, 'package.json');
  if (!source)
    throw new CloudflareGeneratorError(
      'preflight',
      'package.json is required before generating a Worker.',
    );
  let manifest: { devDependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(source) as typeof manifest;
  } catch {
    throw new CloudflareGeneratorError(
      'preflight',
      'package.json is malformed.',
    );
  }
  const expected = {
    [PLUGIN_NAME]: PLUGIN_VERSION,
    wrangler: WRANGLER_VERSION,
  };
  const missing: Record<string, string> = {};
  for (const [name, version] of Object.entries(expected)) {
    const installed = manifest.devDependencies?.[name];
    const exactYalcPackage =
      name === PLUGIN_NAME &&
      installed !== undefined &&
      isExactYalcPackage(tree, name, version, installed);
    const compatibleWrangler =
      name === 'wrangler' &&
      installed !== undefined &&
      validRange(installed) !== null &&
      subset(installed, WRANGLER_VERSION_RANGE);
    if (
      installed &&
      installed !== version &&
      !exactYalcPackage &&
      !compatibleWrangler
    )
      throw new CloudflareGeneratorError(
        'conflict',
        name === 'wrangler'
          ? `${name} is already declared as ${installed}; expected a version within ${WRANGLER_VERSION_RANGE}.`
          : `${name} is already declared as ${installed}; expected ${version}.`,
      );
    if (!installed) missing[name] = version;
  }
  return missing;
}

export async function workerGenerator(
  tree: Tree,
  schema: WorkerGeneratorSchema,
): Promise<GeneratorCallback | void> {
  const options = normalizedOptions(schema);
  const files = renderedFiles(options);
  const operations: CloudflareGeneratorPlanOperation[] = [];
  let changed = false;
  for (const [path, content] of Object.entries(files)) {
    const action = assertFileCanWrite(tree, path, content);
    operations.push({
      action,
      target: path,
      detail:
        action === 'add'
          ? 'Add the Worker repository convention.'
          : 'Retain the matching Worker convention.',
    });
    if (action === 'add') changed = true;
  }
  const pluginRegistration = cloudflarePluginRegistration(tree, options.scope);
  const configurePlugin = !pluginRegistration.configured;
  operations.push({
    action: configurePlugin ? 'modify' : 'retain',
    target: 'nx.json#plugins',
    detail: `${configurePlugin ? 'Register' : 'Retain'} ${PLUGIN_NAME} with scope ${options.scope}.`,
  });
  changed ||= configurePlugin;
  const dependencies = missingDependencies(tree);
  if (Object.keys(dependencies).length > 0) {
    operations.push({
      action: 'modify',
      target: 'package.json#devDependencies',
      detail: `Add ${Object.keys(dependencies).sort().join(', ')} from the compatibility registry.`,
    });
    changed = true;
  } else {
    operations.push({
      action: 'retain',
      target: 'package.json#devDependencies',
      detail: 'Retain the pinned Cloudflare development dependencies.',
    });
  }
  if (changed)
    operations.push({
      action: 'run-last',
      target: 'wrangler types',
      detail:
        'Generate Worker configuration types after dependency installation and tree flush.',
    });
  printCloudflareGeneratorPlan({ generator: 'worker', operations });
  if (options.dryRun || !changed) return;

  for (const [path, content] of Object.entries(files)) {
    if (!tree.exists(path)) tree.write(path, content);
  }
  if (configurePlugin) {
    updateJson(tree, 'nx.json', (value) => {
      const plugins = (
        Array.isArray(value.plugins) ? value.plugins : []
      ) as Array<string | ConfiguredPlugin>;
      let replaced = false;
      const configured = plugins.map((entry) => {
        const name = typeof entry === 'string' ? entry : entry?.plugin;
        if (name !== PLUGIN_NAME) return entry;
        replaced = true;
        return {
          ...(typeof entry === 'object' ? entry : {}),
          plugin: PLUGIN_NAME,
          options: {
            ...(typeof entry === 'object' && entry.options
              ? entry.options
              : {}),
            scope: options.scope,
          },
        };
      });
      if (!replaced)
        configured.push({
          plugin: PLUGIN_NAME,
          options: { scope: options.scope },
        });
      return { ...value, plugins: configured };
    });
  }
  const tasks = [];
  if (Object.keys(dependencies).length > 0) {
    const install = addDependenciesToPackageJson(tree, {}, dependencies);
    tasks.push({ id: 'npm-install', retry: 'npm install', run: install });
  }
  tasks.push(typegenTask(tree.root, `${options.directory}/wrangler.jsonc`));
  return createPostFlushCallback(tree.root, tasks);
}

export default workerGenerator;
