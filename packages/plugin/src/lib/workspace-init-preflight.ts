import type { Tree } from '@nx/devkit';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceInitError } from './workspace-init-plan';
import {
  parseVersionNumber,
  workspaceDependencyVersion,
  type VersionNumber,
} from './workspace-compatibility';
import {
  isPackageManager,
  lockfileManagers,
  packageManagerAdapter,
  type PackageManager,
} from './package-manager';

const executeFile = promisify(execFile);

export interface WorkspaceInitHostState {
  readonly platform: NodeJS.Platform;
  readonly node: string;
  readonly npm?: string;
  readonly pnpm?: string;
  readonly yarn?: string;
  readonly bun?: string;
  readonly git: {
    readonly available: boolean;
    readonly clean: boolean;
    readonly branch?: string;
    readonly defaultBranch?: string;
  };
}

export function assertWorkspaceMutationGitPreflight(
  state: WorkspaceInitHostState,
  operation: string,
): void {
  if (!state.git.available) {
    throw new WorkspaceInitError(
      'preflight',
      `${operation} requires a Git worktree.${
        operation === 'Initialization'
          ? ' Use create-megamono for a new repository.'
          : ''
      }`,
    );
  }
  if (!state.git.clean) {
    throw new WorkspaceInitError(
      'preflight',
      `${operation} requires a clean working tree.`,
    );
  }
  if (!state.git.branch) {
    throw new WorkspaceInitError(
      'preflight',
      `${operation} requires a named branch, not detached HEAD.`,
    );
  }
  if (!state.git.defaultBranch) {
    throw new WorkspaceInitError(
      'preflight',
      'The origin default branch could not be resolved.',
    );
  }
  if (state.git.branch === state.git.defaultBranch) {
    throw new WorkspaceInitError(
      'preflight',
      `${operation} must not run on the default branch ${state.git.defaultBranch}.`,
    );
  }
}

async function commandOutput(
  workspaceRoot: string,
  command: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const result = await executeFile(command, [...args], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

export async function collectWorkspaceInitHostState(
  workspaceRoot: string,
): Promise<WorkspaceInitHostState> {
  const inside = await commandOutput(workspaceRoot, 'git', [
    'rev-parse',
    '--is-inside-work-tree',
  ]);
  const npm = await commandOutput(workspaceRoot, 'npm', ['--version']);
  const pnpm = await commandOutput(workspaceRoot, 'pnpm', ['--version']);
  const yarn = await commandOutput(workspaceRoot, 'yarn', ['--version']);
  const bun = await commandOutput(workspaceRoot, 'bun', ['--version']);
  if (inside !== 'true') {
    return {
      platform: process.platform,
      node: process.version,
      ...(npm ? { npm } : {}),
      ...(pnpm ? { pnpm } : {}),
      ...(yarn ? { yarn } : {}),
      ...(bun ? { bun } : {}),
      git: { available: false, clean: false },
    };
  }
  const status = await commandOutput(workspaceRoot, 'git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  const branch = await commandOutput(workspaceRoot, 'git', [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const remoteDefault = await commandOutput(workspaceRoot, 'git', [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  const defaultBranch = remoteDefault?.replace(/^origin\//, '');
  return {
    platform: process.platform,
    node: process.version,
    ...(npm ? { npm } : {}),
    ...(pnpm ? { pnpm } : {}),
    ...(yarn ? { yarn } : {}),
    ...(bun ? { bun } : {}),
    git: {
      available: true,
      clean: status === '',
      ...(branch ? { branch } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
    },
  };
}

function assertValidPackageLock(tree: Tree): void {
  const lockSource = tree.read('package-lock.json', 'utf8');
  if (!lockSource) return;
  try {
    JSON.parse(lockSource);
  } catch {
    throw new WorkspaceInitError(
      'preflight',
      'package-lock.json is not valid JSON.',
    );
  }
}

function compareVersion(left: VersionNumber, right: VersionNumber): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

function requireVersionRange(
  label: string,
  version: string | undefined,
  minimum: VersionNumber,
  maximumExclusive: VersionNumber,
): void {
  const parsed = parseVersionNumber(version);
  if (
    !parsed ||
    compareVersion(parsed, minimum) < 0 ||
    compareVersion(parsed, maximumExclusive) >= 0
  ) {
    throw new WorkspaceInitError(
      'preflight',
      `${label} ${version ?? 'unknown'} is unsupported for adoption; expected >=${minimum.major}.${minimum.minor}.${minimum.patch} <${maximumExclusive.major}.${maximumExclusive.minor}.${maximumExclusive.patch}.`,
    );
  }
}

export function assertWorkspaceInitPreflight(
  tree: Tree,
  state: WorkspaceInitHostState,
  options: {
    readonly bootstrap?: boolean;
    readonly packageManager?: PackageManager;
  } = {},
): void {
  const manifestSource = tree.read('package.json', 'utf8');
  if (!manifestSource) {
    throw new WorkspaceInitError('preflight', 'package.json is missing.');
  }
  let declaredPackageManager: string | undefined;
  try {
    const manifest = JSON.parse(manifestSource) as { packageManager?: unknown };
    declaredPackageManager =
      typeof manifest.packageManager === 'string'
        ? manifest.packageManager
        : undefined;
  } catch (error) {
    if (error instanceof WorkspaceInitError) throw error;
    throw new WorkspaceInitError(
      'preflight',
      'package.json is not valid JSON.',
    );
  }
  if (!tree.exists('nx.json')) {
    throw new WorkspaceInitError(
      'preflight',
      'nx.json is missing; run nx init before workspace-init.',
    );
  }
  assertValidPackageLock(tree);
  const detectedManagers = lockfileManagers((path) => tree.exists(path));
  const declaredName = declaredPackageManager?.split('@')[0];
  if (declaredName && !isPackageManager(declaredName)) {
    throw new WorkspaceInitError(
      'preflight',
      `package.json declares unsupported package manager ${declaredPackageManager}. Survey remains available, but mutation requires an npm, pnpm, Yarn, or Bun workspace.`,
    );
  }
  if (detectedManagers.length > 1) {
    throw new WorkspaceInitError(
      'preflight',
      `Conflicting root package-manager lockfiles are not supported: ${detectedManagers.join(', ')}. Nested project lockfiles do not participate in root detection.`,
    );
  }
  const lockedManager = detectedManagers[0];
  const packageManager =
    lockedManager ??
    (declaredName && isPackageManager(declaredName) ? declaredName : undefined);
  if (!packageManager) {
    throw new WorkspaceInitError(
      'preflight',
      'Mutation requires a declared packageManager or one root lockfile: package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lock, or bun.lockb. Survey remains available without either.',
    );
  }
  if (declaredName && lockedManager && declaredName !== lockedManager) {
    throw new WorkspaceInitError(
      'preflight',
      `package.json declares ${declaredPackageManager}, but the root lockfile belongs to ${lockedManager}.`,
    );
  }
  if (options.packageManager && options.packageManager !== packageManager) {
    throw new WorkspaceInitError(
      'preflight',
      `Requested ${options.packageManager}, but the workspace owns ${packageManager}. Package-manager migration is a separate explicit operation.`,
    );
  }
  requireVersionRange(
    'Node.js',
    state.node,
    { major: 18, minor: 18, patch: 0 },
    { major: 25, minor: 0, patch: 0 },
  );
  const adapter = packageManagerAdapter(packageManager);
  requireVersionRange(
    packageManager,
    state[packageManager],
    {
      major: adapter.minimumVersion[0],
      minor: adapter.minimumVersion[1],
      patch: 0,
    },
    { major: adapter.maximumMajorExclusive, minor: 0, patch: 0 },
  );
  requireVersionRange(
    'Nx',
    workspaceDependencyVersion(tree, 'nx'),
    { major: 17, minor: 0, patch: 0 },
    { major: 24, minor: 0, patch: 0 },
  );
  requireVersionRange(
    'TypeScript',
    workspaceDependencyVersion(tree, 'typescript'),
    { major: 5, minor: 2, patch: 0 },
    { major: 7, minor: 0, patch: 0 },
  );

  if (options.bootstrap) return;
  assertWorkspaceMutationGitPreflight(state, 'Initialization');
}
