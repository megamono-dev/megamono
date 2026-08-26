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

export const APP_IDS = [
  'web',
  'api',
  'worker',
  'mobile',
  'desktop',
  'apple',
  'site',
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
export const PACKAGE_MANAGERS = ['pnpm', 'npm'] as const;

export type AppId = (typeof APP_IDS)[number];
export type ServiceId = (typeof SERVICE_IDS)[number];
export type VerifyMode = (typeof VERIFY_MODES)[number];
export type ServiceRunner = (typeof SERVICE_RUNNERS)[number];
export type LocalPackageSource = (typeof LOCAL_PACKAGE_SOURCES)[number];
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface CreateMegamonoInput {
  name?: string;
  directory?: string;
  apps?: readonly string[];
  services?: readonly string[];
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
  services: ServiceId[];
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
        | 'configure-api'
        | 'configure-desktop'
        | 'configure-mobile'
        | 'configure-theme'
        | 'configure-site'
        | 'configure-web';
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
    readonly exitCode: 1 | 2 | 3 | 4,
  ) {
    super(message);
    this.name = 'CreateMegamonoError';
  }
}

interface CompatibilityRegistry {
  packageManagers: Record<PackageManager, string>;
  pnpmAllowBuilds: string[];
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

const appPlugin: Partial<Record<AppId, string>> = {
  web: '@nx/next',
  api: '@nx/nest',
  worker: '@megamono/nx-cloudflare',
  mobile: '@nx/expo',
  site: '@nx/next',
};

const appGenerator: Record<
  Exclude<AppId, 'desktop'>,
  { plugin: string; generator: string; extra: string[] }
> = {
  web: {
    plugin: '@nx/next',
    generator: 'application',
    extra: [
      '--directory=apps/web',
      '--appDir=false',
      '--src=true',
      '--style=none',
      '--linter=eslint',
      '--unitTestRunner=none',
      '--e2eTestRunner=playwright',
    ],
  },
  api: {
    plugin: '@nx/nest',
    generator: 'application',
    extra: [
      '--directory=apps/api',
      '--linter=eslint',
      '--unitTestRunner=none',
      '--e2eTestRunner=jest',
    ],
  },
  worker: {
    plugin: '@megamono/nx-cloudflare',
    generator: 'worker',
    extra: ['--directory=apps/worker'],
  },
  mobile: {
    plugin: '@nx/expo',
    generator: 'application',
    extra: ['--directory=apps/mobile', '--e2eTestRunner=none'],
  },
  apple: {
    plugin: '@megamono/nx-apple',
    generator: 'application',
    extra: ['--directory=apps/apple'],
  },
  site: {
    plugin: '@nx/next',
    generator: 'application',
    extra: [
      '--directory=apps/site',
      '--appDir=false',
      '--src=true',
      '--style=none',
      '--linter=eslint',
      '--unitTestRunner=none',
      '--e2eTestRunner=playwright',
    ],
  },
};

function normalizedList(values: readonly string[] | undefined): string[] {
  return [
    ...new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  ].sort();
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

  const apps = normalizedList(input.apps);
  if (apps.length === 0) {
    throw new CreateMegamonoError(
      'At least one app is required when interactive mode cannot resolve --apps.',
      4,
    );
  }
  const unknownApps = apps.filter((app) => !APP_SET.has(app));
  if (unknownApps.length > 0) {
    throw new CreateMegamonoError(
      `Unknown app selection(s): ${unknownApps.join(', ')}.`,
      2,
    );
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
  if (input.install === false) {
    throw new CreateMegamonoError(
      '--install=false is reserved until the bundled no-install generation path passes fixtures.',
      3,
    );
  }
  const unavailableServices = services.filter(
    (service) => service !== 'postgres',
  );
  if (unavailableServices.length > 0) {
    throw new CreateMegamonoError(
      `No tested compatibility pin exists yet for: ${unavailableServices.join(', ')}.`,
      3,
    );
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
    apps: apps as AppId[],
    services: services as ServiceId[],
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
      input.packageManager ?? 'pnpm',
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
  return packageManager === 'pnpm'
    ? ['exec', 'nx', ...args]
    : ['exec', 'nx', '--', ...args];
}

function packageInstallArgs(
  packageManager: PackageManager,
  packages: readonly string[] = [],
): string[] {
  return packageManager === 'pnpm'
    ? packages.length > 0
      ? ['add', '--save-dev', '--save-exact', ...packages]
      : ['install']
    : packages.length > 0
      ? ['install', '--save-dev', '--save-exact', ...packages]
      : ['install'];
}

function scaffoldArgs(
  packageManager: PackageManager,
  packageName: string,
  args: readonly string[],
): string[] {
  return packageManager === 'pnpm'
    ? ['dlx', packageName, ...args]
    : ['exec', '--yes', packageName, '--', ...args];
}

function requestedPlatforms(options: NormalizedCreateOptions): string[] {
  return [
    ...new Set(
      options.apps.map((app) => {
        if (app === 'api') return 'node';
        if (app === 'worker') return 'worker';
        if (app === 'desktop') return 'rust';
        if (app === 'apple') return 'apple';
        return 'web';
      }),
    ),
  ].sort();
}

function generatedE2eProjects(options: NormalizedCreateOptions): string[] {
  return options.apps
    .filter((app) => app === 'api' || app === 'site' || app === 'web')
    .map((app) => `${options.scope}-${app}-e2e`);
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
        `--skipInstall=${String(!options.install)}`,
      ]),
      'parent',
    ),
    { kind: 'configure', id: 'configure-package-manager' },
  ];

  const plugins = new Set<string>(['@megamono/plugin', 'typescript']);
  for (const app of options.apps) {
    const plugin = appPlugin[app];
    if (plugin) plugins.add(plugin);
    if (app === 'api') plugins.add('@nx/jest');
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
  }
  if (options.install) {
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
  }

  if (options.apps.includes('site') || options.apps.includes('web')) {
    steps.push(
      commandStep(
        'generate-theme',
        options.packageManager,
        nxArgs(options.packageManager, [
          'generate',
          '@nx/js:library',
          `--name=${options.scope}-theme`,
          '--directory=packages/theme',
          '--bundler=none',
          '--linter=eslint',
          '--unitTestRunner=none',
          '--strict=true',
          '--minimal=true',
          '--tags=platform:web,scope:shared,type:ui',
          '--interactive=false',
          '--skipFormat',
        ]),
        'staging',
      ),
      { kind: 'configure', id: 'configure-theme' },
    );
  }

  for (const app of options.apps) {
    if (app === 'desktop') {
      steps.push(
        commandStep(
          'generate-desktop',
          options.packageManager,
          scaffoldArgs(options.packageManager, packagePin('create-tauri-app'), [
            'apps/desktop',
            '--manager',
            options.packageManager,
            '--template',
            'vanilla-ts',
            '--identifier',
            `com.${options.scope}.desktop`,
            '--tauri-version',
            '2',
            '--yes',
          ]),
          'staging',
        ),
      );
      steps.push({ kind: 'configure', id: 'configure-desktop' });
      if (options.install) {
        steps.push(
          commandStep(
            'install-desktop-dependencies',
            options.packageManager,
            packageInstallArgs(options.packageManager),
            'staging',
          ),
        );
      }
      continue;
    }
    const definition = appGenerator[app];
    const platform =
      app === 'api'
        ? 'node'
        : app === 'worker'
          ? 'worker'
          : app === 'apple'
            ? 'apple'
            : 'web';
    const appleOptions =
      app === 'apple'
        ? [
            `--displayName=${options.name}`,
            `--bundleIdentifier=com.${options.scope}.apple`,
            `--scope=${options.scope}`,
          ]
        : [];
    const appExtra =
      app === 'worker'
        ? [...definition.extra, `--scope=${options.scope}`]
        : definition.extra;
    steps.push(
      commandStep(
        `generate-${app}`,
        options.packageManager,
        nxArgs(options.packageManager, [
          'generate',
          `${definition.plugin}:${definition.generator}`,
          `--name=${options.scope}-${app}`,
          ...appExtra,
          ...appleOptions,
          `--tags=platform:${platform},scope:${options.scope},type:app,visibility:internal`,
          '--interactive=false',
          '--skipFormat',
        ]),
        'staging',
      ),
    );
    if (app === 'api') steps.push({ kind: 'configure', id: 'configure-api' });
    if (app === 'mobile')
      steps.push({ kind: 'configure', id: 'configure-mobile' });
    if (app === 'site') steps.push({ kind: 'configure', id: 'configure-site' });
    if (app === 'web') steps.push({ kind: 'configure', id: 'configure-web' });
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
        '--only=docs,agents,ci,lint,skills,health,inference',
        '--yes',
        '--bootstrap',
        `--platforms=${requestedPlatforms(options).join(',')}`,
        `--serviceRunner=${options.serviceRunner}`,
        `--serviceRequirements=${JSON.stringify(requestedServiceRequirements(options))}`,
        `--packageManager=${options.packageManager}`,
        '--interactive=false',
      ]),
      'staging',
    ),
  );

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
        nxArgs(options.packageManager, ['format:write']),
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
  }
  if (options.verify === 'build') {
    steps.push(
      commandStep(
        'verify-generated-projects',
        options.packageManager,
        nxArgs(options.packageManager, [
          'run-many',
          '--targets=build,test,lint',
          `--projects=${options.apps.map((app) => `${options.scope}-${app}`).join(',')}`,
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
        if (step.id === 'configure-desktop')
          return `${index + 1}. [staging] normalize apps/desktop and register @megamono/nx-cargo`;
        if (step.id === 'configure-theme')
          return `${index + 1}. [staging] configure the shared Chakra UI system`;
        if (
          step.id === 'configure-mobile' ||
          step.id === 'configure-api' ||
          step.id === 'configure-site' ||
          step.id === 'configure-web'
        ) {
          const app = step.id.replace('configure-', '');
          return `${index + 1}. [staging] normalize apps/${app} as an application project`;
        }
        return `${index + 1}. [staging] configure megamono.json`;
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

function requiredRustCrateVersion(name: string): string {
  const version = compatibility.rustCrates[name];
  if (!version) {
    throw new CreateMegamonoError(
      `No tested compatibility pin exists for Rust crate ${name}.`,
      3,
    );
  }
  return `=${version}`;
}

function replaceRequired(
  source: string,
  pattern: RegExp,
  replacement: string,
  label: string,
): string {
  if (!pattern.test(source)) {
    throw new CreateMegamonoError(
      `The generated Desktop scaffold is missing the expected ${label}.`,
      3,
    );
  }
  return source.replace(pattern, replacement);
}

async function registerPnpmWorkspace(
  stagingDirectory: string,
  workspacePattern: string,
): Promise<void> {
  const workspacePath = resolve(stagingDirectory, 'pnpm-workspace.yaml');
  const source = await readFile(workspacePath, 'utf8');
  const escapedPattern = workspacePattern.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  const existingPattern = new RegExp(
    `^\\s*-\\s*['"]?${escapedPattern}['"]?\\s*(?:#.*)?$`,
    'm',
  );
  if (existingPattern.test(source)) return;

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const packagesIndex = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (packagesIndex === -1) {
    throw new CreateMegamonoError(
      'The generated pnpm workspace is missing a supported packages list.',
      3,
    );
  }
  let insertionIndex = packagesIndex + 1;
  while (
    insertionIndex < lines.length &&
    /^\s+\S/.test(lines[insertionIndex])
  ) {
    insertionIndex += 1;
  }
  lines.splice(insertionIndex, 0, `  - '${workspacePattern}'`);
  await writeFile(workspacePath, lines.join(newline), 'utf8');
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
    if (match) entries.set(match[1].trim(), match[2].trim());
  }
  for (const name of compatibility.pnpmAllowBuilds) entries.set(name, 'true');
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

async function configureDesktop(plan: CreationPlan): Promise<void> {
  const desktopRoot = resolve(plan.options.stagingDirectory, 'apps/desktop');
  const projectName = `${plan.options.scope}-desktop`;
  const crateLibName = `${projectName.replaceAll('-', '_')}_lib`;

  const packagePath = resolve(desktopRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    name?: string;
    private?: boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  packageJson.name = projectName;
  packageJson.private = true;
  packageJson.dependencies = {
    ...packageJson.dependencies,
    '@tauri-apps/api': requiredScaffoldVersion('@tauri-apps/api'),
    '@tauri-apps/plugin-opener': requiredScaffoldVersion(
      '@tauri-apps/plugin-opener',
    ),
  };
  packageJson.devDependencies = {
    ...packageJson.devDependencies,
    '@tauri-apps/cli': requiredScaffoldVersion('@tauri-apps/cli'),
    typescript: requiredScaffoldVersion('typescript'),
    vite: requiredScaffoldVersion('vite'),
  };
  await writeFile(
    packagePath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  );

  const cargoPath = resolve(desktopRoot, 'src-tauri/Cargo.toml');
  let cargo = await readFile(cargoPath, 'utf8');
  cargo = replaceRequired(
    cargo,
    /(\[package\][\s\S]*?\nname\s*=\s*)"[^"]+"/,
    `$1"${projectName}"`,
    'Cargo package name',
  );
  cargo = replaceRequired(
    cargo,
    /(\[lib\][\s\S]*?\nname\s*=\s*)"[^"]+"/,
    `$1"${crateLibName}"`,
    'Cargo library name',
  );
  cargo = replaceRequired(
    cargo,
    /^(tauri-build\s*=\s*\{\s*version\s*=\s*)"[^"]+"/m,
    `$1"${requiredRustCrateVersion('tauri-build')}"`,
    'tauri-build dependency',
  );
  cargo = replaceRequired(
    cargo,
    /^(tauri\s*=\s*\{\s*version\s*=\s*)"[^"]+"/m,
    `$1"${requiredRustCrateVersion('tauri')}"`,
    'tauri dependency',
  );
  cargo = replaceRequired(
    cargo,
    /^(tauri-plugin-opener\s*=\s*)"[^"]+"/m,
    `$1"${requiredRustCrateVersion('tauri-plugin-opener')}"`,
    'tauri-plugin-opener dependency',
  );
  cargo = replaceRequired(
    cargo,
    /^(serde\s*=\s*\{\s*version\s*=\s*)"[^"]+"/m,
    `$1"${requiredRustCrateVersion('serde')}"`,
    'serde dependency',
  );
  cargo = replaceRequired(
    cargo,
    /^(serde_json\s*=\s*)"[^"]+"/m,
    `$1"${requiredRustCrateVersion('serde_json')}"`,
    'serde_json dependency',
  );
  await writeFile(cargoPath, cargo, 'utf8');

  const mainPath = resolve(desktopRoot, 'src-tauri/src/main.rs');
  let main = await readFile(mainPath, 'utf8');
  main = replaceRequired(
    main,
    /\b[A-Za-z_][A-Za-z0-9_]*_lib::run\(\)/,
    `${crateLibName}::run()`,
    'Cargo binary library entry point',
  );
  await writeFile(mainPath, main, 'utf8');

  const tauriConfigPath = resolve(desktopRoot, 'src-tauri/tauri.conf.json');
  const tauriConfig = JSON.parse(await readFile(tauriConfigPath, 'utf8')) as {
    productName?: string;
    identifier?: string;
    app?: { windows?: Array<Record<string, unknown>> };
  };
  tauriConfig.productName = projectName;
  tauriConfig.identifier = `com.${plan.options.scope}.desktop`;
  for (const window of tauriConfig.app?.windows ?? []) {
    window.title = projectName;
  }
  await writeFile(
    tauriConfigPath,
    `${JSON.stringify(tauriConfig, null, 2)}\n`,
    'utf8',
  );

  const rootPackagePath = resolve(
    plan.options.stagingDirectory,
    'package.json',
  );
  const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8')) as {
    workspaces?: unknown;
    devDependencies?: Record<string, string>;
  };
  if (plan.options.packageManager === 'npm') {
    if (
      rootPackage.workspaces !== undefined &&
      !Array.isArray(rootPackage.workspaces)
    ) {
      throw new CreateMegamonoError(
        'The generated workspace uses an unsupported non-array npm workspaces configuration.',
        3,
      );
    }
    rootPackage.workspaces = [
      ...new Set([...(rootPackage.workspaces ?? []), 'apps/*']),
    ].sort();
  } else {
    await registerPnpmWorkspace(plan.options.stagingDirectory, 'apps/*');
  }
  rootPackage.devDependencies = {
    ...rootPackage.devDependencies,
    vite: requiredScaffoldVersion('vite'),
  };
  await writeFile(
    rootPackagePath,
    `${JSON.stringify(rootPackage, null, 2)}\n`,
    'utf8',
  );

  const nxPath = resolve(plan.options.stagingDirectory, 'nx.json');
  const nxJson = JSON.parse(await readFile(nxPath, 'utf8')) as {
    plugins?: Array<
      string | { plugin: string; options?: Record<string, unknown> }
    >;
  };
  nxJson.plugins ??= [];
  const cargoPlugin = nxJson.plugins.findIndex((entry) =>
    typeof entry === 'string'
      ? entry === '@megamono/nx-cargo'
      : entry.plugin === '@megamono/nx-cargo',
  );
  const cargoPluginEntry = {
    plugin: '@megamono/nx-cargo',
    options: {
      scope: plan.options.scope,
      tauriTargetName: 'tauri-build',
    },
  };
  if (cargoPlugin === -1) nxJson.plugins.push(cargoPluginEntry);
  else nxJson.plugins[cargoPlugin] = cargoPluginEntry;
  await writeFile(nxPath, `${JSON.stringify(nxJson, null, 2)}\n`, 'utf8');
}

async function configurePackageApplication(
  plan: CreationPlan,
  app: 'api' | 'mobile' | 'site' | 'web',
): Promise<void> {
  const packagePath = resolve(
    plan.options.stagingDirectory,
    `apps/${app}/package.json`,
  );
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    name?: string;
    dependencies?: Record<string, string>;
    nx?: Record<string, unknown>;
  };
  packageJson.name = `@${plan.options.scope}/${app}`;
  packageJson.nx ??= {};
  packageJson.nx.projectType = 'application';
  if (app === 'site' || app === 'web') {
    packageJson.dependencies = {
      ...packageJson.dependencies,
      '@chakra-ui/react': requiredScaffoldVersion('@chakra-ui/react'),
      [`@${plan.options.scope}/theme`]:
        plan.options.packageManager === 'pnpm' ? 'workspace:*' : '*',
    };
  }
  await writeFile(
    packagePath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  );

  if (app === 'mobile') {
    const sourcePath = resolve(
      plan.options.stagingDirectory,
      'apps/mobile/src/app/App.tsx',
    );
    const source = await readFile(sourcePath, 'utf8');
    await writeFile(
      sourcePath,
      source.replace(
        /^\/\* eslint-disable jsx-a11y\/accessible-emoji \*\/\r?\n/,
        '',
      ),
      'utf8',
    );
  }

  if (app === 'site' || app === 'web') {
    await rm(
      resolve(
        plan.options.stagingDirectory,
        `apps/${app}/src/pages/index.module.none`,
      ),
      { force: true },
    );
    await rm(
      resolve(
        plan.options.stagingDirectory,
        `apps/${app}/src/pages/styles.css`,
      ),
      { force: true },
    );
    await writeFile(
      resolve(plan.options.stagingDirectory, `apps/${app}/src/pages/_app.tsx`),
      `import { ChakraProvider } from '@chakra-ui/react';
import { megamonoSystem } from '@${plan.options.scope}/theme';
import type { AppProps } from 'next/app';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <ChakraProvider value={megamonoSystem}>
      <Component {...pageProps} />
    </ChakraProvider>
  );
}
`,
      'utf8',
    );
    await writeFile(
      resolve(plan.options.stagingDirectory, `apps/${app}/src/pages/index.tsx`),
      billboardPageSource(plan, app),
      'utf8',
    );
    const e2eRoot = resolve(
      plan.options.stagingDirectory,
      `apps/${app}-e2e/src`,
    );
    await mkdir(e2eRoot, { recursive: true });
    await writeFile(
      resolve(e2eRoot, 'example.spec.ts'),
      billboardE2eSource(plan, app),
      'utf8',
    );
  }
  if (app === 'api' || app === 'site' || app === 'web') {
    await configureE2ePackage(plan, app);
  }
}

async function configureE2ePackage(
  plan: CreationPlan,
  app: 'api' | 'site' | 'web',
): Promise<void> {
  const packagePath = resolve(
    plan.options.stagingDirectory,
    `apps/${app}-e2e/package.json`,
  );
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    name?: string;
    nx?: Record<string, unknown>;
  };
  packageJson.name = `@${plan.options.scope}/${app}-e2e`;
  packageJson.nx ??= {};
  packageJson.nx.name = `${plan.options.scope}-${app}-e2e`;
  packageJson.nx.projectType = 'application';
  packageJson.nx.tags = [
    `platform:${app === 'api' ? 'node' : 'web'}`,
    `scope:${plan.options.scope}`,
    'type:app',
    'visibility:internal',
  ];
  await writeFile(
    packagePath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  );
}

const appLabels: Record<AppId, string> = {
  web: 'Web app',
  api: 'Nest API',
  worker: 'Cloudflare Worker',
  mobile: 'Expo mobile app',
  desktop: 'Tauri desktop app',
  apple: 'Apple native app',
  site: 'Marketing site',
};

function billboardPageSource(plan: CreationPlan, app: 'site' | 'web'): string {
  const nx =
    plan.options.packageManager === 'pnpm' ? 'pnpm exec nx' : 'npm exec nx --';
  const commands = [
    `${nx} show projects`,
    `${nx} graph`,
    `${nx} run megamono:check`,
  ];
  const surfaces = plan.options.apps.map((surface) => appLabels[surface]);
  const services = plan.options.services.map((service) =>
    service === 'postgres' ? 'PostgreSQL' : service,
  );
  const tools = [
    {
      name: 'Megamono',
      description:
        'Structure the repository, preserve architectural boundaries, and keep human and agent work aligned.',
      href: 'https://megamono.com',
      cta: 'Explore Megamono',
    },
    {
      name: 'Playstack',
      description:
        'Compose application capabilities from portable contracts and explicit framework adapters.',
      href: 'https://playstack.dev',
      cta: 'Explore Playstack',
    },
    {
      name: 'Springbar',
      description:
        plan.options.serviceRunner === 'springbar'
          ? 'Run this workspace and its requested local services through the Springbar development environment.'
          : 'Run applications and local services together when this workspace is ready for orchestration.',
      href: 'https://springbar.app',
      cta: 'Explore Springbar',
    },
    {
      name: 'Commune Software',
      description:
        'Independent development tools for building, operating, and growing thoughtful software products.',
      href: 'https://www.commune.software',
      cta: 'Visit Commune Software',
    },
  ];
  return `import {
  Badge,
  Box,
  Code,
  Container,
  Flex,
  Heading,
  Link,
  SimpleGrid,
  Stack,
  Text,
} from '@chakra-ui/react';
import Head from 'next/head';

const workspaceName = ${JSON.stringify(plan.options.name)};
const surfaceName = ${JSON.stringify(appLabels[app])};
const surfaces: string[] = ${JSON.stringify(surfaces)};
const services: string[] = ${JSON.stringify(services)};
const commands = ${JSON.stringify(commands)};
const workflow = [
  {
    title: 'Start with intent',
    description:
      'Read docs/DESIGN.md and docs/INDEX.md before changing structure or product direction.',
  },
  {
    title: 'Compose at the edges',
    description:
      'Keep applications thin composition roots. Put reusable product behavior in tagged libraries.',
  },
  {
    title: 'Generate structure',
    description:
      'Use Megamono and Nx generators for projects and integrations so conventions stay encoded.',
  },
  {
    title: 'Validate before commit',
    description:
      'Run lint, tests, and megamono:check. Capture durable choices in specs, plans, and decisions.',
  },
] as const;
const tools = ${JSON.stringify(tools, null, 2)} as const;
const copy = {
  eyebrow: 'Commune development tools',
  title: \`${'${workspaceName}'} is ready to build.\`,
  summary:
    'Megamono has prepared an opinionated workspace for people and agents to build against the same architecture.',
  generatedSurface: \`This ${'${surfaceName.toLowerCase()}'} is repository-owned starter content. Replace it when your product is ready.\`,
  surfaces: 'Generated surfaces',
  services: 'Requested services',
  workflow: 'How to use Megamono',
  commands: 'Start exploring',
  tools: 'Keep building with Commune',
  toolsSummary:
    'Megamono, Playstack, and Springbar cover the repository, application, and local-development layers without hiding their boundaries.',
} as const;
const pageTitle = \`${'${workspaceName}'} · Built with Megamono\`;

export default function Index() {
  return (
    <>
      <Head>
        <title>{pageTitle}</title>
        <meta name="description" content={copy.summary} />
      </Head>
      <Box as="main" minH="100vh" bg="gray.950" color="gray.50">
        <Container maxW="7xl" py={{ base: '12', md: '20' }}>
          <Stack gap={{ base: '14', md: '20' }}>
            <Stack gap="6" maxW="5xl">
              <Badge
                alignSelf="flex-start"
                colorPalette="yellow"
                variant="surface"
              >
                {copy.eyebrow}
              </Badge>
              <Heading
                as="h1"
                fontSize={{ base: '4xl', md: '7xl' }}
                lineHeight="0.95"
                letterSpacing="tight"
              >
                {copy.title}
              </Heading>
              <Text color="gray.300" fontSize={{ base: 'lg', md: '2xl' }}>
                {copy.summary}
              </Text>
              <Text color="gray.500">{copy.generatedSurface}</Text>
            </Stack>

            <SimpleGrid columns={{ base: 1, md: 2 }} gap="6">
              <Box borderWidth="1px" borderColor="gray.800" rounded="2xl" p="7">
                <Heading as="h2" size="lg" mb="5">
                  {copy.surfaces}
                </Heading>
                <Flex gap="3" wrap="wrap">
                  {surfaces.map((surface) => (
                    <Badge key={surface} colorPalette="yellow" variant="outline">
                      {surface}
                    </Badge>
                  ))}
                </Flex>
              </Box>
              <Box borderWidth="1px" borderColor="gray.800" rounded="2xl" p="7">
                <Heading as="h2" size="lg" mb="5">
                  {copy.services}
                </Heading>
                <Flex gap="3" wrap="wrap">
                  {(services.length > 0 ? services : ['None requested']).map(
                    (service) => (
                      <Badge key={service} variant="outline">
                        {service}
                      </Badge>
                    ),
                  )}
                </Flex>
              </Box>
            </SimpleGrid>

            <Stack gap="8">
              <Heading as="h2" fontSize={{ base: '3xl', md: '5xl' }}>
                {copy.workflow}
              </Heading>
              <SimpleGrid columns={{ base: 1, md: 2 }} gap="6">
                {workflow.map((step, index) => (
                  <Box
                    key={step.title}
                    bg="gray.900"
                    borderWidth="1px"
                    borderColor="gray.800"
                    rounded="2xl"
                    p="7"
                  >
                    <Text color="yellow.300" fontFamily="mono" mb="4">
                      {String(index + 1).padStart(2, '0')}
                    </Text>
                    <Heading as="h3" size="lg" mb="3">
                      {step.title}
                    </Heading>
                    <Text color="gray.400">{step.description}</Text>
                  </Box>
                ))}
              </SimpleGrid>
            </Stack>

            <Stack gap="6">
              <Heading as="h2" fontSize={{ base: '3xl', md: '5xl' }}>
                {copy.commands}
              </Heading>
              <Stack gap="3">
                {commands.map((command) => (
                  <Code
                    key={command}
                    bg="black"
                    color="yellow.200"
                    display="block"
                    fontSize={{ base: 'sm', md: 'md' }}
                    px="5"
                    py="4"
                    rounded="xl"
                  >
                    {command}
                  </Code>
                ))}
              </Stack>
            </Stack>

            <Stack gap="8">
              <Stack gap="3" maxW="3xl">
                <Heading as="h2" fontSize={{ base: '3xl', md: '5xl' }}>
                  {copy.tools}
                </Heading>
                <Text color="gray.400" fontSize="lg">
                  {copy.toolsSummary}
                </Text>
              </Stack>
              <SimpleGrid columns={{ base: 1, md: 2 }} gap="6">
                {tools.map((tool) => (
                  <Stack
                    key={tool.name}
                    borderTopWidth="1px"
                    borderColor="gray.700"
                    gap="4"
                    pt="6"
                  >
                    <Heading as="h3" size="lg">
                      {tool.name}
                    </Heading>
                    <Text color="gray.400">{tool.description}</Text>
                    <Link
                      href={tool.href}
                      target="_blank"
                      rel="noreferrer"
                      color="yellow.300"
                      fontWeight="semibold"
                      width="fit-content"
                    >
                      {tool.cta}
                    </Link>
                  </Stack>
                ))}
              </SimpleGrid>
            </Stack>
          </Stack>
        </Container>
      </Box>
    </>
  );
}
`;
}

function billboardE2eSource(plan: CreationPlan, app: 'site' | 'web'): string {
  return `import { expect, test } from '@playwright/test';

test('introduces the workspace and Commune development tools', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByRole('heading', {
      level: 1,
      name: ${JSON.stringify(`${plan.options.name} is ready to build.`)},
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'How to use Megamono' }),
  ).toBeVisible();
  await expect(page.getByText(${JSON.stringify(appLabels[app])}, { exact: true })).toBeVisible();

  for (const [name, href] of [
    ['Explore Megamono', 'https://megamono.com'],
    ['Explore Playstack', 'https://playstack.dev'],
    ['Explore Springbar', 'https://springbar.app'],
    ['Visit Commune Software', 'https://www.commune.software'],
  ] as const) {
    await expect(page.getByRole('link', { name })).toHaveAttribute('href', href);
  }
});
`;
}

async function configureTheme(plan: CreationPlan): Promise<void> {
  const packagePath = resolve(
    plan.options.stagingDirectory,
    'packages/theme/package.json',
  );
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    name?: string;
    private?: boolean;
    dependencies?: Record<string, string>;
    nx?: Record<string, unknown>;
  };
  packageJson.name = `@${plan.options.scope}/theme`;
  packageJson.private = true;
  packageJson.dependencies = {
    ...packageJson.dependencies,
    '@chakra-ui/react': requiredScaffoldVersion('@chakra-ui/react'),
    '@emotion/react': requiredScaffoldVersion('@emotion/react'),
  };
  packageJson.nx ??= {};
  packageJson.nx.projectType = 'library';
  await writeFile(
    packagePath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  );

  await writeFile(
    resolve(plan.options.stagingDirectory, 'packages/theme/src/index.ts'),
    "export { megamonoSystem } from './lib/system';\n",
    'utf8',
  );
  await writeFile(
    resolve(plan.options.stagingDirectory, 'packages/theme/src/lib/system.ts'),
    `import { createSystem, defaultConfig, defineConfig } from '@chakra-ui/react';

const config = defineConfig({
  globalCss: {
    html: {
      bg: '{colors.gray.950}',
      colorPalette: 'yellow',
    },
    body: {
      bg: '{colors.gray.950}',
      color: '{colors.gray.50}',
    },
    '::selection': {
      bg: '{colors.yellow.300}',
      color: '{colors.gray.950}',
    },
  },
  theme: {
    semanticTokens: {
      colors: {
        accent: { value: '{colors.yellow.300}' },
        panel: { value: '{colors.gray.900}' },
      },
    },
  },
});

export const megamonoSystem = createSystem(defaultConfig, config);
`,
    'utf8',
  );
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
        else if (step.id === 'configure-desktop') await configureDesktop(plan);
        else if (step.id === 'configure-theme') await configureTheme(plan);
        else if (step.id === 'configure-api')
          await configurePackageApplication(plan, 'api');
        else if (step.id === 'configure-mobile')
          await configurePackageApplication(plan, 'mobile');
        else if (step.id === 'configure-site')
          await configurePackageApplication(plan, 'site');
        else if (step.id === 'configure-web')
          await configurePackageApplication(plan, 'web');
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
