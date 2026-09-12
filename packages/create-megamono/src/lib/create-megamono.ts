import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  configureSpringbarWithMcp,
  createSpringbarIntent,
  createSpringbarRetry,
  type SpringbarConfigurator,
  type SpringbarSetupResult,
} from './springbar.js';
import {
  PACKAGE_MANAGERS,
  packageManagerAdapter,
  type PackageManager,
} from './package-manager.js';

export const APP_IDS = [
  'web',
  'api',
  'worker',
  'mobile',
  'desktop',
  'apple',
  'site',
  'extension',
] as const;
export const SERVICE_IDS = [
  'postgres',
  'redis',
  'clickhouse',
  'typesense',
] as const;
export const VERIFY_MODES = ['none', 'config', 'build'] as const;
export const SERVICE_RUNNERS = ['none', 'springbar'] as const;
export const LOCAL_PACKAGE_SOURCES = ['registry', 'yalc'] as const;
export const DATABASE_ADAPTERS = ['none', 'prisma', 'drizzle'] as const;
export const WEB_STYLING_OPTIONS = [
  'chakra',
  'emotion',
  'tailwind',
  'panda',
  'stylex',
  'css-modules',
  'inline',
] as const;

export type AppId = (typeof APP_IDS)[number];
export type ServiceId = (typeof SERVICE_IDS)[number];
export type VerifyMode = (typeof VERIFY_MODES)[number];
export type ServiceRunner = (typeof SERVICE_RUNNERS)[number];
export type LocalPackageSource = (typeof LOCAL_PACKAGE_SOURCES)[number];
export type DatabaseAdapter = (typeof DATABASE_ADAPTERS)[number];
export type WebStyling = (typeof WEB_STYLING_OPTIONS)[number];

export interface AppInstance {
  type: AppId;
  name: string;
  directory: string;
}

export interface CreateMegamonoInput {
  name?: string;
  directory?: string;
  apps?: readonly string[];
  services?: readonly string[];
  databaseAdapter?: string;
  databaseName?: string;
  styling?: string;
  router?: string;
  serviceRunner?: string;
  integrations?: readonly string[];
  interactive?: boolean;
  install?: boolean;
  verify?: string;
  cleanupOnFailure?: boolean;
  dryRun?: boolean;
  localPackages?: string;
  packageManager?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
}

export interface NormalizedCreateOptions {
  name: string;
  scope: string;
  destination: string;
  stagingDirectory: string;
  apps: AppId[];
  appInstances: AppInstance[];
  services: ServiceId[];
  databaseAdapter: DatabaseAdapter;
  databaseName?: string;
  styling: WebStyling;
  router: 'pages' | 'app';
  serviceRunner: ServiceRunner;
  integrations: string[];
  install: boolean;
  verify: VerifyMode;
  cleanupOnFailure: boolean;
  dryRun: boolean;
  localPackages: LocalPackageSource;
  packageManager: PackageManager;
  platform: NodeJS.Platform;
}

export type PlanStep =
  | {
      kind: 'command';
      id: string;
      command: string;
      args: string[];
      cwd: 'parent' | 'staging';
    }
  | {
      kind: 'configure';
      id: 'configure-package-manager' | 'dehydrate-workspace';
    }
  | { kind: 'commit'; id: 'commit-workspace' }
  | { kind: 'springbar'; id: 'configure-springbar' };

export interface CreationPlan {
  options: NormalizedCreateOptions;
  steps: PlanStep[];
  springbarResult?: SpringbarSetupResult;
}

export interface CommandInvocation {
  command: string;
  args: readonly string[];
  cwd: string;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<void>;
export type YalcStoreResolver = () => Promise<string>;

export class CreateMegamonoError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2 | 3 | 4 | 130,
  ) {
    super(message);
    this.name = 'CreateMegamonoError';
  }
}

interface CompatibilityRegistry {
  packageManagers: Record<PackageManager, string>;
  pnpmAllowBuilds: string[];
  databaseAdapters: Record<string, { pnpmAllowBuilds?: string[] }>;
  scaffoldPackages: Record<string, string>;
  services: Record<string, string>;
  rustCrates: Record<string, string>;
}

export const compatibility = JSON.parse(
  readFileSync(new URL('../../compatibility.json', import.meta.url), 'utf8'),
) as CompatibilityRegistry;

function packagePin(name: string): string {
  const version = compatibility.scaffoldPackages[name];
  if (!version) {
    throw new CreateMegamonoError(
      `No tested compatibility pin exists for package ${name}.`,
      3,
    );
  }
  return `${name}@${version}`;
}
const APP_SET = new Set<string>(APP_IDS);
const SERVICE_SET = new Set<string>(SERVICE_IDS);
const RUNNER_SET = new Set<string>(SERVICE_RUNNERS);
const VERIFY_SET = new Set<string>(VERIFY_MODES);
const LOCAL_PACKAGE_SOURCE_SET = new Set<string>(LOCAL_PACKAGE_SOURCES);
const PACKAGE_MANAGER_SET = new Set<string>(PACKAGE_MANAGERS);
const DATABASE_ADAPTER_SET = new Set<string>(DATABASE_ADAPTERS);
const APP_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const appPlugin: Partial<Record<AppId, string>> = {
  web: '@nx/next',
  api: '@nx/nest',
  worker: '@megamono/nx-cloudflare',
  mobile: '@nx/expo',
  site: '@nx/next',
  extension: '@megamono/nx-extension',
};

function normalizedList(values: readonly string[] | undefined): string[] {
  return [
    ...new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  ].sort();
}

export function normalizeAppInstances(
  values: readonly string[] | undefined,
): AppInstance[] {
  const descriptors = (values ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  const instances = descriptors.map((descriptor) => {
    const parts = descriptor.split(':');
    if (parts.length > 2 || !parts[0] || (parts.length === 2 && !parts[1])) {
      throw new CreateMegamonoError(
        `Invalid app descriptor "${descriptor}". Use type or type:name.`,
        2,
      );
    }
    const type = parts[0];
    if (!APP_SET.has(type)) {
      const singular = type.endsWith('s') ? type.slice(0, -1) : undefined;
      const suggestion =
        singular && APP_SET.has(singular) ? singular : undefined;
      throw new CreateMegamonoError(
        `Unknown app type "${type}"${suggestion ? `. Did you mean "${suggestion}${parts[1] ? `:${parts[1]}` : ''}"?` : ` in "${descriptor}".`}`,
        2,
      );
    }
    const name = parts[1] ?? type;
    if (!APP_NAME_PATTERN.test(name)) {
      throw new CreateMegamonoError(
        `Invalid app name "${name}" in "${descriptor}". Use a normalized slug such as admin or extension-guides.`,
        2,
      );
    }
    return { type: type as AppId, name, directory: `apps/${name}` };
  });
  const names = new Set<string>();
  for (const instance of instances) {
    if (names.has(instance.name)) {
      throw new CreateMegamonoError(
        `App name and root "${instance.name}" is requested more than once. Each app instance must have a unique name.`,
        2,
      );
    }
    names.add(instance.name);
  }
  return instances;
}

function requireEnum<T extends string>(
  label: string,
  value: string,
  allowed: ReadonlySet<string>,
): T {
  if (!allowed.has(value)) {
    throw new CreateMegamonoError(
      `Invalid ${label} "${value}". Expected one of: ${[...allowed].join(', ')}.`,
      2,
    );
  }
  return value as T;
}

export function normalizeCreateOptions(
  input: CreateMegamonoInput,
): NormalizedCreateOptions {
  if (!input.name?.trim()) {
    throw new CreateMegamonoError(
      'A workspace name is required when interactive mode cannot resolve it.',
      4,
    );
  }
  const name = input.name.trim();
  const scope = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!scope) {
    throw new CreateMegamonoError(
      'The workspace name must contain at least one ASCII letter or number.',
      2,
    );
  }

  const appInstances = normalizeAppInstances(input.apps);
  if (input.apps === undefined) {
    throw new CreateMegamonoError(
      'Select applications or pass --apps= to explicitly create a workspace without applications.',
      4,
    );
  }
  const apps = [
    ...new Set(appInstances.map((app) => app.type)),
  ].sort() as AppId[];

  const services = normalizedList(input.services);
  const unknownServices = services.filter(
    (service) => !SERVICE_SET.has(service),
  );
  if (unknownServices.length > 0) {
    throw new CreateMegamonoError(
      `Unknown service selection(s): ${unknownServices.join(', ')}.`,
      2,
    );
  }
  const databaseAdapter = requireEnum<DatabaseAdapter>(
    'database adapter',
    input.databaseAdapter ?? 'none',
    DATABASE_ADAPTER_SET,
  );
  const databaseName =
    databaseAdapter === 'none'
      ? undefined
      : (input.databaseName?.trim().toLowerCase() ?? 'primary');
  if (
    databaseName !== undefined &&
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(databaseName)
  ) {
    throw new CreateMegamonoError(
      'The database name must be a normalized slug such as primary, events, or regional-us.',
      2,
    );
  }

  const platform = input.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new CreateMegamonoError(
      `create-megamono supports macOS and Linux in v1; received ${platform}.`,
      3,
    );
  }
  if (apps.includes('apple') && platform !== 'darwin') {
    throw new CreateMegamonoError('The apple app selection requires macOS.', 3);
  }
  const integrations = normalizedList(input.integrations);
  if (integrations.length > 0) {
    throw new CreateMegamonoError(
      `Integration fixture gate not satisfied for: ${integrations.join(', ')}.`,
      3,
    );
  }

  const cwd = resolve(input.cwd ?? process.cwd());
  const destination = resolve(cwd, input.directory ?? scope);
  const stagingDirectory = resolve(
    dirname(destination),
    `megamono-${scope}-staging`,
  );

  return {
    name,
    scope,
    destination,
    stagingDirectory,
    apps,
    appInstances,
    services: services as ServiceId[],
    databaseAdapter,
    ...(databaseName ? { databaseName } : {}),
    styling: requireEnum<WebStyling>(
      'web styling',
      input.styling ?? 'chakra',
      new Set<string>(WEB_STYLING_OPTIONS),
    ),
    router: requireEnum<'pages' | 'app'>(
      'web router',
      input.router ?? 'pages',
      new Set(['pages', 'app']),
    ),
    serviceRunner: requireEnum<ServiceRunner>(
      'service runner',
      input.serviceRunner ?? 'none',
      RUNNER_SET,
    ),
    integrations,
    install: input.install ?? true,
    verify: requireEnum<VerifyMode>(
      'verification mode',
      input.verify ?? 'config',
      VERIFY_SET,
    ),
    cleanupOnFailure: input.cleanupOnFailure ?? false,
    dryRun: input.dryRun ?? false,
    localPackages: requireEnum<LocalPackageSource>(
      'local package source',
      input.localPackages ?? 'registry',
      LOCAL_PACKAGE_SOURCE_SET,
    ),
    packageManager: requireEnum<PackageManager>(
      'package manager',
      input.packageManager ?? 'npm',
      PACKAGE_MANAGER_SET,
    ),
    platform,
  };
}

export function requiredMegamonoPackages(
  options: Pick<NormalizedCreateOptions, 'apps'>,
): string[] {
  return [
    '@megamono/plugin',
    ...(options.apps.includes('apple') ? ['@megamono/nx-apple'] : []),
    ...(options.apps.includes('desktop') ? ['@megamono/nx-cargo'] : []),
    ...(options.apps.includes('worker') ? ['@megamono/nx-cloudflare'] : []),
    ...(options.apps.includes('extension') ? ['@megamono/nx-extension'] : []),
  ].sort();
}

function commandStep(
  id: string,
  command: string,
  args: string[],
  cwd: 'parent' | 'staging',
): PlanStep {
  return { kind: 'command', id, command, args, cwd };
}

function nxArgs(
  packageManager: PackageManager,
  args: readonly string[],
): string[] {
  return packageManagerAdapter(packageManager).exec('nx', args);
}

function packageInstallArgs(
  packageManager: PackageManager,
  packages: readonly string[] = [],
): string[] {
  return packageManagerAdapter(packageManager).install(packages);
}

function scaffoldArgs(
  packageManager: PackageManager,
  packageName: string,
  args: readonly string[],
): string[] {
  return packageManagerAdapter(packageManager).scaffold(packageName, args);
}

function requestedPlatforms(options: NormalizedCreateOptions): string[] {
  return [
    ...new Set(
      options.apps.map((app) => {
        if (app === 'api') return 'node';
        if (app === 'worker') return 'worker';
        if (app === 'mobile') return 'mobile';
        if (app === 'desktop') return 'rust';
        if (app === 'apple') return 'apple';
        if (app === 'extension') return 'extension';
        return 'web';
      }),
    ),
  ].sort();
}

function generatedE2eProjects(options: NormalizedCreateOptions): string[] {
  return options.appInstances
    .filter(({ type }) => type === 'api' || type === 'site' || type === 'web')
    .map(({ name }) => `${options.scope}-${name}-e2e`);
}

function scaffoldPort(
  options: NormalizedCreateOptions,
  app: AppInstance & { type: 'api' | 'site' | 'web' },
): number {
  const hash = [...options.scope].reduce(
    (value, character) => (value * 31 + (character.codePointAt(0) ?? 0)) >>> 0,
    0,
  );
  const siblings = options.appInstances.filter(
    (candidate) => candidate.type === app.type,
  );
  const instanceOffset = siblings.findIndex(
    (candidate) => candidate.name === app.name,
  );
  return (
    40_000 +
    (hash % 8_000) +
    { api: 0, site: 1, web: 2 }[app.type] +
    instanceOffset * 3
  );
}

function requestedPorts(
  options: NormalizedCreateOptions,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    options.appInstances
      .filter(
        (app): app is AppInstance & { type: 'api' | 'site' | 'web' } =>
          app.type === 'api' || app.type === 'site' || app.type === 'web',
      )
      .map((app) => [app.name, scaffoldPort(options, app)]),
  );
}

function requestedServiceRequirements(
  options: NormalizedCreateOptions,
): Record<string, string> {
  return Object.fromEntries(
    options.services.map((service) => {
      const registryName = service === 'postgres' ? 'postgresql' : service;
      const version = compatibility.services[registryName];
      if (!version) {
        throw new CreateMegamonoError(
          `No tested compatibility pin exists for service ${service}.`,
          3,
        );
      }
      return [service, version];
    }),
  );
}

export function createPlan(options: NormalizedCreateOptions): CreationPlan {
  const databaseProject = `${options.scope}-${options.databaseAdapter}-${options.databaseName}`;
  const steps: PlanStep[] = [
    commandStep(
      'create-nx-workspace',
      options.packageManager,
      scaffoldArgs(options.packageManager, packagePin('create-nx-workspace'), [
        basename(options.stagingDirectory),
        '--preset=ts',
        '--workspaceType=integrated',
        `--packageManager=${options.packageManager}`,
        '--interactive=false',
        '--nxCloud=skip',
        '--skipGit',
        '--skipInstall=false',
      ]),
      'parent',
    ),
    { kind: 'configure', id: 'configure-package-manager' },
  ];

  const plugins = new Set<string>(['@megamono/plugin', 'typescript']);
  for (const app of options.apps) {
    const plugin = appPlugin[app];
    if (plugin) plugins.add(plugin);
    if (app === 'api') {
      for (const dependency of [
        '@nx/jest',
        '@swc/jest',
        '@types/jest',
        'jest',
        'jest-environment-node',
        'jest-util',
        'ts-jest',
        'ts-node',
      ]) {
        plugins.add(dependency);
      }
    }
    if (app === 'api' || app === 'site' || app === 'web') {
      plugins.add('@nx/eslint');
    }
    if (app === 'site' || app === 'web') {
      plugins.add('@nx/js');
      plugins.add('@nx/playwright');
    }
    if (app === 'worker') {
      plugins.add('wrangler');
    }
    if (app === 'desktop') plugins.add('@megamono/nx-cargo');
    if (app === 'apple') plugins.add('@megamono/nx-apple');
    if (app === 'extension') plugins.add('@megamono/nx-extension');
  }
  const localPackages = new Set(
    options.localPackages === 'yalc' ? requiredMegamonoPackages(options) : [],
  );
  const packages = [...plugins]
    .filter((name) => !localPackages.has(name))
    .sort()
    .map(packagePin);
  steps.push(
    commandStep(
      'install-plugins',
      options.packageManager,
      packageInstallArgs(options.packageManager, packages),
      'staging',
    ),
  );
  if (localPackages.size > 0) {
    steps.push(
      commandStep(
        'install-local-packages',
        'yalc',
        [
          'add',
          ...[...localPackages].sort().map(packagePin),
          '--dev',
          '--no-pure',
        ],
        'staging',
      ),
      commandStep(
        'hydrate-local-packages',
        options.packageManager,
        packageInstallArgs(options.packageManager),
        'staging',
      ),
    );
  }

  for (const app of options.appInstances) {
    const port =
      app.type === 'api' || app.type === 'site' || app.type === 'web'
        ? [
            `--port=${scaffoldPort(options, app as AppInstance & { type: 'api' | 'site' | 'web' })}`,
          ]
        : [];
    steps.push(
      commandStep(
        `generate-${app.name}`,
        options.packageManager,
        nxArgs(options.packageManager, [
          'generate',
          '@megamono/plugin:app',
          `--type=${app.type}`,
          `--name=${app.name}`,
          `--scope=${options.scope}`,
          `--workspaceName=${options.name}`,
          ...(app.type === 'web' || app.type === 'site'
            ? [`--styling=${options.styling}`, `--router=${options.router}`]
            : []),
          `--requestedApps=${options.apps.join(',')}`,
          `--requestedServices=${options.services.join(',')}`,
          `--serviceRunner=${options.serviceRunner}`,
          ...port,
          '--bootstrap',
          '--yes',
          '--interactive=false',
        ]),
        'staging',
      ),
    );
  }

  steps.push(
    commandStep(
      'initialize-megamono',
      options.packageManager,
      nxArgs(options.packageManager, [
        'generate',
        '@megamono/plugin:workspace-init',
        `--defaultScope=${options.scope}`,
        ...(options.apps.includes('desktop') ? ['--defaultPlatform=rust'] : []),
        '--only=docs,agents,ci,release,lint,skills,health,inference',
        '--yes',
        '--bootstrap',
        `--platforms=${requestedPlatforms(options).join(',')}`,
        `--ports=${JSON.stringify(requestedPorts(options))}`,
        `--serviceRunner=${options.serviceRunner}`,
        `--serviceRequirements=${JSON.stringify(requestedServiceRequirements(options))}`,
        `--packageManager=${options.packageManager}`,
        '--interactive=false',
      ]),
      'staging',
    ),
  );

  if (options.databaseAdapter !== 'none' && options.databaseName) {
    steps.push(
      commandStep(
        `generate-database-${options.databaseName}`,
        options.packageManager,
        nxArgs(options.packageManager, [
          'generate',
          '@megamono/plugin:database',
          `--name=${options.databaseName}`,
          `--adapter=${options.databaseAdapter}`,
          `--project=${databaseProject}`,
          `--scope=${options.scope}`,
          '--bootstrap',
          '--yes',
          '--interactive=false',
        ]),
        'staging',
      ),
    );
  }

  if (options.verify !== 'none') {
    steps.push(
      commandStep(
        'sync-workspace',
        options.packageManager,
        nxArgs(options.packageManager, ['sync']),
        'staging',
      ),
      commandStep(
        'format',
        options.packageManager,
        nxArgs(options.packageManager, ['format:write', '--all']),
        'staging',
      ),
      commandStep(
        'validate-docs',
        options.packageManager,
        nxArgs(options.packageManager, ['run', 'megamono-docs:validate']),
        'staging',
      ),
      commandStep(
        'check-structure',
        options.packageManager,
        nxArgs(options.packageManager, ['run', 'megamono:check']),
        'staging',
      ),
      commandStep(
        'build-project-graph',
        options.packageManager,
        nxArgs(options.packageManager, [
          'graph',
          '--file=.megamono/graph.json',
        ]),
        'staging',
      ),
    );
    if (options.databaseAdapter !== 'none' && options.databaseName) {
      steps.push(
        commandStep(
          `validate-database-${options.databaseName}`,
          options.packageManager,
          nxArgs(options.packageManager, [
            'run',
            `${databaseProject}:validate`,
          ]),
          'staging',
        ),
      );
    }
  }
  if (options.verify === 'build' && options.appInstances.length > 0) {
    steps.push(
      commandStep(
        'verify-generated-projects',
        options.packageManager,
        nxArgs(options.packageManager, [
          'run-many',
          '--targets=build,test,lint',
          `--projects=${options.appInstances.map((app) => `${options.scope}-${app.name}`).join(',')}`,
        ]),
        'staging',
      ),
    );
    const e2eProjects = generatedE2eProjects(options);
    for (const project of e2eProjects) {
      steps.push(
        commandStep(
          `verify-${project}`,
          options.packageManager,
          nxArgs(options.packageManager, ['run', `${project}:e2e`]),
          'staging',
        ),
      );
    }
  }
  if (!options.install) {
    steps.push({ kind: 'configure', id: 'dehydrate-workspace' });
  }
  steps.push({ kind: 'commit', id: 'commit-workspace' });
  if (options.serviceRunner === 'springbar') {
    steps.push({ kind: 'springbar', id: 'configure-springbar' });
  }
  return { options, steps };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export const resolveYalcStore: YalcStoreResolver = () =>
  new Promise((resolvePromise, reject) => {
    const child = spawn('yalc', ['dir'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      reject(
        new CreateMegamonoError(
          `Cannot locate yalc. Install yalc and publish the required Megamono packages before using --local-packages=yalc: ${error.message}`,
          3,
        ),
      );
    });
    child.once('exit', (code, signal) => {
      const store = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      if (code === 0 && store) {
        resolvePromise(resolve(store));
        return;
      }
      reject(
        new CreateMegamonoError(
          `Cannot resolve the yalc store${stderr.trim() ? `: ${stderr.trim()}` : `; yalc exited ${code === null ? `after signal ${signal ?? 'unknown'}` : `with code ${code}`}`}.`,
          3,
        ),
      );
    });
  });

async function preflightYalcPackages(
  plan: CreationPlan,
  resolveStore: YalcStoreResolver,
): Promise<void> {
  if (plan.options.localPackages !== 'yalc') return;
  const store = await resolveStore();
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const name of requiredMegamonoPackages(plan.options)) {
    const version = requiredScaffoldVersion(name);
    const manifestPath = resolve(
      store,
      'packages',
      ...name.split('/'),
      version,
      'package.json',
    );
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name !== name || manifest.version !== version)
        invalid.push(`${name}@${version}`);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        missing.push(`${name}@${version}`);
      } else {
        invalid.push(`${name}@${version}`);
      }
    }
  }
  if (missing.length === 0 && invalid.length === 0) return;
  const details = [
    ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
    ...(invalid.length > 0 ? [`invalid: ${invalid.join(', ')}`] : []),
  ].join('; ');
  throw new CreateMegamonoError(
    `The yalc store is not ready (${details}). Build and run yalc publish from each required package before retrying.`,
    3,
  );
}

export async function preflightPlan(
  plan: CreationPlan,
  yalcStoreResolver: YalcStoreResolver = resolveYalcStore,
): Promise<void> {
  const { destination, stagingDirectory } = plan.options;
  if (await pathExists(stagingDirectory)) {
    throw new CreateMegamonoError(
      `Staging directory already exists: ${stagingDirectory}. Recover or remove it before retrying.`,
      3,
    );
  }
  if (await pathExists(destination)) {
    const destinationStat = await lstat(destination);
    if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
      throw new CreateMegamonoError(
        `Destination must be an absent or empty directory: ${destination}.`,
        3,
      );
    }
    const entries = await readdir(destination);
    if (entries.length > 0) {
      throw new CreateMegamonoError(
        `Destination is not empty: ${destination}.`,
        3,
      );
    }
  }
  await preflightYalcPackages(plan, yalcStoreResolver);
}

export const runCommand: CommandRunner = ({ command, args, cwd }) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `${command} exited ${code === null ? `after signal ${signal ?? 'unknown'}` : `with code ${code}`}`,
          ),
        );
    });
  });

function renderCommand(step: Extract<PlanStep, { kind: 'command' }>): string {
  return [step.command, ...step.args]
    .map((part) => JSON.stringify(part))
    .join(' ');
}

export function renderPlan(plan: CreationPlan): string {
  return plan.steps
    .map((step, index) => {
      if (step.kind === 'commit') {
        return `${index + 1}. commit ${plan.options.stagingDirectory} -> ${plan.options.destination}`;
      }
      if (step.kind === 'configure') {
        if (step.id === 'configure-package-manager')
          return `${index + 1}. [staging] record ${plan.options.packageManager} and configure package-manager policy`;
        return `${index + 1}. [staging] remove bootstrap node_modules for an install-free destination`;
      }
      if (step.kind === 'springbar') {
        return `${index + 1}. [destination] Springbar MCP inspect_candidates -> setup_workspace`;
      }
      return `${index + 1}. [${step.cwd}] ${renderCommand(step)}`;
    })
    .join('\n');
}

function requiredScaffoldVersion(name: string): string {
  const version = compatibility.scaffoldPackages[name];
  if (!version) {
    throw new CreateMegamonoError(
      `No tested compatibility pin exists for package ${name}.`,
      3,
    );
  }
  return version;
}

async function configurePackageManager(plan: CreationPlan): Promise<void> {
  const packagePath = resolve(plan.options.stagingDirectory, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    packageManager?: string;
  };
  packageJson.packageManager = `${plan.options.packageManager}@${compatibility.packageManagers[plan.options.packageManager]}`;
  await writeFile(
    packagePath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  );

  if (plan.options.packageManager !== 'pnpm') return;
  const workspacePath = resolve(
    plan.options.stagingDirectory,
    'pnpm-workspace.yaml',
  );
  const source = await readFile(workspacePath, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  let allowBuildsIndex = lines.findIndex((line) =>
    /^allowBuilds:\s*$/.test(line),
  );
  if (allowBuildsIndex === -1) {
    while (lines.at(-1) === '') lines.pop();
    lines.push('', 'allowBuilds:');
    allowBuildsIndex = lines.length - 1;
  }
  let end = allowBuildsIndex + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  const entries = new Map<string, string>();
  for (const line of lines.slice(allowBuildsIndex + 1, end)) {
    const match = line.match(/^\s{2}([^:#]+):\s*(.+)$/);
    if (match) {
      const rawKey = match[1].trim();
      const key = rawKey.startsWith('"')
        ? JSON.parse(rawKey)
        : rawKey.replace(/^'(.*)'$/, '$1');
      entries.set(key, match[2].trim());
    }
  }
  const builds = [
    ...compatibility.pnpmAllowBuilds,
    ...(compatibility.databaseAdapters[plan.options.databaseAdapter]
      ?.pnpmAllowBuilds ?? []),
  ];
  for (const name of builds) {
    // Existing decisions belong to the scaffold/policy, including explicit denial.
    if (!entries.has(name)) entries.set(name, 'true');
  }
  lines.splice(
    allowBuildsIndex + 1,
    end - allowBuildsIndex - 1,
    ...[...entries]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => {
        const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
        return `  ${key}: ${value}`;
      }),
  );
  await writeFile(workspacePath, lines.join(newline), 'utf8');
}

async function writeRecovery(
  plan: CreationPlan,
  completed: readonly string[],
  failure: unknown,
): Promise<void> {
  await mkdir(plan.options.stagingDirectory, { recursive: true });
  const message = failure instanceof Error ? failure.message : String(failure);
  const body = [
    '# Megamono bootstrap recovery',
    '',
    `Requested destination: ${plan.options.destination}`,
    `Failure: ${message}`,
    '',
    'Completed steps:',
    ...(completed.length > 0
      ? completed.map((step) => `- ${step}`)
      : ['- none']),
    '',
    'The requested destination was not populated. Inspect this staging directory, then move or remove it before retrying.',
    '',
  ].join('\n');
  await writeFile(
    resolve(plan.options.stagingDirectory, 'MEGAMONO-RECOVERY.md'),
    body,
    'utf8',
  );
}

async function commitWorkspace(plan: CreationPlan): Promise<void> {
  const { destination, stagingDirectory } = plan.options;
  let removedEmptyDestination = false;
  if (await pathExists(destination)) {
    await rmdir(destination);
    removedEmptyDestination = true;
  }
  try {
    await rename(stagingDirectory, destination);
  } catch (error) {
    if (removedEmptyDestination) await mkdir(destination);
    throw error;
  }
}

async function removeInstalledDependencies(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(directory, entry.name);
    if (entry.name === 'node_modules') {
      await rm(path, { recursive: true, force: true });
    } else if (entry.name !== '.git') {
      await removeInstalledDependencies(path);
    }
  }
}

export async function executePlan(
  plan: CreationPlan,
  runner: CommandRunner = runCommand,
  springbarConfigurator: SpringbarConfigurator = configureSpringbarWithMcp,
  yalcStoreResolver: YalcStoreResolver = resolveYalcStore,
): Promise<void> {
  await preflightPlan(plan, yalcStoreResolver);
  if (plan.options.dryRun) return;
  const completed: string[] = [];
  try {
    for (const step of plan.steps) {
      if (step.kind === 'commit') await commitWorkspace(plan);
      else if (step.kind === 'configure') {
        if (step.id === 'configure-package-manager')
          await configurePackageManager(plan);
        else await removeInstalledDependencies(plan.options.stagingDirectory);
      } else if (step.kind === 'springbar') {
        const intent = createSpringbarIntent(
          plan.options,
          compatibility.services,
        );
        try {
          plan.springbarResult = await springbarConfigurator(intent);
        } catch (error) {
          plan.springbarResult = createSpringbarRetry(
            intent,
            `Springbar handoff was not applied: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        await runner({
          command: step.command,
          args: step.args,
          cwd:
            step.cwd === 'parent'
              ? dirname(plan.options.stagingDirectory)
              : plan.options.stagingDirectory,
        });
      }
      completed.push(step.id);
    }
  } catch (error) {
    if (plan.options.cleanupOnFailure) {
      await rm(plan.options.stagingDirectory, { recursive: true, force: true });
    } else {
      await writeRecovery(plan, completed, error);
    }
    throw new CreateMegamonoError(
      `Workspace creation failed after ${completed.length} completed step(s): ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
}

export async function readRecovery(path: string): Promise<string> {
  return readFile(resolve(path, 'MEGAMONO-RECOVERY.md'), 'utf8');
}

export async function createMegamono(
  input: CreateMegamonoInput,
  runner: CommandRunner = runCommand,
  springbarConfigurator: SpringbarConfigurator = configureSpringbarWithMcp,
  yalcStoreResolver: YalcStoreResolver = resolveYalcStore,
): Promise<CreationPlan> {
  const plan = createPlan(normalizeCreateOptions(input));
  await executePlan(plan, runner, springbarConfigurator, yalcStoreResolver);
  return plan;
}
