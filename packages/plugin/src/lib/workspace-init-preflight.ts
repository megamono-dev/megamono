import type { Tree } from '@nx/devkit';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceInitError } from './workspace-init-plan';

const executeFile = promisify(execFile);

export interface WorkspaceInitHostState {
  readonly platform: NodeJS.Platform;
  readonly node: string;
  readonly npm?: string;
  readonly git: {
    readonly available: boolean;
    readonly clean: boolean;
    readonly branch?: string;
    readonly defaultBranch?: string;
  };
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
  if (inside !== 'true') {
    return {
      platform: process.platform,
      node: process.version,
      ...(npm ? { npm } : {}),
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
    git: {
      available: true,
      clean: status === '',
      ...(branch ? { branch } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
    },
  };
}

function majorMinor(version: string | undefined): readonly [number, number] {
  const match = version?.match(/(?:^|[^0-9])(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2])] : [-1, -1];
}

function dependencyVersion(tree: Tree, name: string): string | undefined {
  const lockSource = tree.read('package-lock.json', 'utf8');
  if (lockSource) {
    try {
      const lock = JSON.parse(lockSource) as {
        packages?: Record<string, { version?: unknown }>;
      };
      const version = lock.packages?.[`node_modules/${name}`]?.version;
      if (typeof version === 'string') return version;
    } catch {
      throw new WorkspaceInitError(
        'preflight',
        'package-lock.json is not valid JSON.',
      );
    }
  }
  const manifestSource = tree.read('package.json', 'utf8');
  if (!manifestSource) return undefined;
  try {
    const manifest = JSON.parse(manifestSource) as Record<string, unknown>;
    for (const key of ['dependencies', 'devDependencies']) {
      const dependencies = manifest[key];
      if (
        dependencies &&
        typeof dependencies === 'object' &&
        !Array.isArray(dependencies)
      ) {
        const version = (dependencies as Record<string, unknown>)[name];
        if (typeof version === 'string') return version;
      }
    }
  } catch {
    throw new WorkspaceInitError(
      'preflight',
      'package.json is not valid JSON.',
    );
  }
  return undefined;
}

function requireVersion(
  label: string,
  version: string | undefined,
  expectedMajor: number,
  minimumMinor = 0,
  maximumMinor?: number,
): void {
  const [major, minor] = majorMinor(version);
  if (
    major !== expectedMajor ||
    minor < minimumMinor ||
    (maximumMinor !== undefined && minor >= maximumMinor)
  ) {
    throw new WorkspaceInitError(
      'preflight',
      `${label} ${version ?? 'unknown'} is unsupported; expected ${expectedMajor}.${minimumMinor}${maximumMinor === undefined ? '.x' : ` through ${expectedMajor}.${maximumMinor - 1}.x`}.`,
    );
  }
}

export function assertWorkspaceInitPreflight(
  tree: Tree,
  state: WorkspaceInitHostState,
  options: { readonly bootstrap?: boolean } = {},
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
  try {
    const manifest = JSON.parse(manifestSource) as { packageManager?: unknown };
    if (
      typeof manifest.packageManager === 'string' &&
      !/^npm(?:@|$)/.test(manifest.packageManager)
    ) {
      throw new WorkspaceInitError(
        'preflight',
        `V1 requires npm; package.json declares ${manifest.packageManager}.`,
      );
    }
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
  for (const lockfile of [
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ]) {
    if (tree.exists(lockfile)) {
      throw new WorkspaceInitError(
        'preflight',
        `V1 requires npm; remove the unsupported ${lockfile} before initialization.`,
      );
    }
  }
  if (!tree.exists('package-lock.json')) {
    throw new WorkspaceInitError(
      'preflight',
      'V1 requires an npm package-lock.json.',
    );
  }
  requireVersion('Node.js', state.node, 24);
  requireVersion('npm', state.npm, 11);
  requireVersion('Nx', dependencyVersion(tree, 'nx'), 23, 1);
  requireVersion('TypeScript', dependencyVersion(tree, 'typescript'), 6, 0, 1);

  if (options.bootstrap) return;
  if (!state.git.available) {
    throw new WorkspaceInitError(
      'preflight',
      'Initialization requires a Git worktree. Use create-megamono for a new repository.',
    );
  }
  if (!state.git.clean) {
    throw new WorkspaceInitError(
      'preflight',
      'Initialization requires a clean working tree.',
    );
  }
  if (!state.git.branch) {
    throw new WorkspaceInitError(
      'preflight',
      'Initialization requires a named branch, not detached HEAD.',
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
      `Initialization must not run on the default branch ${state.git.defaultBranch}.`,
    );
  }
}
