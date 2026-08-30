import type { Tree } from '@nx/devkit';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceInitError } from './workspace-init-plan';
import {
  parseVersionNumber,
  workspaceDependencyVersion,
  type VersionNumber,
} from './workspace-compatibility';

const executeFile = promisify(execFile);

export interface WorkspaceInitHostState {
  readonly platform: NodeJS.Platform;
  readonly node: string;
  readonly npm?: string;
  readonly pnpm?: string;
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
  if (inside !== 'true') {
    return {
      platform: process.platform,
      node: process.version,
      ...(npm ? { npm } : {}),
      ...(pnpm ? { pnpm } : {}),
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
    readonly packageManager?: 'pnpm' | 'npm';
  } = {},
): void {
  if (state.platform !== 'darwin' && state.platform !== 'linux') {
    throw new WorkspaceInitError(
      'preflight',
      `Operating system ${state.platform} is unsupported; use macOS or Linux.`,
    );
  }
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
  for (const lockfile of ['yarn.lock', 'bun.lock', 'bun.lockb']) {
    if (tree.exists(lockfile)) {
      throw new WorkspaceInitError(
        'preflight',
        `Unsupported package-manager lockfile ${lockfile}; Megamono supports pnpm and npm.`,
      );
    }
  }
  const lockfileManagers = [
    ...(tree.exists('pnpm-lock.yaml') ? (['pnpm'] as const) : []),
    ...(tree.exists('package-lock.json') ? (['npm'] as const) : []),
  ];
  if (lockfileManagers.length !== 1) {
    throw new WorkspaceInitError(
      'preflight',
      lockfileManagers.length === 0
        ? 'A pnpm-lock.yaml or package-lock.json is required.'
        : 'Conflicting pnpm-lock.yaml and package-lock.json files are not supported.',
    );
  }
  const packageManager = lockfileManagers[0];
  const declaredName = declaredPackageManager?.split('@')[0];
  if (declaredName && declaredName !== 'pnpm' && declaredName !== 'npm') {
    throw new WorkspaceInitError(
      'preflight',
      `package.json declares unsupported package manager ${declaredPackageManager}.`,
    );
  }
  if (declaredName && declaredName !== packageManager) {
    throw new WorkspaceInitError(
      'preflight',
      `package.json declares ${declaredPackageManager}, but the workspace has the ${packageManager} lockfile.`,
    );
  }
  if (options.packageManager && options.packageManager !== packageManager) {
    throw new WorkspaceInitError(
      'preflight',
      `Requested ${options.packageManager}, but the workspace has the ${packageManager} lockfile.`,
    );
  }
  requireVersionRange(
    'Node.js',
    state.node,
    { major: 18, minor: 18, patch: 0 },
    { major: 25, minor: 0, patch: 0 },
  );
  requireVersionRange(
    packageManager,
    packageManager === 'pnpm' ? state.pnpm : state.npm,
    packageManager === 'pnpm'
      ? { major: 8, minor: 0, patch: 0 }
      : { major: 9, minor: 0, patch: 0 },
    { major: 12, minor: 0, patch: 0 },
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
