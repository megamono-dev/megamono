import { createRequire } from 'node:module';
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, parse, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  isPackageManager,
  packageManagerAdapter,
  type PackageManager,
} from './package-manager.js';
import type {
  HostedAccount,
  HostedAuthOperations,
  HostedProfile,
} from './hosted-auth.js';

export type { PackageManager } from './package-manager.js';
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
  readonly build?: MegamonoBuildIdentity;
  stdout(message: string): void;
  stderr(message: string): void;
  selectPlaystackPackages?(
    choices: readonly PlaystackProductChoice[],
  ): Promise<readonly string[]>;
  selectPlaystackSurface?(
    kind: PlaystackSurfaceKind,
    choices: readonly PlaystackSurfaceChoice[],
  ): Promise<string>;
  selectAppType?(choices: readonly AppTypeChoice[]): Promise<string>;
  selectWebStyling?(choices: readonly WebStylingChoice[]): Promise<string>;
  inputDatabaseName?(initial: string): Promise<string>;
  selectDatabaseAdapter?(
    choices: readonly DatabaseAdapterChoice[],
  ): Promise<string>;
  confirmAddPlan?(message: string): Promise<boolean>;
  selectHostedAccount?(accounts: readonly HostedAccount[]): Promise<string>;
  readonly hostedAuth?: HostedAuthOperations;
  readonly hostedServiceUrl?: string;
  workspaceMutationState?(): Promise<WorkspaceMutationState>;
  activeToolchainState?(): Promise<ActiveToolchainState>;
  runCommand(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly capture?: boolean },
  ): Promise<CommandResult>;
}

export interface MegamonoBuildIdentity {
  readonly schemaVersion: 1;
  readonly package: string;
  readonly version: string;
  readonly revision: string;
  readonly dirty: boolean;
  readonly buildId: string;
}

export interface ActiveToolchainState {
  readonly node: string;
  readonly npm?: string;
  readonly pnpm?: string;
  readonly yarn?: string;
  readonly bun?: string;
}

export interface WorkspaceMutationState {
  readonly available: boolean;
  readonly clean: boolean;
  readonly branch?: string;
  readonly defaultBranch?: string;
}

export interface MegamonoCliResult {
  readonly exitCode: number;
}

interface InitOptions {
  readonly generatorArgs: readonly string[];
  readonly localPackages: LocalPackageSource;
  readonly playstack: boolean;
  readonly playstackCapabilities: readonly string[];
  readonly playstackPackages: readonly string[];
  readonly playstackSurfaces: Readonly<
    Record<PlaystackSurfaceKind, string | false | undefined>
  >;
  readonly selectPlaystackPackages: boolean;
  readonly survey: boolean;
  readonly dryRun: boolean;
}

export interface PlaystackProductChoice {
  readonly name: string;
  readonly message: string;
}

export type PlaystackSurfaceKind = 'web' | 'api';

export interface PlaystackSurfaceChoice {
  readonly name: string;
  readonly root: string;
  readonly message: string;
}

export interface AppTypeChoice {
  readonly name: string;
  readonly message: string;
}

export interface WebStylingChoice {
  readonly name: string;
  readonly message: string;
}

export interface DatabaseAdapterChoice {
  readonly name: string;
  readonly message: string;
}

export const APP_TYPE_CHOICES: readonly AppTypeChoice[] = [
  { name: 'web', message: 'Web — Next Pages Router with selectable styling' },
  { name: 'site', message: 'Site — Next marketing surface' },
  { name: 'api', message: 'API — Nest composition root and feature library' },
  { name: 'worker', message: 'Worker — Cloudflare Worker' },
  { name: 'mobile', message: 'Mobile — Expo application' },
  { name: 'desktop', message: 'Desktop — Tauri application' },
  { name: 'apple', message: 'Apple — native SwiftUI application' },
  { name: 'extension', message: 'Extension — WXT browser extension' },
];

export const WEB_STYLING_CHOICES: readonly WebStylingChoice[] = [
  { name: 'chakra', message: 'Chakra UI (suggested)' },
  { name: 'emotion', message: 'Emotion' },
  { name: 'tailwind', message: 'Tailwind CSS (also suits shadcn/ui)' },
  { name: 'panda', message: 'Panda CSS (also suits Park UI)' },
  { name: 'stylex', message: 'StyleX' },
  { name: 'css-modules', message: 'CSS Modules' },
  { name: 'inline', message: 'Inline styles (dependency-free fallback)' },
];

export const DATABASE_ADAPTER_CHOICES: readonly DatabaseAdapterChoice[] = [
  { name: 'prisma', message: 'Prisma (recommended)' },
  { name: 'drizzle', message: 'Drizzle' },
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
const WEB_STYLING_SET = new Set(WEB_STYLING_CHOICES.map(({ name }) => name));
const DATABASE_ADAPTER_SET = new Set(
  DATABASE_ADAPTER_CHOICES.map(({ name }) => name),
);

export const PLAYSTACK_PRODUCT_CHOICES: readonly PlaystackProductChoice[] = [
  { name: 'accounts', message: 'Accounts — tenancy and membership' },
  { name: 'auth', message: 'Auth — identity and sessions' },
  { name: 'billing', message: 'Billing — plans and subscriptions' },
  { name: 'content', message: 'Content — transforms and schemas' },
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

const executeFile = promisify(execFile);

const HELP = `Usage: megamono <command> [options]

Commands:
  init                 Adopt Megamono in an existing Nx workspace
  adopt                Survey first, then selectively adopt with --write
  add app [type]       Add a convention-aligned application
  add database [name]  Add a named Prisma or Drizzle database project
  add integration      Materialize package-authored Playstack wiring
  add <module>         Add one repository-governance module
  auth login|status|logout
                       Manage optional hosted-service authentication
  account list|use     List or switch personal and organization accounts
  health               Run workspace checks with a package-source profile
  verify <kind>        Verify runtime, dependency, or container portability
  generate <name>      Run an available local Megamono generator
  help                 Show this help

Global options:
  --version            Print the installed CLI version
  --version --json     Print version, revision, and build identity
  --help               Show this help

Init-only options:
  --playstack          Run package-owned Playstack setup after Megamono
  --playstack-packages[=<names>]
                       Select capabilities, or pass capabilities/package names
  --playstack-web=<path|false>
  --playstack-api=<path|false>
                       Select or suppress adopted application surface paths
  --local-packages=registry|yalc
                       Package source for missing local packages

All other init options are forwarded to @megamono/plugin:workspace-init.`;

const AUTH_HELP = `Usage: megamono auth <login|status|logout> [options]

Options:
  --service-url=<url>  Select the hosted service (default: https://app.megamono.com)
  --account=<id|slug>  Select an account immediately after login

Login opens a browser, uses S256 PKCE with a loopback callback, and stores
rotating credentials in the user configuration directory. Repository commands
continue to work without a hosted login.`;

const ACCOUNT_HELP = `Usage: megamono account list [--service-url=<url>]
       megamono account use [id|slug|name] [--service-url=<url>]

Account membership is user-scoped. Switching replaces the current bearer
session so later hosted operations are isolated to the selected personal or
organization account.`;

const ADD_HELP = `Usage: megamono add app [type] [options]
       megamono add database [name] [options]
       megamono add integration --packages=<names> [options]
       megamono add <module> [options]

Examples:
  megamono add app web
  megamono add app api --name=admin-api --interactive=false --yes
  megamono add app web --dry-run
  megamono add database events --adapter=drizzle
  megamono add database primary --adapter=prisma --interactive=false --yes
  megamono add integration --packages=@playstack/rate-limit --api=apps/api --dry-run
  megamono add docs
  megamono add ci --dry-run

Application types: ${APP_TYPE_CHOICES.map(({ name }) => name).join(', ')}
Web styling: ${WEB_STYLING_CHOICES.map(({ name }) => name).join(', ')}
Database adapters: ${DATABASE_ADAPTER_CHOICES.map(({ name }) => name).join(', ')}
Modules: ${ADD_MODULES.join(', ')}

Integration options:
  --web|--api|--worker|--portable=<root>
                       Map package-authored surfaces to reviewed Nx roots
  --adapters=<names>   Resolve adapter:<name> conditions
  --persistence=package|application
                       Select database artifact ownership
  --adoption-mode=fresh|compare|shadow|cutover
                       Record the migration phase
  --conditions='<json>'
                       Resolve package-authored contextual conditions
  --decisions='<json>' Resolve required package-authored decisions
  --equivalences='<json>'
                       Map requirements and templates to reviewed existing wiring
  --verification='<json>' --verification-project=<Nx name>
                       Map required test IDs to existing Nx targets
  --ci-workflow=<path> --ci-job=<name>
                       Append verification to an explicitly selected existing job
  --migration-stages='<json>'
                       Record verified compare/shadow/cutover/rollback transitions
  --composition='<json>'
                       Generate a shared Nest library module and optional AppModule connection
  --dry-run            Report templates, overlap, and unresolved choices
  --yes                Materialize verified templates after review

Add commands require an initialized workspace with local nx and @megamono/plugin.`;

const DATABASE_HELP = `Usage: megamono add database [name] [options]

Options:
  --adapter=prisma|drizzle
                       Select the database toolkit
  --directory=<path>   Select the Nx project root
  --project=<name>     Select the Nx project name
  --schema=<path>      Adopt an existing Prisma schema entry
  --relocate           Move the existing Prisma schema into the context project
  --client-output=<path>
                       Explicitly relocate generated client output too
  --target=<path>      Select the complete Playstack artifact target
  --scope=<scope>      Select the package and tag scope
  --dry-run            Preview without mutation
  --interactive=false  Disable prompts for automation
  --yes                Confirm a fully resolved non-interactive plan

Fresh projects default to libs/<adapter>/<name>. Existing Prisma layouts are adopted in place unless an explicit relocation operation is requested.`;

const INIT_HELP = `Usage: megamono init [generator options]

Examples:
  megamono init --survey
  megamono init --profile=pilot --dry-run
  megamono init --only=docs,agents --interactive=false --yes
  megamono init --playstack --playstack-packages=auth
  megamono init --playstack-packages=auth --playstack-web=apps/storefront --playstack-api=apps/gateway
  megamono init --playstack --local-packages=yalc

The workspace must contain local Nx. A read-only survey uses the local plugin
when present, or stages a matching plugin in a disposable directory from the
selected registry/Yalc source. Mutation still requires a local plugin.`;

const ADOPT_HELP = `Usage: megamono adopt [generator options]

Examples:
  megamono adopt
  megamono adopt --survey --format=json
  megamono adopt --only=health,inference,lint --dry-run
  megamono adopt --only=health,inference,lint --write --yes

Adopt is the mature-workspace entry point. It defaults to a read-only survey.
Pass --dry-run for an operation plan or --write to apply an accepted plan. All
workspace-init options are supported.`;

const HEALTH_HELP = `Usage: megamono health [--profile=development|migration|ci|release]

Runs the initialized workspace's structural check target. CI=true selects the
ci package-source profile when an explicit profile is absent.`;

const VERIFY_HELP = `Usage: megamono verify runtime <project> [options]
       megamono verify dependencies [options]
       megamono verify container [options]

Examples:
  megamono verify runtime api --outputPath=dist/apps/api
  megamono verify dependencies --checkActive=false
  megamono verify container --dockerfile=apps/api/Dockerfile
  megamono verify container --dockerfile=apps/api/Dockerfile --smoke

Verification is read-only unless container --smoke is explicitly requested.`;

function helpForTopic(topic: string | undefined): string {
  if (!topic) return HELP;
  const help: Readonly<Record<string, string>> = {
    init: INIT_HELP,
    adopt: ADOPT_HELP,
    add: ADD_HELP,
    database: DATABASE_HELP,
    health: HEALTH_HELP,
    verify: VERIFY_HELP,
    auth: AUTH_HELP,
    account: ACCOUNT_HELP,
  };
  const selected = help[topic];
  if (!selected)
    throw new CliError(`Unknown help topic ${topic}.\n\n${HELP}`, 2);
  return selected;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(
  root: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    return (
      await executeFile('git', [...args], { cwd: root, encoding: 'utf8' })
    ).stdout.trim();
  } catch {
    return undefined;
  }
}

async function collectWorkspaceMutationState(
  root: string,
): Promise<WorkspaceMutationState> {
  if (
    (await gitOutput(root, ['rev-parse', '--is-inside-work-tree'])) !== 'true'
  ) {
    return { available: false, clean: false };
  }
  const status = await gitOutput(root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  const branch = await gitOutput(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const remoteDefault = await gitOutput(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  const defaultBranch = remoteDefault?.replace(/^origin\//, '');
  return {
    available: true,
    clean: status === '',
    ...(branch ? { branch } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

async function assertWorkspaceMutationPreflight(
  io: MegamonoCliIo,
  workspace: Workspace,
  operation: string,
): Promise<void> {
  const state = io.workspaceMutationState
    ? await io.workspaceMutationState()
    : await collectWorkspaceMutationState(workspace.root);
  if (!state.available) {
    throw new CliError(`${operation} requires a Git worktree.`, 3);
  }
  if (!state.clean) {
    throw new CliError(`${operation} requires a clean working tree.`, 3);
  }
  if (!state.branch) {
    throw new CliError(
      `${operation} requires a named branch, not detached HEAD.`,
      3,
    );
  }
  if (!state.defaultBranch) {
    throw new CliError('The origin default branch could not be resolved.', 3);
  }
  if (state.branch === state.defaultBranch) {
    throw new CliError(
      `${operation} must not run on the default branch ${state.defaultBranch}.`,
      3,
    );
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
  const manifest = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as { packageManager?: unknown };
  const declaredValue =
    typeof manifest.packageManager === 'string'
      ? manifest.packageManager.split('@')[0]
      : undefined;
  if (declaredValue && !isPackageManager(declaredValue)) {
    throw new CliError(
      `package.json declares unsupported package manager ${manifest.packageManager}.`,
      3,
    );
  }
  const declared = declaredValue as PackageManager | undefined;
  const managers: PackageManager[] = [];
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
    if (
      (
        await Promise.all(
          packageManagerAdapter(manager).lockfiles.map((lockfile) =>
            exists(join(root, lockfile)),
          ),
        )
      ).some(Boolean)
    ) {
      managers.push(manager);
    }
  }
  if (managers.length > 1) {
    throw new CliError(
      `Conflicting root package-manager lockfiles are not supported: ${managers.join(', ')}. Nested project lockfiles are ignored.`,
      3,
    );
  }
  const locked = managers[0];
  if (declared && locked && declared !== locked) {
    throw new CliError(
      `package.json declares ${manifest.packageManager}, but the root lockfile belongs to ${locked}.`,
      3,
    );
  }
  const selected = locked ?? declared;
  if (!selected) {
    throw new CliError(
      'Declare packageManager in package.json or commit one root lockfile: package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lock, or bun.lockb.',
      3,
    );
  }
  return selected;
}

interface VersionNumber {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function versionNumber(value: string | undefined): VersionNumber | undefined {
  const match = value?.match(/(?:^|[^0-9])(\d+)\.(\d+)(?:\.(\d+))?/);
  return match
    ? {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3] ?? 0),
      }
    : undefined;
}

function compareVersion(left: VersionNumber, right: VersionNumber): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

async function collectActiveToolchainState(
  manager: PackageManager,
): Promise<ActiveToolchainState> {
  let managerVersion: string | undefined;
  try {
    managerVersion = (
      await executeFile(manager, ['--version'], { encoding: 'utf8' })
    ).stdout.trim();
  } catch {
    // The structured preflight below reports the missing executable.
  }
  return {
    node: process.version,
    ...(managerVersion ? { [manager]: managerVersion } : {}),
  };
}

async function assertActiveToolchainPreflight(
  io: MegamonoCliIo,
  workspace: Workspace,
): Promise<void> {
  const state = io.activeToolchainState
    ? await io.activeToolchainState()
    : await collectActiveToolchainState(workspace.packageManager);
  const node = versionNumber(state.node);
  if (
    !node ||
    compareVersion(node, { major: 18, minor: 18, patch: 0 }) < 0 ||
    compareVersion(node, { major: 25, minor: 0, patch: 0 }) >= 0
  ) {
    throw new CliError(
      `Active Node.js ${state.node || 'unknown'} is unsupported for adoption; expected >=18.18 <25. Switch runtimes before Megamono invokes the workspace package manager. After adoption, --toolchainPin can record the selected runtime.`,
      3,
    );
  }
  const active = state[workspace.packageManager];
  const managerVersion = versionNumber(active);
  const adapter = packageManagerAdapter(workspace.packageManager);
  const [minimumMajor, minimumMinor] = adapter.minimumVersion;
  if (
    !managerVersion ||
    compareVersion(managerVersion, {
      major: minimumMajor,
      minor: minimumMinor,
      patch: 0,
    }) < 0 ||
    managerVersion.major >= adapter.maximumMajorExclusive
  ) {
    throw new CliError(
      `Active ${workspace.packageManager} ${active ?? 'unknown'} cannot execute this adoption; expected >=${minimumMajor}.${minimumMinor} <${adapter.maximumMajorExclusive}. The repository remains eligible—activate its selected package manager, then retry.`,
      3,
    );
  }
  const manifest = JSON.parse(
    await readFile(join(workspace.root, 'package.json'), 'utf8'),
  ) as { packageManager?: unknown };
  const declared =
    typeof manifest.packageManager === 'string'
      ? manifest.packageManager
      : undefined;
  const [declaredName, declaredValue] = declared?.split('@') ?? [];
  const declaredVersion = versionNumber(declaredValue);
  if (
    declaredName === workspace.packageManager &&
    declaredVersion &&
    declaredVersion.major !== managerVersion.major
  ) {
    const activation =
      workspace.packageManager === 'pnpm'
        ? ` Run: corepack enable && corepack prepare ${declared} --activate.`
        : '';
    throw new CliError(
      `Active ${workspace.packageManager} ${active} does not match the workspace-declared ${declared} major.${activation}`,
      3,
    );
  }
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

interface PlaystackSelection {
  readonly capabilities: readonly string[];
  readonly packages: readonly string[];
}

function parsePlaystackPackages(value: string): PlaystackSelection {
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
  const capabilities: string[] = [];
  const packages: string[] = [];
  for (const name of requested) {
    if (name.startsWith('@')) {
      if (
        !/^@playstack\/[a-z0-9][a-z0-9._-]*$/.test(name) ||
        name === '@playstack/cli'
      ) {
        throw new CliError(
          `Invalid Playstack package ${name}; expected @playstack/<name>.`,
          2,
        );
      }
      packages.push(name);
      continue;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw new CliError(
        `Invalid Playstack capability ${name}; expected a capability name or @playstack/<name>.`,
        2,
      );
    }
    capabilities.push(name);
  }
  return {
    capabilities: [...new Set(capabilities)].sort(),
    packages: [...new Set(packages)].sort(),
  };
}

function parseInitOptions(args: readonly string[]): InitOptions {
  const forwarded: string[] = [];
  let localPackages: LocalPackageSource = 'registry';
  let playstack = false;
  let playstackCapabilities: readonly string[] = [];
  let playstackPackages: readonly string[] = [];
  const playstackSurfaces: Record<
    PlaystackSurfaceKind,
    string | false | undefined
  > = { web: undefined, api: undefined };
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
    let matchedSurface = false;
    for (const kind of ['web', 'api'] as const) {
      const surface = optionValue(args, index, `--playstack-${kind}`);
      if (!surface) continue;
      playstackSurfaces[kind] =
        surface.value === 'false' ? false : surface.value;
      playstack = true;
      index += surface.consumed;
      matchedSurface = true;
      break;
    }
    if (matchedSurface) continue;
    const products = optionValue(args, index, '--playstack-packages');
    if (products) {
      const selection = parsePlaystackPackages(products.value);
      playstackCapabilities = selection.capabilities;
      playstackPackages = selection.packages;
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
    playstackCapabilities,
    playstackPackages,
    playstackSurfaces,
    selectPlaystackPackages,
    survey: forwarded.some(
      (argument) => argument === '--survey' || argument === '--survey=true',
    ),
    dryRun: forwarded.some(
      (argument) => argument === '--dry-run' || argument === '--dry-run=true',
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
    playstackCapabilities: parsePlaystackPackages(selected.join(','))
      .capabilities,
    playstackPackages: [],
    selectPlaystackPackages: false,
  };
}

function interactionDisabled(args: readonly string[]): boolean {
  return args.some(
    (argument, index) =>
      argument === '--no-interactive' ||
      argument === '--interactive=false' ||
      (argument === '--interactive' && args[index + 1] === 'false'),
  );
}

function nxInvocation(
  manager: PackageManager,
  generatorArgs: readonly string[],
  generator = 'workspace-init',
): readonly [string, readonly string[]] {
  return packageManagerAdapter(manager).exec('nx', [
    'generate',
    `@megamono/plugin:${generator}`,
    ...generatorArgs,
  ]);
}

function nxCommandInvocation(
  manager: PackageManager,
  args: readonly string[],
): readonly [string, readonly string[]] {
  return packageManagerAdapter(manager).exec('nx', args);
}

function localNxCommandInvocation(
  root: string,
  args: readonly string[],
): readonly [string, readonly string[]] {
  const require = createRequire(join(root, 'package.json'));
  const manifestPath = require.resolve(['nx', 'package.json'].join('/'));
  const manifest = require(manifestPath) as {
    readonly bin?: string | Readonly<Record<string, string>>;
  };
  const relativeBin =
    (typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.nx) ??
    './bin/nx.js';
  return [
    process.execPath,
    [resolve(dirname(manifestPath), relativeBin), ...args],
  ];
}

function localNxVersion(root: string): string {
  const require = createRequire(join(root, 'package.json'));
  const manifestPath = require.resolve(['nx', 'package.json'].join('/'));
  const manifest = require(manifestPath) as { readonly version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new CliError(
      'The workspace-local Nx package does not declare a usable version.',
      3,
    );
  }
  return manifest.version;
}

async function surveyNpmInvocation(): Promise<
  readonly [string, readonly string[]]
> {
  // Do not execute a PATH-selected npm shim: its shebang may select a different
  // Node major than the one that passed the CLI's compatibility preflight.
  const candidates = [
    resolve(
      dirname(process.execPath),
      '../lib/node_modules/npm/bin/npm-cli.js',
    ),
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../share/nodejs/npm/bin/npm-cli.js'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return [process.execPath, [candidate]];
    } catch {
      // Try the next standard Node distribution layout.
    }
  }
  throw new CliError(
    `Cannot locate npm alongside the active Node runtime (${process.execPath}). Install npm for this Node installation before running an ephemeral survey; the repository has not been changed.`,
    3,
  );
}

async function runEphemeralPluginSurvey(
  io: MegamonoCliIo,
  root: string,
  options: InitOptions,
): Promise<MegamonoCliResult> {
  const [npmCommand, npmArgs] = await surveyNpmInvocation();
  const directory = await mkdtemp(join(tmpdir(), 'megamono-survey-'));
  try {
    await writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify({ private: true }, null, 2)}\n`,
      'utf8',
    );
    if (options.localPackages === 'yalc') {
      const added = await io.runCommand(
        'yalc',
        ['add', '@megamono/plugin', '--dev', '--no-pure'],
        { cwd: directory },
      );
      if (added.exitCode !== 0) {
        throw new CliError(
          'Unable to stage @megamono/plugin from Yalc for the read-only survey. Publish it locally and retry.',
          3,
        );
      }
    }
    const packages = [
      `nx@${localNxVersion(root)}`,
      ...(options.localPackages === 'registry'
        ? [`@megamono/plugin@${io.version}`]
        : []),
    ];
    const installed = await io.runCommand(
      npmCommand,
      [
        ...npmArgs,
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--save-dev',
        ...packages,
      ],
      { cwd: directory },
    );
    if (installed.exitCode !== 0) {
      throw new CliError(
        `Unable to stage the ephemeral survey runtime from ${options.localPackages}. The repository was not modified.`,
        3,
      );
    }
    // Run the workspace's declared Nx executable. A staged launcher would
    // redispatch to local Nx anyway; an absolute collection keeps the temporary
    // plugin resolvable without adding it to the consumer's dependencies.
    const [command, args] = localNxCommandInvocation(root, [
      'generate',
      `${join(directory, 'node_modules', '@megamono', 'plugin', 'generators.json')}:workspace-init`,
      ...options.generatorArgs.filter(
        (argument) =>
          !/^--(?:survey|dry-run|dryRun|interactive)(?:=|$)/.test(argument),
      ),
      '--survey=true',
      '--dry-run',
      '--interactive=false',
    ]);
    const surveyed = await io.runCommand(command, args, { cwd: root });
    return { exitCode: surveyed.exitCode };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface NxSurfaceProject {
  readonly name: string;
  readonly root: string;
  readonly projectType?: string;
  readonly tags: readonly string[];
}

function normalizedSurfacePath(value: string, option: string): string {
  const normalized = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.split('/').includes('..')
  ) {
    throw new CliError(
      `${option} must be a workspace-relative Nx project root or false.`,
      2,
    );
  }
  return normalized;
}

async function inspectNxSurfaceProjects(
  io: MegamonoCliIo,
  workspace: Workspace,
): Promise<readonly NxSurfaceProject[]> {
  const [listCommand, listArgs] = nxCommandInvocation(
    workspace.packageManager,
    ['show', 'projects', '--json'],
  );
  const listed = await io.runCommand(listCommand, listArgs, {
    cwd: workspace.root,
    capture: true,
  });
  if (listed.exitCode !== 0 || !listed.stdout) {
    throw new CliError(
      'Megamono initialization completed, but the Nx project graph could not be inspected for Playstack surfaces.',
      3,
    );
  }
  let names: unknown;
  try {
    names = JSON.parse(listed.stdout);
  } catch {
    throw new CliError(
      'Megamono initialization completed, but Nx returned invalid project-list JSON while resolving Playstack surfaces.',
      3,
    );
  }
  if (
    !Array.isArray(names) ||
    !names.every((name) => typeof name === 'string')
  ) {
    throw new CliError(
      'Megamono initialization completed, but Nx returned an invalid project list while resolving Playstack surfaces.',
      3,
    );
  }

  const projects: NxSurfaceProject[] = [];
  for (const name of [...names].sort()) {
    const [showCommand, showArgs] = nxCommandInvocation(
      workspace.packageManager,
      ['show', 'project', name, '--json'],
    );
    const shown = await io.runCommand(showCommand, showArgs, {
      cwd: workspace.root,
      capture: true,
    });
    if (shown.exitCode !== 0 || !shown.stdout) {
      throw new CliError(
        `Megamono initialization completed, but Nx project ${name} could not be inspected for Playstack surfaces.`,
        3,
      );
    }
    let project: unknown;
    try {
      project = JSON.parse(shown.stdout);
    } catch {
      throw new CliError(
        `Megamono initialization completed, but Nx returned invalid JSON for project ${name}.`,
        3,
      );
    }
    if (
      typeof project !== 'object' ||
      project === null ||
      typeof (project as { root?: unknown }).root !== 'string'
    ) {
      throw new CliError(
        `Megamono initialization completed, but Nx project ${name} has no project root.`,
        3,
      );
    }
    const value = project as {
      root: string;
      projectType?: unknown;
      tags?: unknown;
    };
    projects.push({
      name,
      root: normalizedSurfacePath(value.root, `Nx project ${name}`),
      ...(typeof value.projectType === 'string'
        ? { projectType: value.projectType }
        : {}),
      tags: Array.isArray(value.tags)
        ? value.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
    });
  }
  return projects;
}

function surfaceCandidates(
  kind: PlaystackSurfaceKind,
  projects: readonly NxSurfaceProject[],
): readonly NxSurfaceProject[] {
  return projects.filter((project) => {
    const tags = new Set(project.tags);
    const application =
      project.projectType === 'application' ||
      tags.has('type:app') ||
      project.root.startsWith('apps/');
    if (!application || project.root === '.megamono') return false;
    if (kind === 'web') {
      return (
        tags.has('platform:web') ||
        project.root === 'apps/web' ||
        project.root === 'apps/site'
      );
    }
    return tags.has('platform:node') || project.root === 'apps/api';
  });
}

async function resolvePlaystackSurface(
  kind: PlaystackSurfaceKind,
  projects: readonly NxSurfaceProject[],
  override: string | false | undefined,
  interactive: boolean,
  io: MegamonoCliIo,
): Promise<string | undefined> {
  if (override === false) return undefined;
  if (typeof override === 'string') {
    const root = normalizedSurfacePath(override, `--playstack-${kind}`);
    if (!projects.some((project) => project.root === root)) {
      throw new CliError(
        `--playstack-${kind}=${root} does not match an Nx project root.`,
        3,
      );
    }
    return root;
  }

  const candidates = surfaceCandidates(kind, projects);
  if (candidates.length === 0) return undefined;
  const conventional = candidates.find(
    (project) => project.root === `apps/${kind}`,
  );
  if (conventional) return conventional.root;
  if (candidates.length === 1) return candidates[0].root;

  const choices = candidates.map((project) => ({
    name: project.name,
    root: project.root,
    message: `${project.name} — ${project.root}`,
  }));
  if (!interactive || !io.selectPlaystackSurface) {
    throw new CliError(
      `Multiple Playstack ${kind} surfaces were found: ${choices
        .map(({ root }) => root)
        .join(', ')}. Pass --playstack-${kind}=<path> in automation.`,
      4,
    );
  }
  const selected = await io.selectPlaystackSurface(kind, choices);
  const choice = choices.find(
    ({ root, name }) => selected === root || selected === name,
  );
  if (!choice) {
    throw new CliError(
      `Playstack ${kind} surface selection returned an unknown project.`,
      2,
    );
  }
  return choice.root;
}

async function resolvePlaystackSurfaces(
  io: MegamonoCliIo,
  workspace: Workspace,
  options: InitOptions,
): Promise<Readonly<Partial<Record<PlaystackSurfaceKind, string>>>> {
  if (options.playstackCapabilities.length === 0) return {};
  const projects = await inspectNxSurfaceProjects(io, workspace);
  const interactive = !interactionDisabled(options.generatorArgs);
  const web = await resolvePlaystackSurface(
    'web',
    projects,
    options.playstackSurfaces.web,
    interactive,
    io,
  );
  const api = await resolvePlaystackSurface(
    'api',
    projects,
    options.playstackSurfaces.api,
    interactive,
    io,
  );
  return { ...(web ? { web } : {}), ...(api ? { api } : {}) };
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
  await assertActiveToolchainPreflight(io, { root, packageManager: manager });
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
  args: readonly string[],
): readonly [string, readonly string[]] {
  return packageManagerAdapter(manager).exec('playstack', args);
}

function pluginInstallInstruction(
  manager: PackageManager,
  source: LocalPackageSource,
): string {
  if (source === 'yalc') {
    return `yalc add @megamono/plugin --dev --no-pure && ${manager} install`;
  }
  return [
    manager,
    ...packageManagerAdapter(manager).addArgs(['@megamono/plugin'], {
      development: true,
    }),
  ].join(' ');
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

interface YalcPackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<
    Record<string, { readonly optional?: boolean }>
  >;
}

interface YalcClosurePackage {
  readonly name: string;
  readonly version: string;
  readonly manifest: YalcPackageManifest;
}

interface YalcClosurePlan {
  readonly packages: readonly YalcClosurePackage[];
  readonly externalPackages: readonly string[];
}

function parsedVersion(
  value: string,
): readonly (number | string)[] | undefined {
  const match = value.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return undefined;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    ...(match[4]
      ? match[4]
          .split('.')
          .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : []),
  ];
}

function compareVersions(left: string, right: string): number {
  const a = parsedVersion(left);
  const b = parsedVersion(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  const aPre = a.slice(3);
  const bPre = b.slice(3);
  if (aPre.length === 0 || bPre.length === 0) {
    return aPre.length === bPre.length ? 0 : aPre.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(aPre.length, bPre.length); index += 1) {
    if (aPre[index] === undefined) return -1;
    if (bPre[index] === undefined) return 1;
    const aPart = aPre[index];
    const bPart = bPre[index];
    if (aPart === bPart) continue;
    if (typeof aPart === 'number' && typeof bPart === 'number') {
      return aPart - bPart;
    }
    if (typeof aPart === 'number') return -1;
    if (typeof bPart === 'number') return 1;
    return String(aPart).localeCompare(String(bPart));
  }
  return 0;
}

function versionSatisfies(version: string, rawRange: string): boolean {
  const range = rawRange.replace(/^workspace:/, '');
  if (range === '*' || range === 'latest') return true;
  if (range.startsWith('^') || range.startsWith('~')) {
    const requested = range.slice(1);
    const current = parsedVersion(version);
    const minimum = parsedVersion(requested);
    if (!current || !minimum || compareVersions(version, requested) < 0)
      return false;
    const [major, minor] = minimum as readonly number[];
    if (range.startsWith('~')) {
      return current[0] === major && current[1] === minor;
    }
    if (major > 0) return current[0] === major;
    if (minor > 0) return current[0] === 0 && current[1] === minor;
    return current[0] === 0 && current[1] === 0 && current[2] === minimum[2];
  }
  return version === range;
}

async function readYalcPackage(
  store: string,
  packageName: string,
  range?: string,
): Promise<YalcClosurePackage> {
  let versions: readonly string[];
  try {
    versions = (await readdir(yalcPackagePath(store, packageName))).sort(
      compareVersions,
    );
  } catch {
    versions = [];
  }
  const version = [...versions]
    .reverse()
    .find((candidate) => !range || versionSatisfies(candidate, range));
  if (!version) {
    throw new CliError(
      `The yalc store has no ${packageName}${range ? ` version compatible with ${range}` : ''}. Publish a compatible package before retrying.`,
      3,
    );
  }
  const manifestPath = join(
    yalcPackagePath(store, packageName),
    version,
    'package.json',
  );
  let manifest: YalcPackageManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new CliError(`Invalid yalc manifest at ${manifestPath}.`, 3);
  }
  if (manifest.name !== packageName || manifest.version !== version) {
    throw new CliError(
      `The yalc manifest at ${manifestPath} does not match ${packageName}@${version}.`,
      3,
    );
  }
  return { name: packageName, version, manifest };
}

function packageEntries(
  manifest: YalcPackageManifest,
): readonly (readonly [string, string, boolean])[] {
  const entries: (readonly [string, string, boolean])[] = [];
  for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
    entries.push([name, range, true]);
  }
  for (const [name, range] of Object.entries(
    manifest.optionalDependencies ?? {},
  )) {
    entries.push([name, range, false]);
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    entries.push([
      name,
      range,
      manifest.peerDependenciesMeta?.[name]?.optional !== true,
    ]);
  }
  return entries;
}

async function resolveYalcClosure(
  store: string,
  roots: readonly string[],
): Promise<YalcClosurePlan> {
  const selected = new Map<string, YalcClosurePackage>();
  const external = new Map<string, string>();

  const visit = async (
    packageName: string,
    range?: string,
    required = true,
  ): Promise<void> => {
    const existing = selected.get(packageName);
    if (existing) {
      if (range && !versionSatisfies(existing.version, range)) {
        throw new CliError(
          `The local Playstack closure requires incompatible ${packageName} versions (${existing.version} and ${range}).`,
          3,
        );
      }
      return;
    }
    let artifact: YalcClosurePackage;
    try {
      artifact = await readYalcPackage(store, packageName, range);
    } catch (error) {
      if (!required) return;
      throw error;
    }
    selected.set(packageName, artifact);
    for (const [
      dependency,
      dependencyRange,
      dependencyRequired,
    ] of packageEntries(artifact.manifest)) {
      if (dependency.startsWith('@playstack/')) {
        await visit(dependency, dependencyRange, dependencyRequired);
        continue;
      }
      if (!dependencyRequired) continue;
      const prior = external.get(dependency);
      if (prior && prior !== dependencyRange) {
        throw new CliError(
          `The local Playstack closure requires conflicting ${dependency} ranges (${prior} and ${dependencyRange}).`,
          3,
        );
      }
      external.set(dependency, dependencyRange);
    }
  };

  for (const root of [...roots].sort()) await visit(root);
  return {
    packages: [...selected.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    externalPackages: [...external.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, range]) => `${name}@${range}`),
  };
}

interface WorkspaceDependencyState {
  readonly declared: ReadonlySet<string>;
  readonly yalc: ReadonlySet<string>;
}

async function workspaceDependencyState(
  root: string,
): Promise<WorkspaceDependencyState> {
  const manifest = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as {
    dependencies?: Readonly<Record<string, string>>;
    devDependencies?: Readonly<Record<string, string>>;
    optionalDependencies?: Readonly<Record<string, string>>;
  };
  const entries = [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.devDependencies ?? {}),
    ...Object.entries(manifest.optionalDependencies ?? {}),
  ];
  return {
    declared: new Set(entries.map(([name]) => name)),
    yalc: new Set(
      entries
        .filter(([, specifier]) => specifier.startsWith('file:.yalc/'))
        .map(([name]) => name),
    ),
  };
}

async function rewriteYalcClosureManifests(
  workspaceRoot: string,
  closure: YalcClosurePlan,
  linkedPackages: ReadonlySet<string>,
): Promise<void> {
  for (const artifact of closure.packages) {
    if (!linkedPackages.has(artifact.name)) continue;
    const directory = join(workspaceRoot, '.yalc', ...artifact.name.split('/'));
    const path = join(directory, 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
    for (const section of ['dependencies', 'optionalDependencies'] as const) {
      const dependencies = manifest[section];
      if (
        typeof dependencies !== 'object' ||
        dependencies === null ||
        Array.isArray(dependencies)
      ) {
        continue;
      }
      const rewritten = { ...(dependencies as Record<string, string>) };
      for (const dependency of Object.keys(rewritten)) {
        if (!linkedPackages.has(dependency)) continue;
        const target = join(workspaceRoot, '.yalc', ...dependency.split('/'));
        rewritten[dependency] =
          `file:${relative(directory, target).replaceAll('\\', '/')}`;
      }
      manifest[section] = rewritten;
    }
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
}

async function preflightYalc(
  io: MegamonoCliIo,
  workspace: Workspace,
  packages: readonly string[],
): Promise<string | undefined> {
  if (packages.length === 0) return undefined;
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
  return store;
}

async function runRequired(
  io: MegamonoCliIo,
  workspace: Workspace,
  command: string,
  args: readonly string[],
  recovery: string,
  completed?: string[],
): Promise<void> {
  const rendered = `${command} ${args.join(' ')}`;
  const completedMessage = () =>
    completed && completed.length > 0
      ? ` Completed commands: ${completed.join('; ')}.`
      : '';
  let result: CommandResult;
  try {
    result = await io.runCommand(command, args, { cwd: workspace.root });
  } catch (error) {
    throw new CliError(
      `Megamono initialization completed, but Playstack setup could not run ${command}: ${
        error instanceof Error ? error.message : String(error)
      }.${completedMessage()} Retry: ${recovery}`,
      3,
    );
  }
  if (result.exitCode !== 0) {
    throw new CliError(
      `Megamono initialization completed, but Playstack setup failed.${completedMessage()} Retry: ${recovery}`,
      3,
    );
  }
  completed?.push(rendered);
}

async function installPlaystackPackages(
  io: MegamonoCliIo,
  workspace: Workspace,
  options: InitOptions,
  directYalcClosure?: YalcClosurePlan,
): Promise<void> {
  const completed: string[] = [];
  const needsCli = !localPackageAvailable(workspace.root, '@playstack/cli');
  const dependencyState = await workspaceDependencyState(workspace.root);
  const products = options.playstackPackages.filter(
    (packageName) =>
      !localPackageAvailable(workspace.root, packageName) &&
      !dependencyState.yalc.has(packageName),
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
        completed,
      );
    }
    const closure = directYalcClosure;
    const externalPackages = (closure?.externalPackages ?? []).filter(
      (specifier) => {
        const separator = specifier.lastIndexOf('@');
        const name = specifier.startsWith('@')
          ? specifier.slice(0, separator)
          : specifier.slice(0, separator === -1 ? undefined : separator);
        return !dependencyState.declared.has(name);
      },
    );
    if (externalPackages.length > 0) {
      const installArgs = packageManagerAdapter(
        workspace.packageManager,
      ).addArgs(externalPackages);
      await runRequired(
        io,
        workspace,
        workspace.packageManager,
        installArgs,
        `${workspace.packageManager} ${installArgs.join(' ')}`,
        completed,
      );
    }
    const closurePackages = (closure?.packages ?? [])
      .filter(
        ({ name }) =>
          !localPackageAvailable(workspace.root, name) &&
          !dependencyState.yalc.has(name),
      )
      .map(({ name, version }) => `${name}@${version}`);
    if (closurePackages.length > 0) {
      await runRequired(
        io,
        workspace,
        'yalc',
        ['add', ...closurePackages, '--no-pure'],
        `yalc add ${closurePackages.join(' ')} --no-pure`,
        completed,
      );
    }
    if (closure) {
      await rewriteYalcClosureManifests(
        workspace.root,
        closure,
        new Set([
          ...dependencyState.yalc,
          ...closurePackages.map((specifier) =>
            specifier.slice(0, specifier.lastIndexOf('@')),
          ),
        ]),
      );
    }
    await runRequired(
      io,
      workspace,
      workspace.packageManager,
      packageManagerAdapter(workspace.packageManager).installArgs(),
      `${workspace.packageManager} install`,
      completed,
    );
    return;
  }

  if (needsCli) {
    const installArgs = packageManagerAdapter(workspace.packageManager).addArgs(
      ['@playstack/cli'],
      { development: true },
    );
    await runRequired(
      io,
      workspace,
      workspace.packageManager,
      installArgs,
      `${workspace.packageManager} ${installArgs.join(' ')}`,
      completed,
    );
  }
  if (products.length > 0) {
    const installArgs = packageManagerAdapter(workspace.packageManager).addArgs(
      products,
    );
    await runRequired(
      io,
      workspace,
      workspace.packageManager,
      installArgs,
      `${workspace.packageManager} ${installArgs.join(' ')}`,
      completed,
    );
  }
}

async function addPlaystackCapabilities(
  io: MegamonoCliIo,
  workspace: Workspace,
  options: InitOptions,
  surfaces: Readonly<Partial<Record<PlaystackSurfaceKind, string>>>,
  dryRun = false,
): Promise<void> {
  for (const capability of options.playstackCapabilities) {
    const args = [
      'add',
      capability,
      '--yes',
      ...(dryRun ? ['--dry-run'] : []),
      ...(surfaces.web ? [`--web=${surfaces.web}`] : []),
      ...(surfaces.api ? [`--api=${surfaces.api}`] : []),
      ...(options.localPackages === 'yalc' ? ['--local-packages=yalc'] : []),
    ];
    const [command, commandArgs] = playstackInvocation(
      workspace.packageManager,
      args,
    );
    await runRequired(
      io,
      workspace,
      command,
      commandArgs,
      `${command} ${commandArgs.join(' ')}`,
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

async function pluginPlaystackCompatibility(root: string): Promise<{
  readonly node: string;
  readonly eslint: string;
}> {
  const manifest = createRequire(join(root, 'package.json')).resolve(
    '@megamono/plugin/package.json',
  );
  const compatibility = JSON.parse(
    await readFile(join(dirname(manifest), 'compatibility.json'), 'utf8'),
  ) as {
    playstackIntegration?: { node?: unknown; eslint?: unknown };
  };
  const node = compatibility.playstackIntegration?.node;
  const eslint = compatibility.playstackIntegration?.eslint;
  if (typeof node !== 'string' || typeof eslint !== 'string') {
    throw new CliError(
      'The local @megamono/plugin does not declare Playstack compatibility.',
      3,
    );
  }
  return { node, eslint };
}

function versionMajor(value: string | undefined): number | undefined {
  const match = value?.match(/(?:^|[^0-9])(\d+)(?:\.\d+)?/);
  return match ? Number(match[1]) : undefined;
}

async function assertPlaystackCompatibility(
  root: string,
  packages: readonly string[],
): Promise<void> {
  const compatibility = await pluginPlaystackCompatibility(root);
  const manifest = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as {
    engines?: { node?: unknown };
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  const declaredNode = manifest.engines?.node;
  if (typeof declaredNode === 'string') {
    const lowerBound = declaredNode.match(/>=\s*(\d+)/)?.[1];
    const declaredMajor = lowerBound
      ? Number(lowerBound)
      : versionMajor(declaredNode);
    if (declaredMajor === undefined || declaredMajor < 20) {
      throw new CliError(
        `Playstack packages require Node ${compatibility.node}, but package.json engines.node is ${declaredNode}. Narrow the workspace engine before enabling Playstack.`,
        3,
      );
    }
  } else if (Number(process.versions.node.split('.')[0]) < 20) {
    throw new CliError(
      `Playstack packages require Node ${compatibility.node}; the current runtime is ${process.version}.`,
      3,
    );
  }
  if (packages.includes('@playstack/lint')) {
    const declaredEslint =
      manifest.devDependencies?.eslint ?? manifest.dependencies?.eslint;
    if (
      typeof declaredEslint !== 'string' ||
      versionMajor(declaredEslint) !== 9
    ) {
      throw new CliError(
        `Playstack lint requires ESLint ${compatibility.eslint}; the workspace declares ${
          typeof declaredEslint === 'string'
            ? declaredEslint
            : 'no ESLint version'
        }.`,
        3,
      );
    }
  }
}

function requiredAppPlugins(type: string): readonly string[] {
  if (type === 'web' || type === 'site')
    return ['@nx/next', '@nx/playwright', '@nx/js', '@nx/eslint'];
  if (type === 'api') return ['@nx/nest', '@nx/jest', '@nx/eslint'];
  if (type === 'mobile') return ['@nx/expo'];
  if (type === 'worker') return ['@megamono/nx-cloudflare'];
  if (type === 'apple') return ['@megamono/nx-apple'];
  if (type === 'desktop') return ['@megamono/nx-cargo'];
  if (type === 'extension') return ['@megamono/nx-extension'];
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
): Promise<readonly string[]> {
  const missing = packages.filter(
    (packageName) => !localPackageAvailable(workspace.root, packageName),
  );
  if (missing.length === 0) return [];
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
    await runAddCommand(io, workspace, workspace.packageManager, [
      ...packageManagerAdapter(workspace.packageManager).addArgs(specs, {
        development: true,
      }),
    ]);
  }
  if (registry.length > 0) {
    const nxVersion = await localPackageVersion(workspace.root, 'nx');
    await runAddCommand(io, workspace, workspace.packageManager, [
      ...packageManagerAdapter(workspace.packageManager).addArgs(
        registry.map((name) => `${name}@${nxVersion}`),
        { development: true },
      ),
    ]);
  }
  if (source === 'yalc' && local.length > 0) {
    await runAddCommand(
      io,
      workspace,
      workspace.packageManager,
      packageManagerAdapter(workspace.packageManager).installArgs(),
    );
  }
  return missing;
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

async function resolveWebStyling(
  io: MegamonoCliIo,
  type: string,
  options: AddOptions,
): Promise<string | undefined> {
  if (type !== 'web' && type !== 'site') return undefined;
  const explicit = explicitOption(options.args, '--styling');
  if (explicit) {
    if (explicit !== 'auto' && !WEB_STYLING_SET.has(explicit)) {
      throw new CliError(
        `Unknown web styling ${explicit}. Expected one of: auto, ${[...WEB_STYLING_SET].join(', ')}.`,
        2,
      );
    }
    return explicit;
  }
  if (!options.interactive || !io.selectWebStyling) return undefined;
  const selected = await io.selectWebStyling(WEB_STYLING_CHOICES);
  if (!WEB_STYLING_SET.has(selected)) {
    throw new CliError('Web styling selection was cancelled.', 2);
  }
  return selected;
}

function explicitOption(
  args: readonly string[],
  name: string,
): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const option = optionValue(args, index, name);
    if (option) return option.value;
  }
  return undefined;
}

function databaseName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
    throw new CliError(
      'Database name must be a normalized slug such as primary, events, or regional-us.',
      2,
    );
  }
  return normalized;
}

async function resolveDatabaseName(
  io: MegamonoCliIo,
  value: string | undefined,
  options: AddOptions,
): Promise<string> {
  if (value && !value.startsWith('-')) return databaseName(value);
  if (!options.interactive || !io.inputDatabaseName) {
    throw new CliError('Database name is required in non-interactive mode.', 4);
  }
  return databaseName(await io.inputDatabaseName('primary'));
}

async function resolveDatabaseAdapter(
  io: MegamonoCliIo,
  args: readonly string[],
  options: AddOptions,
): Promise<string> {
  const explicit = explicitOption(args, '--adapter');
  if (explicit) {
    if (!DATABASE_ADAPTER_SET.has(explicit)) {
      throw new CliError(
        `Unknown database adapter ${explicit}. Expected one of: ${[
          ...DATABASE_ADAPTER_SET,
        ].join(', ')}.`,
        2,
      );
    }
    return explicit;
  }
  if (!options.interactive || !io.selectDatabaseAdapter) {
    throw new CliError(
      `Database adapter is required in non-interactive mode. Expected one of: ${[
        ...DATABASE_ADAPTER_SET,
      ].join(', ')}.`,
      4,
    );
  }
  const selected = await io.selectDatabaseAdapter(DATABASE_ADAPTER_CHOICES);
  if (!DATABASE_ADAPTER_SET.has(selected)) {
    throw new CliError('Database adapter selection was cancelled.', 2);
  }
  return selected;
}

async function addWorkspace(io: MegamonoCliIo): Promise<Workspace> {
  const root = await findWorkspaceRoot(io.cwd);
  const workspace = { root, packageManager: await detectPackageManager(root) };
  await assertActiveToolchainPreflight(io, workspace);
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
  if (subject === 'integration') {
    const parsed = parseAddOptions(args.slice(1));
    if (!parsed.dryRun)
      await assertWorkspaceMutationPreflight(
        io,
        workspace,
        'Playstack integration generation',
      );
    const [command, commandArgs] = nxInvocation(
      workspace.packageManager,
      parsed.args,
      'playstack-integrate',
    );
    const generated = await io.runCommand(command, commandArgs, {
      cwd: workspace.root,
    });
    return { exitCode: generated.exitCode };
  }
  if (subject === 'database') {
    const hasPositionalName = Boolean(args[1] && !args[1]?.startsWith('-'));
    const parsed = parseAddOptions(args.slice(hasPositionalName ? 2 : 1));
    const name = await resolveDatabaseName(
      io,
      hasPositionalName ? args[1] : undefined,
      parsed,
    );
    const adapter = await resolveDatabaseAdapter(io, parsed.args, parsed);
    if (!parsed.dryRun) {
      await assertWorkspaceMutationPreflight(
        io,
        workspace,
        'Database addition',
      );
    }
    const generatorArgs = [
      `--name=${name}`,
      ...(!explicitOption(parsed.args, '--adapter')
        ? [`--adapter=${adapter}`]
        : []),
      ...parsed.args,
    ];
    const [command, commandArgs] = nxInvocation(
      workspace.packageManager,
      generatorArgs,
      'database',
    );
    const generated = await io.runCommand(command, commandArgs, {
      cwd: workspace.root,
    });
    if (generated.exitCode !== 0 && !parsed.dryRun) {
      io.stderr(
        `Database generation failed after delegation. Inspect git diff for partial files, resolve the reported error, then retry: megamono add database ${name} --adapter=${adapter}`,
      );
    }
    return { exitCode: generated.exitCode };
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
  const styling = await resolveWebStyling(io, type, parsed);
  if (!parsed.dryRun) {
    await assertWorkspaceMutationPreflight(
      io,
      workspace,
      'Application addition',
    );
  }
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
      `Add the ${type} application${styling ? ` using ${styling}` : ''}${missing.length ? ` and install ${missing.join(', ')}` : ''}?`,
    );
    if (!confirmed) return { exitCode: 0 };
  }

  const installed = parsed.dryRun
    ? []
    : await installAppPlugins(io, workspace, required, parsed.localPackages);
  const generatorArgs = [
    `--type=${type}`,
    ...(styling && !explicitOption(parsed.args, '--styling')
      ? [`--styling=${styling}`]
      : []),
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
  if (generated.exitCode !== 0 && !parsed.dryRun) {
    io.stderr(
      `Application generation failed after delegation.${
        installed.length > 0
          ? ` Dependencies already installed: ${installed.join(', ')}.`
          : ''
      } Inspect git diff for partial files, resolve the reported error, then retry: megamono add app ${type}`,
    );
  }
  return { exitCode: generated.exitCode };
}

function renderPlaystackSurveyPlan(
  manager: PackageManager,
  options: InitOptions,
  surfaces: Readonly<Partial<Record<PlaystackSurfaceKind, string>>>,
): string {
  const products = options.playstackPackages.join(' ');
  const adapter = packageManagerAdapter(manager);
  const source =
    options.localPackages === 'yalc'
      ? `yalc add @playstack/cli --dev --no-pure${
          products ? `; yalc add ${products} --no-pure` : ''
        }; ${manager} install`
      : `${manager} ${adapter.addArgs(['@playstack/cli'], { development: true }).join(' ')}${
          products
            ? `; ${manager} ${adapter.addArgs(options.playstackPackages).join(' ')}`
            : ''
        }`;
  const capabilities = options.playstackCapabilities
    .map(
      (capability) =>
        `playstack add ${capability} --yes${
          surfaces.web ? ` --web=${surfaces.web}` : ''
        }${surfaces.api ? ` --api=${surfaces.api}` : ''}${
          options.localPackages === 'yalc' ? ' --local-packages=yalc' : ''
        }`,
    )
    .join('; ');
  return `Playstack survey deferred: @playstack/cli is not installed. A real run would use ${source}${
    capabilities ? `; ${capabilities}` : ''
  }.`;
}

function renderPlaystackDryRunPlan(
  manager: PackageManager,
  options: InitOptions,
  surfaces: Readonly<Partial<Record<PlaystackSurfaceKind, string>>>,
): string {
  return `Playstack dry run: no packages will be installed and no Playstack files will be written. ${renderPlaystackSurveyPlan(
    manager,
    options,
    surfaces,
  ).replace(
    'Playstack survey deferred: @playstack/cli is not installed. ',
    '',
  )}`;
}

async function runInit(
  args: readonly string[],
  io: MegamonoCliIo,
): Promise<MegamonoCliResult> {
  const parsedOptions = parseInitOptions(args);
  const root = await findWorkspaceRoot(io.cwd);
  if (parsedOptions.survey && !parsedOptions.playstack) {
    if (!localPackageAvailable(root, 'nx')) {
      throw new CliError('The workspace-local nx package is not installed.', 3);
    }
    if (!localPackageAvailable(root, '@megamono/plugin'))
      return runEphemeralPluginSurvey(io, root, parsedOptions);
    const [command, commandArgs] = localNxCommandInvocation(root, [
      'generate',
      '@megamono/plugin:workspace-init',
      ...parsedOptions.generatorArgs,
    ]);
    const surveyed = await io.runCommand(command, commandArgs, { cwd: root });
    return { exitCode: surveyed.exitCode };
  }
  const workspace: Workspace = {
    root,
    packageManager: await detectPackageManager(root),
  };
  await assertActiveToolchainPreflight(io, workspace);
  if (!localPackageAvailable(root, 'nx')) {
    throw new CliError('The workspace-local nx package is not installed.', 3);
  }

  const pluginAvailable = localPackageAvailable(root, '@megamono/plugin');
  const options = await resolvePlaystackPackageSelection(io, parsedOptions);
  let directYalcClosure: YalcClosurePlan | undefined;
  if (options.localPackages === 'yalc') {
    const dependencyState = await workspaceDependencyState(root);
    const directRoots = options.playstackPackages.filter(
      (packageName) =>
        !localPackageAvailable(root, packageName) &&
        !dependencyState.yalc.has(packageName),
    );
    const yalcPackages = [
      ...(!pluginAvailable ? ['@megamono/plugin'] : []),
      ...(options.playstack
        ? [
            ...(!localPackageAvailable(root, '@playstack/cli')
              ? ['@playstack/cli']
              : []),
            ...directRoots,
          ]
        : []),
    ];
    const store = await preflightYalc(
      io,
      workspace,
      [...new Set(yalcPackages)].sort(),
    );
    if (directRoots.length > 0) {
      if (!store) {
        throw new CliError(
          'Unable to resolve the yalc store for direct Playstack packages.',
          3,
        );
      }
      directYalcClosure = await resolveYalcClosure(store, directRoots);
    }
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
  if (options.playstack) {
    await assertPlaystackCompatibility(root, options.playstackPackages);
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
  const surfaces = await resolvePlaystackSurfaces(io, workspace, options);
  if (options.dryRun) {
    io.stdout(
      renderPlaystackDryRunPlan(workspace.packageManager, options, surfaces),
    );
    if (!playstackAvailable) return { exitCode: 0 };
    await addPlaystackCapabilities(io, workspace, options, surfaces, true);
    const [command, commandArgs] = playstackInvocation(
      workspace.packageManager,
      ['init', '--survey'],
    );
    const previewed = await io.runCommand(command, commandArgs, {
      cwd: workspace.root,
    });
    return { exitCode: previewed.exitCode };
  }
  if (options.survey) {
    if (!playstackAvailable) {
      io.stdout(
        renderPlaystackSurveyPlan(workspace.packageManager, options, surfaces),
      );
      return { exitCode: 0 };
    }
  } else {
    await installPlaystackPackages(io, workspace, options, directYalcClosure);
    await addPlaystackCapabilities(io, workspace, options, surfaces);
  }

  const [playstackCommand, playstackArgs] = playstackInvocation(
    workspace.packageManager,
    ['init', ...(options.survey ? ['--survey'] : [])],
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

async function runAdopt(
  args: readonly string[],
  io: MegamonoCliIo,
): Promise<MegamonoCliResult> {
  const write = args.includes('--write');
  const generatorArgs = args.filter((argument) => argument !== '--write');
  if (
    !write &&
    !generatorArgs.some(
      (argument) =>
        argument === '--survey' ||
        argument.startsWith('--survey=') ||
        argument === '--dry-run' ||
        argument.startsWith('--dry-run='),
    )
  )
    return runInit(['--survey', ...generatorArgs], io);
  return runInit(generatorArgs, io);
}

async function runWorkspaceTarget(
  io: MegamonoCliIo,
  target: string,
  args: readonly string[],
): Promise<MegamonoCliResult> {
  const root = await findWorkspaceRoot(io.cwd);
  const packageManager = await detectPackageManager(root);
  await assertActiveToolchainPreflight(io, { root, packageManager });
  if (!localPackageAvailable(root, 'nx'))
    throw new CliError('The workspace-local nx package is not installed.', 3);
  if (!localPackageAvailable(root, '@megamono/plugin'))
    throw new CliError(
      `@megamono/plugin is not installed locally. Run: ${pluginInstallInstruction(packageManager, 'registry')}.`,
      3,
    );
  const [command, commandArgs] = nxCommandInvocation(packageManager, [
    'run',
    target,
    ...args,
  ]);
  const result = await io.runCommand(command, commandArgs, { cwd: root });
  return { exitCode: result.exitCode };
}

async function runHealth(
  args: readonly string[],
  io: MegamonoCliIo,
): Promise<MegamonoCliResult> {
  if (args.some((argument) => !argument.startsWith('-')))
    throw new CliError(HEALTH_HELP, 2);
  return runWorkspaceTarget(io, 'megamono:check', args);
}

async function runVerify(
  args: readonly string[],
  io: MegamonoCliIo,
): Promise<MegamonoCliResult> {
  const kind = args[0];
  if (kind === 'runtime') {
    const project = args[1];
    if (!project || project.startsWith('-')) throw new CliError(VERIFY_HELP, 2);
    return runWorkspaceTarget(io, 'megamono:verify-runtime', [
      `--project=${project}`,
      ...args.slice(2),
    ]);
  }
  if (kind === 'dependencies') {
    if (args[1] && !args[1].startsWith('-')) throw new CliError(VERIFY_HELP, 2);
    return runWorkspaceTarget(
      io,
      'megamono:verify-dependencies',
      args.slice(1),
    );
  }
  if (kind === 'container') {
    if (args[1] && !args[1].startsWith('-')) throw new CliError(VERIFY_HELP, 2);
    return runWorkspaceTarget(io, 'megamono:verify-container', args.slice(1));
  }
  throw new CliError(VERIFY_HELP, 2);
}

interface HostedCommandOptions {
  readonly serviceUrl: string;
  readonly account?: string;
  readonly positional: readonly string[];
}

function parseHostedOptions(
  args: readonly string[],
  io: MegamonoCliIo,
): HostedCommandOptions {
  let serviceUrl = io.hostedServiceUrl ?? 'https://app.megamono.com';
  let account: string | undefined;
  const positional: string[] = [];
  for (const argument of args) {
    if (argument.startsWith('--service-url=')) {
      serviceUrl = argument.slice('--service-url='.length);
    } else if (argument.startsWith('--account=')) {
      account = argument.slice('--account='.length);
    } else if (argument.startsWith('-')) {
      throw new CliError(`Unknown hosted-service option ${argument}.`, 2);
    } else {
      positional.push(argument);
    }
  }
  if (!serviceUrl.trim()) {
    throw new CliError('--service-url requires a value.', 2);
  }
  if (account !== undefined && !account.trim()) {
    throw new CliError('--account requires a value.', 2);
  }
  return { serviceUrl, ...(account ? { account } : {}), positional };
}

function hostedAuth(io: MegamonoCliIo): HostedAuthOperations {
  if (!io.hostedAuth) {
    throw new CliError(
      'Hosted authentication is unavailable in this CLI build. Install @playstack/client-auth alongside @megamono/cli and retry.',
      3,
    );
  }
  return io.hostedAuth;
}

function matchingAccount(
  accounts: readonly HostedAccount[],
  selector: string,
): HostedAccount {
  const normalized = selector.trim().toLowerCase();
  const matches = accounts.filter(
    (account) =>
      account.id === selector ||
      account.slug.toLowerCase() === normalized ||
      account.name.toLowerCase() === normalized,
  );
  if (matches.length !== 1) {
    throw new CliError(
      matches.length === 0
        ? `No account matches ${selector}.`
        : `Account selector ${selector} is ambiguous; use an account ID.`,
      4,
    );
  }
  return matches[0] as HostedAccount;
}

async function selectHostedAccount(
  io: MegamonoCliIo,
  profile: HostedProfile,
  selector?: string,
): Promise<HostedAccount | undefined> {
  if (selector) return matchingAccount(profile.accounts, selector);
  if (profile.accounts.length === 1) return profile.accounts[0];
  if (profile.accounts.length > 1 && io.selectHostedAccount) {
    return matchingAccount(
      profile.accounts,
      await io.selectHostedAccount(profile.accounts),
    );
  }
  return undefined;
}

function printHostedProfile(
  io: MegamonoCliIo,
  serviceUrl: string,
  profile: HostedProfile,
): void {
  const active = profile.accounts.find(
    (account) => account.id === profile.account?.id,
  );
  io.stdout(`Signed in to ${serviceUrl} as ${profile.user.email}.`);
  io.stdout(
    active
      ? `Active account: ${active.name} (${active.slug}, ${active.role}).`
      : 'No active account. Run megamono account use to select one.',
  );
}

async function runAuth(
  args: readonly string[],
  io: MegamonoCliIo,
): Promise<MegamonoCliResult> {
  const action = args[0];
  if (!action || action === '--help' || action === '-h') {
    io.stdout(AUTH_HELP);
    return { exitCode: 0 };
  }
  const options = parseHostedOptions(args.slice(1), io);
  if (options.positional.length > 0) {
    throw new CliError(AUTH_HELP, 2);
  }
  const auth = hostedAuth(io);
  if (action === 'login') {
    let profile = await auth.login(options.serviceUrl);
    const account = await selectHostedAccount(io, profile, options.account);
    if (account && account.id !== profile.account?.id) {
      profile = await auth.switchAccount(options.serviceUrl, account.id);
    }
    printHostedProfile(io, options.serviceUrl, profile);
    return { exitCode: 0 };
  }
  if (options.account) throw new CliError(AUTH_HELP, 2);
  if (action === 'status') {
    const profile = await auth.profile(options.serviceUrl);
    if (!profile) {
      io.stdout(`Not signed in to ${options.serviceUrl}.`);
    } else {
      printHostedProfile(io, options.serviceUrl, profile);
    }
    return { exitCode: 0 };
  }
  if (action === 'logout') {
    await auth.logout(options.serviceUrl);
    io.stdout(`Signed out of ${options.serviceUrl}.`);
    return { exitCode: 0 };
  }
  throw new CliError(`Unknown auth command ${action}.\n\n${AUTH_HELP}`, 2);
}

async function runAccount(
  args: readonly string[],
  io: MegamonoCliIo,
): Promise<MegamonoCliResult> {
  const action = args[0];
  if (!action || action === '--help' || action === '-h') {
    io.stdout(ACCOUNT_HELP);
    return { exitCode: 0 };
  }
  const options = parseHostedOptions(args.slice(1), io);
  if (options.account) throw new CliError(ACCOUNT_HELP, 2);
  const auth = hostedAuth(io);
  const profile = await auth.profile(options.serviceUrl);
  if (!profile) {
    throw new CliError(
      `Not signed in to ${options.serviceUrl}. Run megamono auth login first.`,
      3,
    );
  }
  if (action === 'list') {
    if (options.positional.length > 0) throw new CliError(ACCOUNT_HELP, 2);
    for (const account of profile.accounts) {
      const marker = account.id === profile.account?.id ? '*' : ' ';
      io.stdout(
        `${marker} ${account.name} (${account.slug}) — ${account.role}`,
      );
    }
    return { exitCode: 0 };
  }
  if (action === 'use') {
    if (options.positional.length > 1) throw new CliError(ACCOUNT_HELP, 2);
    const account = await selectHostedAccount(
      io,
      profile,
      options.positional[0],
    );
    if (!account) {
      throw new CliError(
        'Multiple accounts are available. Pass an ID or slug, or run interactively.',
        4,
      );
    }
    const switched = await auth.switchAccount(options.serviceUrl, account.id);
    printHostedProfile(io, options.serviceUrl, switched);
    return { exitCode: 0 };
  }
  throw new CliError(
    `Unknown account command ${action}.\n\n${ACCOUNT_HELP}`,
    2,
  );
}

export async function runMegamonoCli(
  args: readonly string[],
  io: MegamonoCliIo,
): Promise<MegamonoCliResult> {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      io.stdout(HELP);
      return { exitCode: 0 };
    }
    if (args[0] === 'help') {
      io.stdout(helpForTopic(args[1]));
      return { exitCode: 0 };
    }
    if (args[0] === '--version' || args[0] === '-v') {
      io.stdout(
        args.includes('--json')
          ? JSON.stringify(
              io.build ?? {
                schemaVersion: 1,
                package: '@megamono/cli',
                version: io.version,
                revision: 'development',
                dirty: true,
                buildId: 'development',
              },
              null,
              2,
            )
          : io.version,
      );
      return { exitCode: 0 };
    }
    if (args[0] === 'init') {
      if (args[1] === '--help' || args[1] === '-h') {
        io.stdout(INIT_HELP);
        return { exitCode: 0 };
      }
      return await runInit(args.slice(1), io);
    }
    if (args[0] === 'adopt') {
      if (args[1] === '--help' || args[1] === '-h') {
        io.stdout(ADOPT_HELP);
        return { exitCode: 0 };
      }
      return await runAdopt(args.slice(1), io);
    }
    if (args[0] === 'add') {
      if (args[1] === '--help' || args[1] === '-h') {
        io.stdout(ADD_HELP);
        return { exitCode: 0 };
      }
      if (
        args[1] === 'database' &&
        (args[2] === '--help' || args[2] === '-h')
      ) {
        io.stdout(DATABASE_HELP);
        return { exitCode: 0 };
      }
      return await runAdd(args.slice(1), io);
    }
    if (args[0] === 'auth') {
      return await runAuth(args.slice(1), io);
    }
    if (args[0] === 'account') {
      return await runAccount(args.slice(1), io);
    }
    if (args[0] === 'health') {
      if (args[1] === '--help' || args[1] === '-h') {
        io.stdout(HEALTH_HELP);
        return { exitCode: 0 };
      }
      return await runHealth(args.slice(1), io);
    }
    if (args[0] === 'verify') {
      if (args[1] === '--help' || args[1] === '-h') {
        io.stdout(VERIFY_HELP);
        return { exitCode: 0 };
      }
      return await runVerify(args.slice(1), io);
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
