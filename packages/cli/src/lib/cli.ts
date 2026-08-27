import { createRequire } from 'node:module';
import { access, readdir } from 'node:fs/promises';
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
  readonly survey: boolean;
}

interface Workspace {
  readonly root: string;
  readonly packageManager: PackageManager;
}

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: 2 | 3,
  ) {
    super(message);
  }
}

const HELP = `Usage: megamono <command> [options]

Commands:
  init                 Adopt Megamono in an existing Nx workspace
  help                 Show this help

Global options:
  --version            Print the installed CLI version
  --help               Show this help

Init-only options:
  --playstack          Run package-owned Playstack setup after Megamono
  --playstack-packages=<names>
                       Comma-separated @playstack/* product packages
  --local-packages=registry|yalc
                       Package source for missing local packages

All other init options are forwarded to @megamono/plugin:workspace-init.`;

const INIT_HELP = `Usage: megamono init [generator options]

Examples:
  megamono init --survey
  megamono init --only=docs,agents --interactive=false --yes
  megamono init --playstack --playstack-packages=@playstack/auth
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
  const packages = [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  if (packages.length === 0) {
    throw new CliError(
      '--playstack-packages requires at least one package.',
      2,
    );
  }
  for (const packageName of packages) {
    if (
      !/^@playstack\/[a-z0-9][a-z0-9._-]*$/.test(packageName) ||
      packageName === '@playstack/cli'
    ) {
      throw new CliError(
        `Invalid Playstack product package ${packageName}; expected @playstack/<name>.`,
        2,
      );
    }
  }
  return packages.sort();
}

function parseInitOptions(args: readonly string[]): InitOptions {
  const forwarded: string[] = [];
  let localPackages: LocalPackageSource = 'registry';
  let playstack = false;
  let playstackPackages: readonly string[] = [];
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
    survey: forwarded.some(
      (argument) => argument === '--survey' || argument === '--survey=true',
    ),
  };
}

function nxInvocation(
  manager: PackageManager,
  generatorArgs: readonly string[],
): readonly [string, readonly string[]] {
  return manager === 'pnpm'
    ? [
        'pnpm',
        [
          'exec',
          'nx',
          'generate',
          '@megamono/plugin:workspace-init',
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
          '@megamono/plugin:workspace-init',
          ...generatorArgs,
        ],
      ];
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
  const options = parseInitOptions(args);
  const root = await findWorkspaceRoot(io.cwd);
  const workspace: Workspace = {
    root,
    packageManager: await detectPackageManager(root),
  };
  if (!localPackageAvailable(root, 'nx')) {
    throw new CliError('The workspace-local nx package is not installed.', 3);
  }

  const pluginAvailable = localPackageAvailable(root, '@megamono/plugin');
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
    throw new CliError(`Unknown command ${args[0]}.\n\n${HELP}`, 2);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return {
      exitCode: error instanceof CliError ? error.exitCode : 1,
    };
  }
}
