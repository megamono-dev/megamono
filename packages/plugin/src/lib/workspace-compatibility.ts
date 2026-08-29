import type { Tree } from '@nx/devkit';

export interface VersionNumber {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface NxWorkspaceCapabilities {
  readonly version: string;
  readonly major: number;
  readonly targetParallelism: boolean;
  readonly continuousTargets: boolean;
}

export function parseVersionNumber(
  version: string | undefined,
): VersionNumber | undefined {
  const match = version?.match(/(?:^|[^0-9])(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

export function workspaceDependencyVersion(
  tree: Tree,
  name: string,
): string | undefined {
  const lockSource = tree.read('package-lock.json', 'utf8');
  if (lockSource) {
    try {
      const lock = JSON.parse(lockSource) as {
        packages?: Record<string, { version?: unknown }>;
      };
      const version = lock.packages?.[`node_modules/${name}`]?.version;
      if (typeof version === 'string') return version;
    } catch {
      // Preflight reports malformed lockfiles with its structured diagnostic.
    }
  }
  const manifestSource = tree.read('package.json', 'utf8');
  if (!manifestSource) return undefined;
  try {
    const manifest = JSON.parse(manifestSource) as Record<string, unknown>;
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
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
    return undefined;
  }
  return undefined;
}

export function nxWorkspaceCapabilities(tree: Tree): NxWorkspaceCapabilities {
  const version = workspaceDependencyVersion(tree, 'nx') ?? 'unknown';
  const parsed = parseVersionNumber(version);
  const major = parsed?.major ?? Number.POSITIVE_INFINITY;
  return {
    version,
    major,
    targetParallelism:
      major > 19 || (major === 19 && (parsed?.minor ?? 0) >= 5),
    continuousTargets: major >= 21,
  };
}
