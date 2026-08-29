import { createRequire } from 'node:module';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

export type PackageManager = 'npm' | 'pnpm';
export type LocalPackageSource = 'registry' | 'yalc';

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly signal?: NodeJS.Signals;
}

export interface MegamonoCliIo {
  readonly cwd: string;
  readonly version: string;
  stdout(message: string): void;
  stderr(message: string): void;
  selectPlaystackPackages?(
    choices: readonly PlaystackProductChoice[],
  ): Promise<readonly string[]>;
  selectAppType?(choices: readonly AppTypeChoice[]): Promise<string>;
  confirmAddPlan?(message: string): Promise<boolean>;
  runCommand(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly capture?: boolean },
  ): Promise<CommandResult>;
}

export interface MegamonoCliResult {
  readonly exitCode: number;
}

interface InitOptions {
  readonly generatorArgs: readonly string[];
  readonly localPackages: LocalPackageSource;
  readonly playstack: boolean;
  readonly playstackPackages: readonly string[];
  readonly selectPlaystackPackages: boolean;
  readonly survey: boolean;
}

export interface PlaystackProductChoice {
  readonly name: string;
  readonly message: string;
}

export interface AppTypeChoice {
  readonly name: string;
  readonly message: string;
}

export const APP_TYPE_CHOICES: readonly AppTypeChoice[] = [
  { name: 'web', message: 'Web — Next Pages Router, Chakra, Playwright' },
  { name: 'site', message: 'Site — Next marketing surface' },
  { name: 'api', message: 'API — Nest composition root and feature library' },
  { name: 'worker', message: 'Worker — Cloudflare Worker' },
  { name: 'mobile', message: 'Mobile — Expo application' },
  { name: 'desktop', message: 'Desktop — Tauri application' },
  { name: 'apple', message: 'Apple — native SwiftUI application' },
];

const ADD_MODULES = [
  'docs',
  'agents',
  'ci',
  'release',
  'lint',
  'skills',
  'health',
  'inference',
] as const;
const ADD_MODULE_SET = new Set<string>(ADD_MODULES);
const APP_TYPE_SET = new Set(APP_TYPE_CHOICES.map(({ name }) => name));

export const PLAYSTACK_PRODUCT_CHOICES: readonly PlaystackProductChoice[] = [
  { name: 'accounts', message: 'Accounts — tenancy and membership' },
  { name: 'auth', message: 'Auth — identity and sessions' },
  { name: 'cache', message: 'Cache — provider-backed caching' },
  { name: 'content', message: 'Content — transforms and schemas' },
  { name: 'webhooks', message: 'Webhooks — durable webhook receipts' },
];

interface Workspace {
  readonly root: string;
  readonly packageManager: PackageManager;
}

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 2 | 3 | 4,
  ) {
    super(message);
  }
}

const HELP = `Usage: megamono <command> [options]

Commands:
  init                 Adopt Megamono in an existing Nx workspace
  add app [type]       Add a convention-aligned application
  add <module>         Add one repository-governance module
  generate <name>      Run an available local Megamono generator
  help                 Show this help

Global options:
  --version            Print the installed CLI version
  --help               Show this help

Init-only options:
  --playstack          Run package-owned Playstack setup after Megamono
  --playstack-packages[=<names>]
                       Select products, or pass comma-separated names
  --local-packages=registry|yalc
                       Package source for missing local packages

All other init options are forwarded to @megamono/plugin:workspace-init.`;

const ADD_HELP = `Usage: megamono add app [type] [options]
       megamono add <module> [options]

Examples:
  megamono add app web
  megamono add app api --name=admin-api --interactive=false --yes
  megamono add app web --dry-run
  megamono add docs
  megamono add ci --dry-run

Application types: ${APP_TYPE_CHOICES.map(({ name }) => name).join(', ')}
Modules: ${ADD_MODULES.join(', ')}

Add commands require an initialized workspace with local nx and @megamono/plugin.`;

const INIT_HELP = `Usage: megamono init [generator options]

Examples:
  megamono init --survey
  megamono init --only=docs,agents --interactive=false --yes
  megamono init --playstack --playstack-packages=auth
  megamono init --playstack --local-packages=yalc

The workspace must contain local nx and @megamono/plugin installations.`;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findWorkspaceRoot(start: string): Promise<string> {
  let current = resolve(start);
  const filesystemRoot = parse(current).root;
  while (true) {
    if (
      (await exists(join(current, 'package.json'))) &&
      (await exists(join(current, 'nx.json')))
    ) {
      return current;
    }
    if (current === filesystemRoot) break;
    current = dirname(current);
  }
  throw new CliError(
    'No Nx workspace found from the current directory; expected package.json and nx.json.',
    3,
  );
}

async function detectPackageManager(root: string): Promise<PackageManager> {
  const managers = [
    ...((await exists(join(root, 'pnpm-lock.yaml')))
      ? (['pnpm'] as const)
      : []),
    ...((await exists(join(root, 'package-lock.json')))
      ? (['npm'] as const)
      : []),
  ];
  if (managers.length !== 1) {
    throw new CliError(
      managers.length === 0
        ? 'A pnpm-lock.yaml or package-lock.json is required.'
        : 'Conflicting pnpm-lock.yaml and package-lock.json files are not supported.',
      3,
    );
  }
  return managers[0];
}

function localPackageAvailable(root: string, name: string): boolean {
  try {
    createRequire(join(root, 'package.json')).resolve(`${name}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function optionValue(
  args: readonly string[],
  index: number,
  name: string,
): { readonly value: string; readonly consumed: number } | undefined {
  const argument = args[index];
  if (argument === name) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new CliError(`${name} requires a value.`, 2);
    }
    return { value, consumed: 2 };
  }
  if (argument?.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1);
    if (!value) throw new CliError(`${name} requires a value.`, 2);
    return { value, consumed: 1 };
  }
  return undefined;
}

function parsePlaystackPackages(value: string): readonly string[] {
  const requested = [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  if (requested.length === 0) {
    throw new CliError(
      '--playstack-packages requires at least one package.',
      2,
    );
  }
  const packages = requested.map((name) =>
    /^@playstack\//.test(name) ? name : `@playstack/${name}`,
  );
  for (const packageName of packages) {
    if (
      !/^@playstack\/[a-z0-9][a-z0-9._-]*$/.test(packageName) ||
      packageName === '@playstack/cli'
    ) {
      throw new CliError(
        `Invalid Playstack product package ${packageName}; expected <name> or @playstack/<name>.`,
        2,
      );
    }
  }
  return [...new Set(packages)].sort();
}

function parseInitOptions(args: readonly string[]): InitOptions {
  const forwarded: string[] = [];
  let localPackages: LocalPackageSource = 'registry';
  let playstack = false;
  let playstackPackages: readonly string[] = [];
  let selectPlaystackPackages = false;
  let passthrough = false;
  for (let index = 0; index < args.length;) {
    const argument = args[index];
    if (passthrough) {
      forwarded.push(argument);
      index += 1;
      continue;
    }
    if (argument === '--') {
      passthrough = true;
      forwarded.push(argument);
      index += 1;
      continue;
    }
    if (argument === '--playstack') {
      playstack = true;
      index += 1;
      continue;
    }
    if (argument?.startsWith('--playstack=')) {
      const value = argument.slice('--playstack='.length);
      if (value !== 'true' && value !== 'false') {
        throw new CliError('--playstack must be true or false.', 2);
      }
      playstack = value === 'true';
      index += 1;
      continue;
    }
    if (
      (argument === '--playstack-packages' &&
        (!args[index + 1] || args[index + 1]?.startsWith('--'))) ||
      argument === '--playstack-packages='
    ) {
      selectPlaystackPackages = true;
      playstack = true;
      index += 1;
      continue;
    }
    const source = optionValue(args, index, '--local-packages');
    if (source) {
      if (source.value !== 'registry' && source.value !== 'yalc') {
        throw new CliError('--local-packages must be registry or yalc.', 2);
      }
      localPackages = source.value;
      index += source.consumed;
      continue;
    }
    const products = optionValue(args, index, '--playstack-packages');
    if (products) {
      playstackPackages = parsePlaystackPackages(products.value);
      playstack = true;
      index += products.consumed;
      continue;
    }
    forwarded.push(argument);
    index += 1;
  }
  return {
    generatorArgs: forwarded,
    localPackages,
    playstack,
    playstackPackages,
    selectPlaystackPackages,
    survey: forwarded.some(
      (argument) => argument === '--survey' || argument === '--survey=true',
    ),
  };
}

async function resolvePlaystackPackageSelection(
  io: MegamonoCliIo,
  options: InitOptions,
): Promise<InitOptions> {
  if (!options.selectPlaystackPackages) return options;
  const interactionDisabled = options.generatorArgs.some(
    (argument, index, args) =>
      argument === '--no-interactive' ||
      argument === '--interactive=false' ||
      (argument === '--interactive' && args[index + 1] === 'false'),
  );
  if (!io.selectPlaystackPackages || interactionDisabled) {
    throw new CliError(
      '--playstack-packages requires a comma-separated value when input is non-interactive.',
      2,
    );
  }
  let selected: readonly string[];
  try {
    selected = await io.selectPlaystackPackages(PLAYSTACK_PRODUCT_CHOICES);
  } catch (cause) {
    throw new CliError(
      `Playstack package selection was cancelled: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      2,
    );
  }
  return {
    ...options,
    playstackPackages: parsePlaystackPackages(selected.join(',')),
    selectPlaystackPackages: false,
  };
}

function nxInvocation(
  manager: PackageManager,
  generatorArgs: readonly string[],
  generator = 'workspace-init',
): readonly [string, readonly string[]] {
  return manager === 'pnpm'
    ? [
        'pnpm',
        [
          'exec',
          'nx',
          'generate',
          `@megamono/plugin:${generator}`,
          ...generatorArgs,
        ],
      ]
    : [
        'npm',
        [
          'exec',
          'nx',
          '--',
          'generate',
          `@megamono/plugin:${generator}`,
          ...generatorArgs,
        ],
      ];
}

interface LocalGeneratorAvailability {
  readonly status: 'available' | 'gated' | 'reserved';
  readonly gate?: string;
}

async function localGeneratorAvailability(
  root: string,
  name: string,
): Promise<LocalGeneratorAvailability | undefined> {
  const packageJson = createRequire(join(root, 'package.json')).resolve(
    '@megamono/plugin/package.json',
  );
  const registry = JSON.parse(
    await readFile(join(dirname(packageJson), 'availability.json'), 'utf8'),
  ) as {
    generators?: Record<string, LocalGeneratorAvailability>;
  };
  return registry.generators?.[name];
}

async function runGenerate(
  args: readonly string[],
  io: MegamonoCliIo,
): Promise<MegamonoCliResult> {
  const name = args[0];
  if (!name || name.startsWith('-')) {
    throw new CliError(
      'Usage: megamono generate <name> [generator options]',
      2,
    );
  }
  const root = await findWorkspaceRoot(io.cwd);
  const manager = await detectPackageManager(root);
  if (!localPackageAvailable(root, 'nx')) {
    throw new CliError('The workspace-local nx package is not installed.', 3);
  }
  if (!localPackageAvailable(root, '@megamono/plugin')) {
    throw new CliError(
      `@megamono/plugin is not installed locally. Run: ${pluginInstallInstruction(manager, 'registry')}. Commit that dependency change, then rerun megamono generate ${name}.`,
      3,
    );
  }
  const availability = await localGeneratorAvailability(root, name);
  if (!availability) {
    throw new CliError(
      `Generator ${name} is reserved: No canonical Megamono generator uses this name.`,
      3,
    );
  }
  if (availability.status !== 'available') {
    throw new CliError(
      `Generator ${name} is ${availability.status}: ${availability.gate}`,
      3,
    );
  }
  const [command, commandArgs] = nxInvocation(manager, args.slice(1), name);
  const result = await io.runCommand(command, commandArgs, { cwd: root });
  return { exitCode: result.exitCode };
}

function playstackInvocation(
  manager: PackageManager,
  survey: boolean,
): readonly [string, readonly string[]] {
  const command = ['playstack', 'init', ...(survey ? ['--survey'] : [])];
  return manager === 'pnpm'
    ? ['pnpm', ['exec', ...command]]
    : ['npm', ['exec', 'playstack', '--', ...command.slice(1)]];
}

function pluginInstallInstruction(
  manager: PackageManager,
  source: LocalPackageSource,
): string {
  if (source === 'yalc') {
    return `yalc add @megamono/plugin --dev --no-pure && ${manager} install`;
  }
  return manager === 'pnpm'
    ? 'pnpm add --save-dev @megamono/plugin'
    : 'npm install --save-dev @megamono/plugin';
}

async function yalcRoot(io: MegamonoCliIo, root: string): Promise<string> {
  let result: CommandResult;
  try {
    result = await io.runCommand('yalc', ['dir'], {
      cwd: root,
      capture: true,
    });
  } catch (error) {
    throw new CliError(
      `Unable to resolve the yalc store: ${
        error instanceof Error ? error.message : String(error)
      }`,
      3,
    );
  }
  if (result.exitCode !== 0 || !result.stdout) {
    throw new CliError(
      `Unable to resolve the yalc store${result.stderr ? `: ${result.stderr}` : '.'}`,
      3,
    );
  }
  return result.stdout.trim();
}

function yalcPackagePath(root: string, packageName: string): string {
  return join(root, 'packages', ...packageName.split('/'));
}

async function yalcHasPackage(
  store: string,
  packageName: string,
): Promise<boolean> {
  try {
    const versions = await readdir(yalcPackagePath(store, packageName));
    return versions.length > 0;
  } catch {
    return false;
  }
}

async function preflightYalc(
  io: MegamonoCliIo,
  workspace: Workspace,
  packages: readonly string[],
): Promise<void> {
  if (packages.length === 0) return;
  const store = await yalcRoot(io, workspace.root);
  const missing: string[] = [];
  for (const packageName of packages) {
    if (!(await yalcHasPackage(store, packageName))) missing.push(packageName);
  }
  if (missing.length > 0) {
    throw new CliError(
      `The yalc store is missing: ${missing.join(', ')}. Publish those packages locally before retrying.`,
      3,
    );
  }
}

async function runRequired(
  io: MegamonoCliIo,
  workspace: Workspace,
  command: string,
  args: readonly string[],
  recovery: string,
): Promise<void> {
  let result: CommandResult;
  try {
    result = await io.runCommand(command, args, { cwd: workspace.root });
  } catch (error) {
    throw new CliError(
      `Megamono initialization completed, but Playstack setup could not run ${command}: ${
        error instanceof Error ? error.message : String(error)
      }. Retry: ${recovery}`,
      3,
    );
  }
  if (result.exitCode !== 0) {
    throw new CliError(
      `Megamono initialization completed, but Playstack setup failed. Retry: ${recovery}`,
      3,
    );
  }
}

async function installPlaystackPackages(
  io: MegamonoCliIo,
  workspace: Workspace,
  options: InitOptions,
): Promise<void> {
  const needsCli = !localPackageAvailable(workspace.root, '@playstack/cli');
  const products = options.playstackPackages.filter(
    (packageName) => !localPackageAvailable(workspace.root, packageName),
  );
  if (!needsCli && products.length === 0) return;

  if (options.localPackages === 'yalc') {
    if (needsCli) {
      await runRequired(
        io,
        workspace,
        'yalc',
        ['add', '@playstack/cli', '--dev', '--no-pure'],
        'yalc add @playstack/cli --dev --no-pure',
      );
    }
    if (products.length > 0) {
      await runRequired(
        io,
        workspace,
        'yalc',
        ['add', ...products, '--no-pure'],
        `yalc add ${products.join(' ')} --no-pure`,
      );
    }
    await runRequired(
      io,
      workspace,
      workspace.packageManager,
      ['install'],
      `${workspace.packageManager} install`,
    );
    return;
  }

  const install = workspace.packageManager === 'pnpm' ? 'add' : 'install';
  if (needsCli) {
    await runRequired(
      io,
      workspace,
      workspace.packageManager,
      [install, '--save-dev', '@playstack/cli'],
      `${workspace.packageManager} ${install} --save-dev @playstack/cli`,
    );
  }
  if (products.length > 0) {
    await runRequired(
      io,
      workspace,
      workspace.packageManager,
      [install, ...products],
      `${workspace.packageManager} ${install} ${products.join(' ')}`,
    );
  }
}

interface AddOptions {
  readonly args: readonly string[];
  readonly localPackages: LocalPackageSource;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly interactive: boolean;
}

function parseAddOptions(args: readonly string[]): AddOptions {
  const forwarded: string[] = [];
  let localPackages: LocalPackageSource = 'registry';
  for (let index = 0; index < args.length;) {
    const source = optionValue(args, index, '--local-packages');
    if (source) {
      if (source.value !== 'registry' && source.value !== 'yalc') {
        throw new CliError('--local-packages must be registry or yalc.', 2);
      }
      localPackages = source.value;
      index += source.consumed;
      continue;
    }
    forwarded.push(args[index]);
    index += 1;
  }
  return {
    args: forwarded,
    localPackages,
    dryRun: forwarded.some(
      (argument) => argument === '--dry-run' || argument === '--dryRun=true',
    ),
    yes: forwarded.some(
      (argument) => argument === '--yes' || argument === '--yes=true',
    ),
    interactive: !forwarded.some(
      (argument, index) =>
        argument === '--no-interactive' ||
        argument === '--interactive=false' ||
        (argument === '--interactive' && forwarded[index + 1] === 'false'),
    ),
  };
}

async function localPackageVersion(
  root: string,
  name: string,
): Promise<string> {
  try {
    const manifest = createRequire(join(root, 'package.json')).resolve(
      `${name}/package.json`,
    );
    const value = JSON.parse(await readFile(manifest, 'utf8')) as {
      version?: unknown;
    };
    if (typeof value.version === 'string' && value.version)
      return value.version;
  } catch {
    // The caller renders the package-specific compatibility failure below.
  }
  throw new CliError(`Unable to resolve the local ${name} package version.`, 3);
}

async function pluginScaffoldVersions(
  root: string,
): Promise<Record<string, string>> {
  const manifest = createRequire(join(root, 'package.json')).resolve(
    '@megamono/plugin/package.json',
  );
  const compatibility = JSON.parse(
    await readFile(join(dirname(manifest), 'compatibility.json'), 'utf8'),
  ) as { scaffoldPackages?: Record<string, string> };
  return compatibility.scaffoldPackages ?? {};
}

function requiredAppPlugins(type: string): readonly string[] {
  if (type === 'web' || type === 'site')
    return ['@nx/next', '@nx/playwright', '@nx/js', '@nx/eslint'];
  if (type === 'api') return ['@nx/nest', '@nx/jest', '@nx/eslint'];
  if (type === 'mobile') return ['@nx/expo'];
  if (type === 'worker') return ['@megamono/nx-cloudflare'];
  if (type === 'apple') return ['@megamono/nx-apple'];
  if (type === 'desktop') return ['@megamono/nx-cargo'];
  return [];
}

async function runAddCommand(
  io: MegamonoCliIo,
  workspace: Workspace,
  command: string,
  args: readonly string[],
): Promise<void> {
  const result = await io.runCommand(command, args, { cwd: workspace.root });
  if (result.exitCode !== 0) {
    throw new CliError(
      `Application dependency setup failed. Retry: ${command} ${args.join(' ')}`,
      3,
    );
  }
}

async function installAppPlugins(
  io: MegamonoCliIo,
  workspace: Workspace,
  packages: readonly string[],
  source: LocalPackageSource,
): Promise<void> {
  const missing = packages.filter(
    (packageName) => !localPackageAvailable(workspace.root, packageName),
  );
  if (missing.length === 0) return;
  const local = missing.filter((name) => name.startsWith('@megamono/'));
  const registry = missing.filter((name) => !name.startsWith('@megamono/'));
  if (source === 'yalc' && local.length > 0) {
    await preflightYalc(io, workspace, local);
    await runAddCommand(io, workspace, 'yalc', [
      'add',
      ...local,
      '--dev',
      '--no-pure',
    ]);
  } else if (local.length > 0) {
    const versions = await pluginScaffoldVersions(workspace.root);
    const specs = local.map((name) => {
      const version = versions[name];
      if (!version) {
        throw new CliError(
          `No compatible application plugin version is registered for ${name}.`,
          3,
        );
      }
      return `${name}@${version}`;
    });
    const install = workspace.packageManager === 'pnpm' ? 'add' : 'install';
    await runAddCommand(io, workspace, workspace.packageManager, [
      install,
      '--save-dev',
      ...specs,
    ]);
  }
  if (registry.length > 0) {
    const nxVersion = await localPackageVersion(workspace.root, 'nx');
    const install = workspace.packageManager === 'pnpm' ? 'add' : 'install';
    await runAddCommand(io, workspace, workspace.packageManager, [
      install,
      '--save-dev',
      ...registry.map((name) => `${name}@${nxVersion}`),
    ]);
  }
  if (source === 'yalc' && local.length > 0) {
    await runAddCommand(io, workspace, workspace.packageManager, ['install']);
  }
}

async function resolveAppType(
  io: MegamonoCliIo,
  value: string | undefined,
  options: AddOptions,
): Promise<string> {
  if (value && !value.startsWith('-')) {
    if (!APP_TYPE_SET.has(value)) {
      throw new CliError(
        `Unknown application type ${value}. Expected one of: ${[...APP_TYPE_SET].join(', ')}.`,
        2,
      );
    }
    return value;
  }
  if (!options.interactive || !io.selectAppType) {
    throw new CliError(
      `Application type is required in non-interactive mode. Expected one of: ${[...APP_TYPE_SET].join(', ')}.`,
      4,
    );
  }
  const selected = await io.selectAppType(APP_TYPE_CHOICES);
  if (!APP_TYPE_SET.has(selected)) {
    throw new CliError('Application type selection was cancelled.', 2);
  }
  return selected;
}

async function addWorkspace(io: MegamonoCliIo): Promise<Workspace> {
  const root = await findWorkspaceRoot(io.cwd);
  const workspace = { root, packageManager: await detectPackageManager(root) };
  if (!localPackageAvailable(root, 'nx')) {
    throw new CliError('The workspace-local nx package is not installed.', 3);
  }
  if (!localPackageAvailable(root, '@megamono/plugin')) {
    throw new CliError(
      `@megamono/plugin is not installed locally. Run: ${pluginInstallInstruction(workspace.packageManager, 'registry')}.`,
      3,
    );
  }
  if (!(await exists(join(root, 'megamono.json')))) {
    throw new CliError(
      'This workspace is not initialized. Run megamono init before megamono add.',
      3,
    );
  }
  return workspace;
}

async function runAdd(
  args: readonly string[],
  io: MegamonoCliIo,
): Promise<MegamonoCliResult> {
  const subject = args[0];
  if (!subject || subject.startsWith('-')) {
    throw new CliError(ADD_HELP, 2);
  }
  const workspace = await addWorkspace(io);
  if (ADD_MODULE_SET.has(subject)) {
    const options = parseAddOptions(args.slice(1));
    const [command, commandArgs] = nxInvocation(
      workspace.packageManager,
      [`--only=${subject}`, ...options.args],
      'workspace-init',
    );
    const result = await io.runCommand(command, commandArgs, {
      cwd: workspace.root,
    });
    return { exitCode: result.exitCode };
  }
  if (subject !== 'app') {
    throw new CliError(`Unknown add target ${subject}.\n\n${ADD_HELP}`, 2);
  }

  const hasPositionalType = Boolean(args[1] && !args[1]?.startsWith('-'));
  const parsed = parseAddOptions(args.slice(hasPositionalType ? 2 : 1));
  const type = await resolveAppType(
    io,
    hasPositionalType ? args[1] : undefined,
    parsed,
  );
  const required = requiredAppPlugins(type);
  const missing = required.filter(
    (packageName) => !localPackageAvailable(workspace.root, packageName),
  );
  if (parsed.dryRun) {
    if (missing.length > 0) {
      io.stdout(
        `Dry run prerequisite plan: add ${missing.join(', ')} as development dependencies.`,
      );
    }
  } else if (!parsed.yes) {
    if (!parsed.interactive || !io.confirmAddPlan) {
      throw new CliError(
        'Application addition requires interactive confirmation or --interactive=false --yes.',
        4,
      );
    }
    const confirmed = await io.confirmAddPlan(
      `Add the ${type} application${missing.length ? ` and install ${missing.join(', ')}` : ''}?`,
    );
    if (!confirmed) return { exitCode: 0 };
  }

  if (!parsed.dryRun) {
    await installAppPlugins(io, workspace, required, parsed.localPackages);
  }
  const generatorArgs = [
    `--type=${type}`,
    ...parsed.args,
    ...(!parsed.dryRun && !parsed.yes ? ['--yes'] : []),
  ];
  const [command, commandArgs] = nxInvocation(
    workspace.packageManager,
    generatorArgs,
    'app',
  );
  const generated = await io.runCommand(command, commandArgs, {
    cwd: workspace.root,
  });
  return { exitCode: generated.exitCode };
}

function renderPlaystackSurveyPlan(
  manager: PackageManager,
  options: InitOptions,
): string {
  const products = options.playstackPackages.join(' ');
  const install = manager === 'pnpm' ? 'add' : 'install';
  const source =
    options.localPackages === 'yalc'
      ? `yalc add @playstack/cli --dev --no-pure${
          products ? `; yalc add ${products} --no-pure` : ''
        }; ${manager} install`
      : `${manager} ${install} --save-dev @playstack/cli${
          products ? `; ${manager} ${install} ${products}` : ''
        }`;
  return `Playstack survey deferred: @playstack/cli is not installed. A real run would use ${source}.`;
}

async function runInit(
  args: readonly string[],
  io: MegamonoCliIo,
): Promise<MegamonoCliResult> {
  const parsedOptions = parseInitOptions(args);
  const root = await findWorkspaceRoot(io.cwd);
  const workspace: Workspace = {
    root,
    packageManager: await detectPackageManager(root),
  };
  if (!localPackageAvailable(root, 'nx')) {
    throw new CliError('The workspace-local nx package is not installed.', 3);
  }

  const pluginAvailable = localPackageAvailable(root, '@megamono/plugin');
  const options = await resolvePlaystackPackageSelection(io, parsedOptions);
  if (options.localPackages === 'yalc') {
    const yalcPackages = [
      ...(!pluginAvailable ? ['@megamono/plugin'] : []),
      ...(options.playstack
        ? [
            ...(!localPackageAvailable(root, '@playstack/cli')
              ? ['@playstack/cli']
              : []),
            ...options.playstackPackages.filter(
              (packageName) => !localPackageAvailable(root, packageName),
            ),
          ]
        : []),
    ];
    await preflightYalc(io, workspace, [...new Set(yalcPackages)].sort());
  }
  if (!pluginAvailable) {
    throw new CliError(
      `@megamono/plugin is not installed locally. Run: ${pluginInstallInstruction(
        workspace.packageManager,
        options.localPackages,
      )}. Commit that dependency change, then rerun megamono init.`,
      3,
    );
  }

  const [nxCommand, nxArgs] = nxInvocation(
    workspace.packageManager,
    options.generatorArgs,
  );
  const initialized = await io.runCommand(nxCommand, nxArgs, {
    cwd: workspace.root,
  });
  if (initialized.exitCode !== 0 || !options.playstack) {
    return { exitCode: initialized.exitCode };
  }

  const playstackAvailable = localPackageAvailable(root, '@playstack/cli');
  if (options.survey) {
    if (!playstackAvailable) {
      io.stdout(renderPlaystackSurveyPlan(workspace.packageManager, options));
      return { exitCode: 0 };
    }
  } else {
    await installPlaystackPackages(io, workspace, options);
  }

  const [playstackCommand, playstackArgs] = playstackInvocation(
    workspace.packageManager,
    options.survey,
  );
  const configured = await io.runCommand(playstackCommand, playstackArgs, {
    cwd: workspace.root,
  });
  if (configured.exitCode !== 0 && !options.survey) {
    io.stderr(
      `Megamono initialization completed, but Playstack init failed. Retry: ${playstackCommand} ${playstackArgs.join(' ')}`,
    );
  }
  return { exitCode: configured.exitCode };
}

export async function runMegamonoCli(
  args: readonly string[],
  io: MegamonoCliIo,
): Promise<MegamonoCliResult> {
  try {
    if (
      args.length === 0 ||
      args[0] === 'help' ||
      args[0] === '--help' ||
      args[0] === '-h'
    ) {
      io.stdout(HELP);
      return { exitCode: 0 };
    }
    if (args[0] === '--version' || args[0] === '-v') {
      io.stdout(io.version);
      return { exitCode: 0 };
    }
    if (args[0] === 'init') {
      if (args[1] === '--help' || args[1] === '-h') {
        io.stdout(INIT_HELP);
        return { exitCode: 0 };
      }
      return await runInit(args.slice(1), io);
    }
    if (args[0] === 'add') {
      if (args[1] === '--help' || args[1] === '-h') {
        io.stdout(ADD_HELP);
        return { exitCode: 0 };
      }
      return await runAdd(args.slice(1), io);
    }
    if (args[0] === 'generate') {
      return await runGenerate(args.slice(1), io);
    }
    throw new CliError(`Unknown command ${args[0]}.\n\n${HELP}`, 2);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return {
      exitCode: error instanceof CliError ? error.exitCode : 1,
    };
  }
}
