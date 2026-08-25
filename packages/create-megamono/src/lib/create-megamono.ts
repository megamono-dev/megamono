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

export type AppId = (typeof APP_IDS)[number];
export type ServiceId = (typeof SERVICE_IDS)[number];
export type VerifyMode = (typeof VERIFY_MODES)[number];
export type ServiceRunner = (typeof SERVICE_RUNNERS)[number];

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
        | 'configure-desktop'
        | 'configure-mobile'
        | 'configure-site'
        | 'configure-web'
        | 'configure-worker';
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

const appPlugin: Partial<Record<AppId, string>> = {
  web: '@nx/next',
  api: '@nx/nest',
  worker: '@nx/js',
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
    extra: ['--directory=apps/web', '--appDir=false', '--e2eTestRunner=none'],
  },
  api: {
    plugin: '@nx/nest',
    generator: 'application',
    extra: ['--directory=apps/api', '--e2eTestRunner=none'],
  },
  worker: {
    plugin: '@nx/js',
    generator: 'library',
    extra: [
      '--directory=apps/worker',
      '--bundler=esbuild',
      '--linter=eslint',
      '--unitTestRunner=none',
      '--minimal',
      '--useProjectJson',
    ],
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
    extra: ['--directory=apps/site', '--appDir=false', '--e2eTestRunner=none'],
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
    platform,
  };
}

function commandStep(
  id: string,
  command: string,
  args: string[],
  cwd: 'parent' | 'staging',
): PlanStep {
  return { kind: 'command', id, command, args, cwd };
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
      'npm',
      [
        'exec',
        '--yes',
        packagePin('create-nx-workspace'),
        '--',
        basename(options.stagingDirectory),
        '--preset=ts',
        '--workspaceType=integrated',
        '--packageManager=npm',
        '--interactive=false',
        '--nxCloud=skip',
        '--skipGit',
        `--skipInstall=${String(!options.install)}`,
      ],
      'parent',
    ),
  ];

  const plugins = new Set<string>(['@megamono/plugin']);
  for (const app of options.apps) {
    const plugin = appPlugin[app];
    if (plugin) plugins.add(plugin);
    if (app === 'worker') {
      plugins.add('@nx/vitest');
      plugins.add('vite');
      plugins.add('vitest');
    }
    if (app === 'desktop') plugins.add('@megamono/nx-cargo');
    if (app === 'apple') plugins.add('@megamono/nx-apple');
  }
  if (options.install) {
    const packages = [...plugins].sort().map(packagePin);
    steps.push(
      commandStep(
        'install-plugins',
        'npm',
        ['install', '--save-dev', ...packages],
        'staging',
      ),
    );
  }

  for (const app of options.apps) {
    if (app === 'desktop') {
      steps.push(
        commandStep(
          'generate-desktop',
          'npm',
          [
            'exec',
            '--yes',
            packagePin('create-tauri-app'),
            '--',
            'apps/desktop',
            '--manager',
            'npm',
            '--template',
            'vanilla-ts',
            '--identifier',
            `com.${options.scope}.desktop`,
            '--tauri-version',
            '2',
            '--yes',
          ],
          'staging',
        ),
      );
      steps.push({ kind: 'configure', id: 'configure-desktop' });
      if (options.install) {
        steps.push(
          commandStep(
            'install-desktop-dependencies',
            'npm',
            ['install'],
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
    steps.push(
      commandStep(
        `generate-${app}`,
        'npm',
        [
          'exec',
          'nx',
          '--',
          'generate',
          `${definition.plugin}:${definition.generator}`,
          `--name=${options.scope}-${app}`,
          ...definition.extra,
          ...appleOptions,
          `--tags=platform:${platform},scope:${options.scope},type:app,visibility:internal`,
          '--interactive=false',
          '--skipFormat',
        ],
        'staging',
      ),
    );
    if (app === 'mobile')
      steps.push({ kind: 'configure', id: 'configure-mobile' });
    if (app === 'site') steps.push({ kind: 'configure', id: 'configure-site' });
    if (app === 'web') steps.push({ kind: 'configure', id: 'configure-web' });
  }

  if (options.apps.includes('worker')) {
    steps.push({ kind: 'configure', id: 'configure-worker' });
  }

  steps.push(
    commandStep(
      'initialize-megamono',
      'npm',
      [
        'exec',
        'nx',
        '--',
        'generate',
        '@megamono/plugin:workspace-init',
        `--defaultScope=${options.scope}`,
        ...(options.apps.includes('desktop') ? ['--defaultPlatform=rust'] : []),
        '--only=docs,agents,ci,lint,skills,health,inference',
        '--yes',
        `--platforms=${requestedPlatforms(options).join(',')}`,
        `--serviceRunner=${options.serviceRunner}`,
        `--serviceRequirements=${JSON.stringify(requestedServiceRequirements(options))}`,
        '--interactive=false',
      ],
      'staging',
    ),
  );

  if (options.verify !== 'none') {
    steps.push(
      commandStep(
        'format',
        'npm',
        ['exec', 'nx', '--', 'format:write'],
        'staging',
      ),
      commandStep(
        'validate-docs',
        'npm',
        ['exec', 'nx', '--', 'run', 'megamono-docs:validate'],
        'staging',
      ),
      commandStep(
        'check-structure',
        'npm',
        ['exec', 'nx', '--', 'run', 'megamono:check'],
        'staging',
      ),
      commandStep(
        'build-project-graph',
        'npm',
        ['exec', 'nx', '--', 'graph', '--file=.megamono/graph.json'],
        'staging',
      ),
    );
  }
  if (options.verify === 'build') {
    steps.push(
      commandStep(
        'verify-generated-projects',
        'npm',
        [
          'exec',
          'nx',
          '--',
          'run-many',
          '--targets=build,test,lint',
          `--projects=${options.apps.map((app) => `${options.scope}-${app}`).join(',')}`,
        ],
        'staging',
      ),
    );
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

export async function preflightPlan(plan: CreationPlan): Promise<void> {
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
        if (step.id === 'configure-desktop')
          return `${index + 1}. [staging] normalize apps/desktop and register @megamono/nx-cargo`;
        if (
          step.id === 'configure-mobile' ||
          step.id === 'configure-site' ||
          step.id === 'configure-web'
        ) {
          const app = step.id.replace('configure-', '');
          return `${index + 1}. [staging] normalize apps/${app} as an application project`;
        }
        if (step.id === 'configure-worker')
          return `${index + 1}. [staging] normalize apps/worker as a Cloudflare Worker application`;
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

async function configureWorker(plan: CreationPlan): Promise<void> {
  const workerRoot = resolve(plan.options.stagingDirectory, 'apps/worker');
  const projectName = `${plan.options.scope}-worker`;
  const projectPath = resolve(workerRoot, 'project.json');
  const project = JSON.parse(await readFile(projectPath, 'utf8')) as {
    name?: string;
    projectType?: string;
    targets?: Record<
      string,
      { executor?: string; options?: Record<string, unknown> }
    >;
  };
  const build = project.targets?.build;
  if (!build || build.executor !== '@nx/esbuild:esbuild') {
    throw new CreateMegamonoError(
      'The generated Worker scaffold is missing its expected @nx/esbuild build target.',
      3,
    );
  }
  project.name = projectName;
  project.projectType = 'application';
  project.targets ??= {};
  build.options = {
    ...build.options,
    format: ['esm'],
    platform: 'neutral',
    generatePackageJson: false,
  };
  await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, 'utf8');

  const nxPath = resolve(plan.options.stagingDirectory, 'nx.json');
  const nxJson = JSON.parse(await readFile(nxPath, 'utf8')) as {
    plugins?: Array<string | { plugin: string; [key: string]: unknown }>;
  };
  nxJson.plugins ??= [];
  const hasVitestPlugin = nxJson.plugins.some((entry) =>
    typeof entry === 'string'
      ? entry === '@nx/vitest'
      : entry.plugin === '@nx/vitest',
  );
  if (!hasVitestPlugin) {
    nxJson.plugins.push({
      plugin: '@nx/vitest',
      options: { testTargetName: 'test' },
      include: ['apps/worker/**/*'],
    });
  }
  await writeFile(nxPath, `${JSON.stringify(nxJson, null, 2)}\n`, 'utf8');

  await rm(resolve(workerRoot, 'src/lib'), { recursive: true, force: true });
  await writeFile(
    resolve(workerRoot, 'src/index.ts'),
    `export function handleRequest(request: Request): Response {
  const url = new URL(request.url);
  return Response.json({ ok: true, path: url.pathname });
}

export default { fetch: handleRequest };
`,
    'utf8',
  );
  await mkdir(resolve(workerRoot, 'tests'), { recursive: true });
  await writeFile(
    resolve(workerRoot, 'tests/index.spec.ts'),
    `import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/index.js';

describe('worker', () => {
  it('responds with the requested path', async () => {
    const response = handleRequest(new Request('https://example.test/health'));
    await expect(response.json()).resolves.toEqual({ ok: true, path: '/health' });
  });
});
`,
    'utf8',
  );
  await writeFile(
    resolve(workerRoot, 'vitest.config.ts'),
    `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['{src,tests}/**/*.spec.ts'],
  },
});
`,
    'utf8',
  );
  await writeFile(
    resolve(workerRoot, 'eslint.config.mjs'),
    `import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/esbuild.config.{js,ts,mjs,mts}',
            '{projectRoot}/vitest.config.{js,ts,mjs,mts}',
            '{projectRoot}/**/*.{spec,test}.{js,jsx,ts,tsx}',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    ignores: ['**/out-tsc'],
  },
];
`,
    'utf8',
  );
  await writeFile(
    resolve(workerRoot, 'wrangler.jsonc'),
    `${JSON.stringify(
      {
        $schema:
          'https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/wrangler/config-schema.json',
        name: projectName,
        main: 'src/index.ts',
        compatibility_date: '2026-08-23',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function configurePackageApplication(
  plan: CreationPlan,
  app: 'mobile' | 'site' | 'web',
): Promise<void> {
  const packagePath = resolve(
    plan.options.stagingDirectory,
    `apps/${app}/package.json`,
  );
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    nx?: Record<string, unknown>;
  };
  packageJson.nx ??= {};
  packageJson.nx.projectType = 'application';
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
): Promise<void> {
  await preflightPlan(plan);
  if (plan.options.dryRun) return;
  const completed: string[] = [];
  try {
    for (const step of plan.steps) {
      if (step.kind === 'commit') await commitWorkspace(plan);
      else if (step.kind === 'configure') {
        if (step.id === 'configure-desktop') await configureDesktop(plan);
        else if (step.id === 'configure-mobile')
          await configurePackageApplication(plan, 'mobile');
        else if (step.id === 'configure-site')
          await configurePackageApplication(plan, 'site');
        else if (step.id === 'configure-web')
          await configurePackageApplication(plan, 'web');
        else if (step.id === 'configure-worker') await configureWorker(plan);
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
): Promise<CreationPlan> {
  const plan = createPlan(normalizeCreateOptions(input));
  await executePlan(plan, runner, springbarConfigurator);
  return plan;
}
