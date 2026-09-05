import type { Tree } from '@nx/devkit';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import semver = require('semver');
import {
  WorkspaceInitError,
  type WorkspaceInitHostReadiness,
} from './workspace-init-plan';
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
      // Corepack shims can attempt network access even for --version. A
      // read-only survey must remain bounded when an optional tool is absent.
      timeout: 5_000,
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

function versionRangeIssue(
  label: string,
  version: string | undefined,
  minimum: VersionNumber,
  maximumExclusive: VersionNumber,
): string | undefined {
  const parsed = parseVersionNumber(version);
  return !parsed ||
    compareVersion(parsed, minimum) < 0 ||
    compareVersion(parsed, maximumExclusive) >= 0
    ? `${label} ${version ?? 'unknown'} is unsupported for adoption; expected >=${minimum.major}.${minimum.minor}.${minimum.patch} <${maximumExclusive.major}.${maximumExclusive.minor}.${maximumExclusive.patch}.`
    : undefined;
}

function nodeActivationGuidance(tree: Tree, declaredNode: string): string {
  if (tree.exists('.nvmrc')) return 'Run `nvm use` from the workspace root.';
  if (tree.exists('.node-version'))
    return 'Activate the Node version recorded in `.node-version`.';
  const minimum = semver.minVersion(declaredNode);
  const release = minimum
    ? `${minimum.major}${minimum.minor === 0 && minimum.patch === 0 ? '' : `.${minimum.minor}.${minimum.patch}`}`
    : declaredNode;
  return `Activate a Node version satisfying \`${declaredNode}\` (for example, run \`nvm install ${release} && nvm use ${release}\`).`;
}

export function assessWorkspaceInitHostReadiness(
  tree: Tree,
  state: WorkspaceInitHostState,
  options: { readonly packageManager?: PackageManager } = {},
): WorkspaceInitHostReadiness {
  const manifest = (() => {
    try {
      return JSON.parse(tree.read('package.json', 'utf8') ?? '{}') as {
        packageManager?: unknown;
        engines?: Record<string, unknown>;
      };
    } catch {
      return {};
    }
  })();
  const declaration =
    typeof manifest.packageManager === 'string'
      ? manifest.packageManager
      : undefined;
  const declaredName = declaration?.split('@')[0];
  const detected = lockfileManagers((path) => tree.exists(path));
  const selectedPackageManager =
    options.packageManager ??
    detected[0] ??
    (declaredName && isPackageManager(declaredName) ? declaredName : null);
  const issues: string[] = [];
  const activation: string[] = [];
  if (detected.length > 1) {
    issues.push(
      `Conflicting root package-manager lockfiles are present: ${detected.join(', ')}.`,
    );
  }
  if (declaredName && !isPackageManager(declaredName)) {
    issues.push(
      `The repository declares unsupported package manager ${declaration}.`,
    );
  }
  if (
    declaredName &&
    isPackageManager(declaredName) &&
    detected.length === 1 &&
    detected[0] !== declaredName
  ) {
    issues.push(
      `The repository declares ${declaration}, but its root lockfile belongs to ${detected[0]}.`,
    );
  }
  const nodeIssue = versionRangeIssue(
    'Node.js',
    state.node,
    { major: 18, minor: 18, patch: 0 },
    { major: 25, minor: 0, patch: 0 },
  );
  if (nodeIssue) {
    issues.push(nodeIssue);
    if (tree.exists('.nvmrc'))
      activation.push('Run `nvm use` from the workspace root.');
    else if (tree.exists('.node-version'))
      activation.push('Activate the Node version recorded in `.node-version`.');
    else
      activation.push(
        'Activate Node >=18.18 <25; after switching, optionally rerun init with `--toolchainPin` and an exact `--toolchainNode`.',
      );
  }
  const declaredNode = manifest.engines?.node;
  const coercedNode = semver.coerce(state.node);
  if (
    typeof declaredNode === 'string' &&
    semver.validRange(declaredNode) &&
    coercedNode &&
    !semver.satisfies(coercedNode, declaredNode)
  ) {
    issues.push(
      `Active Node ${state.node} does not satisfy the repository declaration ${declaredNode}.`,
    );
    const guidance = nodeActivationGuidance(tree, declaredNode);
    if (!activation.includes(guidance)) activation.push(guidance);
  }
  if (!selectedPackageManager) {
    issues.push(
      'The root package manager is unresolved; add one supported root lockfile or a packageManager declaration.',
    );
  } else {
    const adapter = packageManagerAdapter(selectedPackageManager);
    const activeVersion = state[selectedPackageManager];
    const managerIssue = versionRangeIssue(
      selectedPackageManager,
      activeVersion,
      {
        major: adapter.minimumVersion[0],
        minor: adapter.minimumVersion[1],
        patch: 0,
      },
      { major: adapter.maximumMajorExclusive, minor: 0, patch: 0 },
    );
    if (managerIssue) issues.push(managerIssue);
    const declaredVersion =
      declaredName === selectedPackageManager
        ? declaration?.slice(declaredName.length + 1)
        : undefined;
    const managerDeclarationIssue =
      activeVersion &&
      declaredVersion &&
      semver.validRange(declaredVersion) &&
      !semver.satisfies(activeVersion, declaredVersion, {
        includePrerelease: true,
      });
    if (managerDeclarationIssue) {
      issues.push(
        `Active ${selectedPackageManager} ${activeVersion} does not satisfy the repository declaration ${declaration}.`,
      );
    }
    if (managerIssue || managerDeclarationIssue) {
      if (declaration && ['pnpm', 'yarn'].includes(selectedPackageManager)) {
        activation.push(
          `Run \`corepack enable\`, then \`corepack prepare ${declaration} --activate\`.`,
        );
      } else {
        activation.push(
          `Activate a ${selectedPackageManager} version compatible with the repository before rerunning init.`,
        );
      }
    }
  }
  return {
    platform: state.platform,
    active: {
      node: state.node,
      ...(state.npm ? { npm: state.npm } : {}),
      ...(state.pnpm ? { pnpm: state.pnpm } : {}),
      ...(state.yarn ? { yarn: state.yarn } : {}),
      ...(state.bun ? { bun: state.bun } : {}),
    },
    selectedPackageManager,
    ready: issues.length === 0,
    issues,
    activation,
  };
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
    const manifest = JSON.parse(manifestSource) as {
      packageManager?: unknown;
      engines?: Record<string, unknown>;
    };
    declaredPackageManager =
      typeof manifest.packageManager === 'string'
        ? manifest.packageManager
        : undefined;
    const declaredNode = manifest.engines?.node;
    const activeNode = semver.coerce(state.node);
    if (
      typeof declaredNode === 'string' &&
      semver.validRange(declaredNode) &&
      activeNode &&
      !semver.satisfies(activeNode, declaredNode)
    ) {
      throw new WorkspaceInitError(
        'preflight',
        `Active Node ${state.node} does not satisfy the repository declaration ${declaredNode}.`,
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
  const declaredVersion =
    declaredName === packageManager
      ? declaredPackageManager?.slice(declaredName.length + 1)
      : undefined;
  const activePackageManagerVersion = state[packageManager];
  if (
    declaredVersion &&
    activePackageManagerVersion &&
    semver.validRange(declaredVersion) &&
    !semver.satisfies(activePackageManagerVersion, declaredVersion, {
      includePrerelease: true,
    })
  ) {
    throw new WorkspaceInitError(
      'preflight',
      `Active ${packageManager} ${activePackageManagerVersion} does not satisfy the repository declaration ${declaredPackageManager}.`,
    );
  }
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
