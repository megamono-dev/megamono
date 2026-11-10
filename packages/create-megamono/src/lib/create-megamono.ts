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
  'android',
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
  packages?: readonly string[];
  packageScope?: string;
  packageAccess?: string;
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
  /** Continue a failed creation from its staged state instead of starting over. */
  resume?: boolean;
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
  packages: string[];
  packageScope: string;
  packageAccess: 'public' | 'restricted';
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
      id:
        | 'configure-package-manager'
        | 'configure-workspace-identity'
        | 'configure-publishable-packages'
        | 'prune-build-approvals'
        | 'dehydrate-workspace';
    }
  | { kind: 'commit'; id: 'commit-workspace' }
  | { kind: 'springbar'; id: 'configure-springbar' };

export interface CreationPlan {
  options: NormalizedCreateOptions;
  steps: PlanStep[];
  springbarResult?: SpringbarSetupResult;
  /** Step IDs already completed by an earlier, failed run (set by --resume). */
  resumedSteps?: readonly string[];
}

/** Machine-readable twin of MEGAMONO-RECOVERY.md, read by --resume. */
export const CREATION_STATE_FILE = '.megamono-create-state.json';
const RECOVERY_FILE = 'MEGAMONO-RECOVERY.md';

interface CreationState {
  schemaVersion: 1;
  options: NormalizedCreateOptions;
  steps: string[];
  completed: string[];
  failure: string;
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
  toolchains: { node: string; nx: string };
  runtimePins: { node: string };
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

export function validatePackageNames(names: readonly string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      throw new CreateMegamonoError(
        'Package names must be lowercase slugs, such as core or client-sdk.',
        2,
      );
    if (seen.has(name))
      throw new CreateMegamonoError(`Duplicate package name: ${name}.`, 2);
    seen.add(name);
  }
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
  if (input.apps === undefined && input.packages === undefined) {
    throw new CreateMegamonoError(
      'Select applications or pass --apps= to explicitly create a workspace without applications.',
      4,
    );
  }
  const apps = [
    ...new Set(appInstances.map((app) => app.type)),
  ].sort() as AppId[];
  const packages = [...(input.packages ?? [])];
  validatePackageNames(packages);
  const packageScope = (input.packageScope ?? scope).replace(/^@/, '');
  validatePackageNames([packageScope]);
  for (const name of packages) {
    if (
      appInstances.some(
        (app) => app.name === name || `${app.name}-e2e` === name,
      ) ||
      (name === 'nest-home' && apps.includes('api')) ||
      (name === 'theme' && apps.some((app) => app === 'web' || app === 'site'))
    ) {
      throw new CreateMegamonoError(
        `Package ${name} conflicts with an application or its generated support library. Choose another package name.`,
        2,
      );
    }
  }

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
    packages,
    packageScope,
    packageAccess: requireEnum<'public' | 'restricted'>(
      'package access',
      input.packageAccess ?? 'restricted',
      new Set(['public', 'restricted']),
    ),
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
    ...new Set([
      ...(options.packages.length ? ['node'] : []),
      ...options.apps.map((app) => {
        if (app === 'api') return 'node';
        if (app === 'worker') return 'worker';
        if (app === 'mobile') return 'mobile';
        if (app === 'desktop') return 'rust';
        if (app === 'apple') return 'apple';
        if (app === 'android') return 'android';
        if (app === 'extension') return 'extension';
        return 'web';
      }),
    ]),
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

  const plugins = new Set<string>(['@megamono/plugin', 'nx', 'typescript']);
  if (options.packages.length) {
    plugins.add('@nx/js');
    plugins.add('@nx/eslint');
  }
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
    if (
      app === 'api' ||
      app === 'site' ||
      app === 'web' ||
      app === 'extension'
    ) {
      plugins.add('@nx/eslint');
    }
    if (app === 'site' || app === 'web') {
      plugins.add('@nx/js');
      plugins.add('@nx/playwright');
      plugins.add('@playwright/test');
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

  steps.push({
    kind: 'command',
    id: 'validate-bootstrap-toolchain',
    command: 'node',
    args: ['-e', bootstrapToolchainCheck()],
    cwd: 'staging',
  });

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

  for (const name of options.packages) {
    steps.push(
      commandStep(
        `generate-package-${name}`,
        options.packageManager,
        nxArgs(options.packageManager, [
          'generate',
          '@nx/js:library',
          `--directory=packages/${name}`,
          `--name=${options.scope}-${name}`,
          `--importPath=@${options.packageScope}/${name}`,
          '--publishable=true',
          '--bundler=tsc',
          '--linter=eslint',
          '--unitTestRunner=none',
          '--useProjectJson=true',
          `--tags=platform:node,scope:${options.scope},type:util`,
          '--interactive=false',
        ]),
        'staging',
      ),
      commandStep(
        `hydrate-package-${name}`,
        options.packageManager,
        packageInstallArgs(options.packageManager),
        'staging',
      ),
    );
  }
  if (options.packages.length)
    steps.push({ kind: 'configure', id: 'configure-publishable-packages' });

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

  steps.push({ kind: 'configure', id: 'configure-workspace-identity' });

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
  if (
    options.verify === 'build' &&
    (options.appInstances.length > 0 || options.packages.length > 0)
  ) {
    steps.push(
      commandStep(
        'verify-generated-projects',
        options.packageManager,
        nxArgs(options.packageManager, [
          'run-many',
          '--targets=build,test,lint',
          `--projects=${[...options.appInstances.map((app) => app.name), ...options.packages].map((name) => `${options.scope}-${name}`).join(',')}`,
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
  if (options.packageManager === 'pnpm')
    steps.push({ kind: 'configure', id: 'prune-build-approvals' });
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
  if (plan.resumedSteps === undefined && (await pathExists(stagingDirectory))) {
    const resumable = await pathExists(
      resolve(stagingDirectory, CREATION_STATE_FILE),
    );
    throw new CreateMegamonoError(
      `Staging directory already exists: ${stagingDirectory}. ${resumable ? 'Rerun with --resume to continue from the first incomplete step, or remove it to start over.' : 'Recover or remove it before retrying.'}`,
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
  const resumed = new Set(plan.resumedSteps ?? []);
  return plan.steps
    .map((step, index) => {
      const line = renderPlanStep(plan, step, index);
      return resumed.has(step.id) ? `${line} (completed; skipped)` : line;
    })
    .join('\n');
}

function renderPlanStep(
  plan: CreationPlan,
  step: PlanStep,
  index: number,
): string {
  if (step.kind === 'commit') {
    return `${index + 1}. commit ${plan.options.stagingDirectory} -> ${plan.options.destination}`;
  }
  if (step.kind === 'configure') {
    if (step.id === 'configure-publishable-packages')
      return `${index + 1}. [staging] configure ${plan.options.packageAccess} npm package access (no publication)`;
    if (step.id === 'configure-package-manager')
      return `${index + 1}. [staging] record ${plan.options.packageManager}, pin the bootstrap toolchain, and configure package-manager policy`;
    if (step.id === 'configure-workspace-identity')
      return `${index + 1}. [staging] normalize the workspace source condition and Node runtime declaration`;
    if (step.id === 'prune-build-approvals')
      return `${index + 1}. [staging] drop pre-approved pnpm builds for packages the lockfile does not install`;
    return `${index + 1}. [staging] remove bootstrap node_modules for an install-free destination`;
  }
  if (step.kind === 'springbar') {
    return `${index + 1}. [destination] Springbar MCP inspect_candidates -> setup_workspace`;
  }
  return `${index + 1}. [${step.cwd}] ${renderCommand(step)}`;
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

/** Run before any Megamono generator can consume a drifted Nx installation. */
function bootstrapToolchainCheck(): string {
  const baseline = requiredScaffoldVersion('nx');
  return `const manifest = require('./package.json');
const baseline = ${JSON.stringify(baseline)};
const packages = new Set(['nx', ...Object.keys({...manifest.dependencies, ...manifest.devDependencies}).filter(name => name.startsWith('@nx/'))]);
for (const name of packages) {
  const actual = require(name + '/package.json').version;
  const expected = baseline;
  if (actual !== expected) throw new Error('Bootstrap toolchain mismatch: ' + name + '@' + actual + '; expected ' + expected + ' from compatibility.json (Nx ${compatibility.toolchains.nx}). Reinstall the exact bootstrap pins before running Megamono generators.');
}
`;
}

function rewriteSourceConditions(source: string, condition: string): string {
  // Tokenize just enough JSONC to retain comments and unrelated string values.
  const tokens = [
    ...source.matchAll(
      /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[{}[\]:,]/g,
    ),
  ].filter((token) => !token[0].startsWith('//') && !token[0].startsWith('/*'));
  const replacements: { start: number; end: number }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (
      tokens[index][0] !== '"customConditions"' ||
      tokens[index + 1]?.[0] !== ':' ||
      tokens[index + 2]?.[0] !== '['
    )
      continue;
    let depth = 1;
    for (let member = index + 3; member < tokens.length && depth; member++) {
      const token = tokens[member];
      if (token[0] === '[' || token[0] === '{') depth++;
      else if (token[0] === ']' || token[0] === '}') depth--;
      else if (
        depth === 1 &&
        token[0].startsWith('"') &&
        JSON.parse(token[0]) === '@org/source'
      )
        replacements.push({
          start: token.index,
          end: token.index + token[0].length,
        });
    }
  }
  for (const replacement of replacements.reverse())
    source =
      source.slice(0, replacement.start) +
      JSON.stringify(condition) +
      source.slice(replacement.end);
  return source;
}

/** Only fresh scaffold identity fields are normalized, never arbitrary text. */
async function configureWorkspaceIdentity(plan: CreationPlan): Promise<void> {
  const root = plan.options.stagingDirectory;
  const condition = `@${plan.options.scope}/source`;
  const rewriteExports = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewriteExports);
    if (!value || typeof value !== 'object') return value;
    const entries = Object.entries(value);
    if (
      condition !== '@org/source' &&
      entries.some(([key]) => key === '@org/source') &&
      entries.some(([key]) => key === condition)
    )
      throw new CreateMegamonoError(
        `Generated exports contain conflicting source conditions: @org/source and ${condition}.`,
        3,
      );
    return Object.fromEntries(
      entries.map(([key, target]) => [
        key === '@org/source' ? condition : key,
        rewriteExports(target),
      ]),
    );
  };
  const excluded = new Set([
    'node_modules',
    '.git',
    '.nx',
    '.yalc',
    'dist',
    '.output',
    '.wxt',
  ]);
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) await walk(path);
      } else if (entry.isFile() && entry.name === 'package.json') {
        const source = await readFile(path, 'utf8');
        const manifest = JSON.parse(source);
        if (directory === root) {
          manifest.name = condition;
          manifest.engines = {
            ...manifest.engines,
            node: compatibility.toolchains.node,
          };
        }
        if (manifest.exports !== undefined)
          manifest.exports = rewriteExports(manifest.exports);
        const updated = `${JSON.stringify(manifest, null, 2)}\n`;
        if (source !== updated) await writeFile(path, updated, 'utf8');
      } else if (
        entry.isFile() &&
        /^tsconfig(?:\.[^.]+)*\.json$/.test(entry.name)
      ) {
        const source = await readFile(path, 'utf8');
        // Nx emits JSONC. Restrict edits to string entries of customConditions;
        // comments, paths, and ordinary strings remain byte-for-byte intact.
        const updated = rewriteSourceConditions(source, condition);
        if (source !== updated) await writeFile(path, updated, 'utf8');
      }
    }
  };
  await walk(root);
  await writeFile(
    resolve(root, '.nvmrc'),
    `${compatibility.runtimePins.node}\n`,
    'utf8',
  );
}

async function configurePackageManager(plan: CreationPlan): Promise<void> {
  const packagePath = resolve(plan.options.stagingDirectory, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    packageManager?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const nxVersion = requiredScaffoldVersion('nx');
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const declarations = packageJson[field];
    for (const name of Object.keys(declarations ?? {})) {
      if (name === 'nx' || name.startsWith('@nx/'))
        if (declarations)
          declarations[name] =
            compatibility.scaffoldPackages[name] ?? nxVersion;
    }
  }
  packageJson.packageManager = `${plan.options.packageManager}@${compatibility.packageManagers[plan.options.packageManager]}`;
  await writeFile(
    packagePath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  );

  await configureWorkspaceIdentity(plan);

  if (plan.options.packageManager !== 'pnpm') return;
  const policy = await readAllowBuilds(plan);
  for (const name of megamonoBuildApprovals(plan)) {
    // Existing decisions belong to the scaffold/policy, including explicit denial.
    if (!policy.entries.has(name)) policy.entries.set(name, 'true');
  }
  await writeAllowBuilds(policy);
}

function megamonoBuildApprovals(plan: CreationPlan): string[] {
  return [
    ...compatibility.pnpmAllowBuilds,
    ...(compatibility.databaseAdapters[plan.options.databaseAdapter]
      ?.pnpmAllowBuilds ?? []),
  ];
}

interface AllowBuildsPolicy {
  path: string;
  lines: string[];
  newline: string;
  start: number;
  end: number;
  entries: Map<string, string>;
}

async function readAllowBuilds(plan: CreationPlan): Promise<AllowBuildsPolicy> {
  const path = resolve(plan.options.stagingDirectory, 'pnpm-workspace.yaml');
  const source = await readFile(path, 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  let start = lines.findIndex((line) => /^allowBuilds:\s*$/.test(line));
  if (start === -1) {
    while (lines.at(-1) === '') lines.pop();
    lines.push('', 'allowBuilds:');
    start = lines.length - 1;
  }
  let end = start + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  const entries = new Map<string, string>();
  for (const line of lines.slice(start + 1, end)) {
    const entry = allowBuildsEntry(line);
    if (entry) entries.set(entry[0], entry[1]);
  }
  return { path, lines, newline, start, end, entries };
}

function allowBuildsEntry(line: string): [string, string] | undefined {
  const match = line.match(/^\s{2}([^:#]+):\s*(.+)$/);
  if (!match) return undefined;
  const rawKey = match[1].trim();
  const key = rawKey.startsWith('"')
    ? JSON.parse(rawKey)
    : rawKey.replace(/^'(.*)'$/, '$1');
  return [key, match[2].trim()];
}

async function writeAllowBuilds(policy: AllowBuildsPolicy): Promise<void> {
  const lines = [...policy.lines];
  lines.splice(
    policy.start + 1,
    policy.end - policy.start - 1,
    ...[...policy.entries]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => {
        const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
        return `  ${key}: ${value}`;
      }),
  );
  await writeFile(policy.path, lines.join(policy.newline), 'utf8');
}

/** Package names the pnpm lockfile resolves (packages/snapshots keys). */
export function lockfilePackageNames(lockfile: string): Set<string> {
  const names = new Set<string>();
  for (const match of lockfile.matchAll(
    /^ {2}['"]?((?:@[^@'"\s/]+\/)?[^@'"\s/:]+)@/gm,
  ))
    names.add(match[1]);
  return names;
}

/**
 * Bootstrap pre-approves every build Megamono may need before anything is
 * installed. Once the final install has settled, drop the approvals Megamono
 * added for packages the lockfile does not contain (for example workerd when
 * no Worker app exists). Denials and other decisions are kept.
 */
async function pruneBuildApprovals(plan: CreationPlan): Promise<void> {
  let lockfile: string;
  try {
    lockfile = await readFile(
      resolve(plan.options.stagingDirectory, 'pnpm-lock.yaml'),
      'utf8',
    );
  } catch {
    return;
  }
  const installed = lockfilePackageNames(lockfile);
  if (installed.size === 0) return;
  const policy = await readAllowBuilds(plan);
  const stale = new Set(
    megamonoBuildApprovals(plan).filter(
      (name) => policy.entries.get(name) === 'true' && !installed.has(name),
    ),
  );
  if (stale.size === 0) return;
  // Remove only the stale lines so formatting applied by later steps survives.
  const lines = policy.lines.filter((line, index) => {
    if (index <= policy.start || index >= policy.end) return true;
    const entry = allowBuildsEntry(line);
    return !entry || !stale.has(entry[0]);
  });
  await writeFile(policy.path, lines.join(policy.newline), 'utf8');
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
    'The requested destination was not populated. Inspect this staging directory, then either:',
    '',
    `- rerun \`create-megamono ${/^[\w.-]+$/.test(plan.options.name) ? plan.options.name : JSON.stringify(plan.options.name)} --resume\`${plan.options.destination === resolve(dirname(plan.options.stagingDirectory), plan.options.scope) ? '' : ` with \`--directory=${plan.options.destination}\``} from ${dirname(plan.options.destination)} to rerun the failed step and continue with the recorded options, or`,
    '- move or remove this directory before starting over.',
    '',
    `${CREATION_STATE_FILE} records the options and completed steps for --resume; edit neither file by hand.`,
    '',
  ].join('\n');
  const state: CreationState = {
    schemaVersion: 1,
    options: { ...plan.options, dryRun: false },
    steps: plan.steps.map((step) => step.id),
    completed: [...completed],
    failure: message,
  };
  await writeFile(
    resolve(plan.options.stagingDirectory, CREATION_STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    resolve(plan.options.stagingDirectory, RECOVERY_FILE),
    body,
    'utf8',
  );
}

/**
 * Rebuild the plan recorded by a failed run. Options come from the state file,
 * so a resumed run cannot silently diverge from the staged workspace.
 */
export async function loadResumePlan(
  input: Pick<CreateMegamonoInput, 'name' | 'directory' | 'cwd' | 'dryRun'>,
): Promise<CreationPlan> {
  const name = input.name?.trim();
  if (!name)
    throw new CreateMegamonoError('--resume requires the workspace name.', 2);
  const scope = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cwd = resolve(input.cwd ?? process.cwd());
  const destination = resolve(cwd, input.directory ?? scope);
  const stagingDirectory = resolve(
    dirname(destination),
    `megamono-${scope}-staging`,
  );
  let state: CreationState;
  try {
    state = JSON.parse(
      await readFile(resolve(stagingDirectory, CREATION_STATE_FILE), 'utf8'),
    ) as CreationState;
  } catch (error) {
    throw new CreateMegamonoError(
      `No resumable creation state in ${stagingDirectory}${error instanceof Error && 'code' in error && error.code === 'ENOENT' ? '' : ` (${error instanceof Error ? error.message : String(error)})`}. Only failures recorded by this version of create-megamono can be resumed.`,
      3,
    );
  }
  if (
    state.schemaVersion !== 1 ||
    !state.options ||
    !Array.isArray(state.steps) ||
    !Array.isArray(state.completed)
  )
    throw new CreateMegamonoError(
      `Unsupported creation state in ${stagingDirectory}.`,
      3,
    );
  if (
    state.options.stagingDirectory !== stagingDirectory ||
    state.options.destination !== destination
  )
    throw new CreateMegamonoError(
      `Recorded destination ${state.options.destination} does not match ${destination}. Resume from the original directory with the original name and --directory.`,
      3,
    );
  const plan = createPlan({
    ...state.options,
    cleanupOnFailure: false,
    dryRun: input.dryRun ?? false,
  });
  const steps = plan.steps.map((step) => step.id);
  if (JSON.stringify(steps) !== JSON.stringify(state.steps))
    throw new CreateMegamonoError(
      'The recorded creation plan differs from the plan this create-megamono version produces. Resume with the version that started the creation, or remove the staging directory and start over.',
      3,
    );
  const prefix = steps.slice(0, state.completed.length);
  if (JSON.stringify(prefix) !== JSON.stringify(state.completed))
    throw new CreateMegamonoError(
      `Recorded completed steps are not a prefix of the plan in ${stagingDirectory}.`,
      3,
    );
  if (state.completed.length === 0)
    throw new CreateMegamonoError(
      `No step completed before the failure (${state.failure}). Remove ${stagingDirectory} and rerun without --resume.`,
      3,
    );
  if (state.completed.includes('commit-workspace'))
    throw new CreateMegamonoError(
      `The workspace was already committed to ${destination}; nothing to resume.`,
      3,
    );
  plan.resumedSteps = state.completed;
  return plan;
}

async function commitWorkspace(plan: CreationPlan): Promise<void> {
  const { destination, stagingDirectory } = plan.options;
  // Recovery state describes the staging directory, never the committed workspace.
  for (const file of [CREATION_STATE_FILE, RECOVERY_FILE])
    await rm(resolve(stagingDirectory, file), { force: true });
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

export async function configurePublishablePackages(
  plan: CreationPlan,
): Promise<void> {
  for (const name of plan.options.packages) {
    const path = resolve(
      plan.options.stagingDirectory,
      'packages',
      name,
      'package.json',
    );
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (
      manifest.name !== `@${plan.options.packageScope}/${name}` ||
      manifest.private === true
    )
      throw new CreateMegamonoError(
        `Generated package ${name} does not match the requested publishable package.`,
        3,
      );
    manifest.publishConfig = {
      ...manifest.publishConfig,
      access: plan.options.packageAccess,
    };
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  // Nx's publishable-library generator adds a workspace-root registry target.
  // Identify that tooling project explicitly; it is not an application.
  const rootPath = resolve(plan.options.stagingDirectory, 'package.json');
  const root = JSON.parse(await readFile(rootPath, 'utf8'));
  root.nx = { ...root.nx, projectType: 'library' };
  await writeFile(rootPath, `${JSON.stringify(root, null, 2)}\n`);
  const nxPath = resolve(plan.options.stagingDirectory, 'nx.json');
  const nx = JSON.parse(await readFile(nxPath, 'utf8'));
  const projects = plan.options.packages.map(
    (name) => `${plan.options.scope}-${name}`,
  );
  nx.release = {
    ...nx.release,
    projects,
    version: {
      ...nx.release?.version,
      preVersionCommand: [
        plan.options.packageManager,
        ...nxArgs(plan.options.packageManager, [
          'run-many',
          '-t',
          'build',
          `--projects=${projects.join(',')}`,
        ]),
      ].join(' '),
    },
  };
  await writeFile(nxPath, `${JSON.stringify(nx, null, 2)}\n`);
}

export async function executePlan(
  plan: CreationPlan,
  runner: CommandRunner = runCommand,
  springbarConfigurator: SpringbarConfigurator = configureSpringbarWithMcp,
  yalcStoreResolver: YalcStoreResolver = resolveYalcStore,
): Promise<void> {
  await preflightPlan(plan, yalcStoreResolver);
  if (plan.options.dryRun) return;
  const completed: string[] = [...(plan.resumedSteps ?? [])];
  try {
    for (const step of plan.steps.slice(completed.length)) {
      if (step.kind === 'commit') await commitWorkspace(plan);
      else if (step.kind === 'configure') {
        if (step.id === 'configure-package-manager')
          await configurePackageManager(plan);
        else if (step.id === 'configure-workspace-identity')
          await configureWorkspaceIdentity(plan);
        else if (step.id === 'configure-publishable-packages')
          await configurePublishablePackages(plan);
        else if (step.id === 'prune-build-approvals')
          await pruneBuildApprovals(plan);
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
  const plan = input.resume
    ? await loadResumePlan(input)
    : createPlan(normalizeCreateOptions(input));
  await executePlan(plan, runner, springbarConfigurator, yalcStoreResolver);
  return plan;
}
