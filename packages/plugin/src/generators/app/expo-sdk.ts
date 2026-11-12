import type { Tree } from '@nx/devkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { major, minVersion, satisfies, valid, validRange } from 'semver';

export interface ExpoSdkRegistry {
  readonly schemaVersion: 1;
  readonly defaultVersion: string;
  readonly snapshots: Readonly<
    Record<
      string,
      {
        readonly version: string;
        readonly source: {
          readonly metadata: string;
          readonly tarball: string;
          readonly integrity: string;
          readonly tarballSha256: string;
          readonly manifestSha256: string;
          readonly bundledNativeModulesSha256: string;
        };
        readonly requirements: Readonly<Record<string, string>>;
        readonly requirementsSha256: string;
        readonly reactNativePeerReact: {
          readonly range: string;
          readonly metadata: string;
          readonly metadataSha256: string;
        };
      }
    >
  >;
}

export interface ExpoSdkSelection {
  readonly version: string;
  readonly declaration: string;
  readonly requirements: Readonly<Record<string, string>>;
  readonly source: 'installed' | 'verified-snapshot';
}

interface ExpoManifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

function installedExpo(
  tree: Tree,
  root: string,
): { manifest: ExpoManifest; modules: Record<string, string> } | undefined {
  let manifest: ExpoManifest;
  let moduleSource: string;
  const manifestFile = join(root, 'node_modules/expo/package.json');
  const modulesFile = join(root, 'node_modules/expo/bundledNativeModules.json');
  if (tree.exists(manifestFile)) {
    manifest = JSON.parse(tree.read(manifestFile, 'utf8') ?? '');
    moduleSource = tree.read(modulesFile, 'utf8') ?? '';
  } else {
    if (tree.root === '/virtual') return undefined;
    let path: string;
    try {
      path = createRequire(join(tree.root, root, 'package.json')).resolve(
        'expo/package.json',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND')
        return undefined;
      throw error;
    }
    manifest = JSON.parse(readFileSync(path, 'utf8'));
    moduleSource = readFileSync(
      join(dirname(path), 'bundledNativeModules.json'),
      'utf8',
    );
  }
  if (
    manifest.name !== 'expo' ||
    !manifest.version ||
    !valid(manifest.version) ||
    !moduleSource
  )
    throw new Error(
      'Installed Expo SDK metadata is incomplete. Reinstall the selected SDK before adding a mobile app.',
    );
  return { manifest, modules: JSON.parse(moduleSource) };
}

function validateRequirements(
  requirements: Readonly<Record<string, string>>,
): void {
  for (const name of [
    'react',
    'react-dom',
    'react-native',
    'react-native-svg',
  ]) {
    if (!valid(requirements[name]))
      throw new Error(
        `Expo SDK metadata must provide an exact ${name} version. Install the selected SDK or review its public metadata snapshot before generation.`,
      );
  }
  if (requirements.react !== requirements['react-dom'])
    throw new Error(
      'Expo SDK metadata selects incompatible React and React DOM versions.',
    );
  for (const name of ['@types/react', 'babel-preset-expo', '@expo/cli']) {
    if (!validRange(requirements[name]))
      throw new Error(
        `Expo SDK metadata is missing a supported ${name} requirement.`,
      );
  }
}

/** Read public SDK metadata only; never install packages or execute app code. */
export function selectExpoSdk(
  tree: Tree,
  registry: ExpoSdkRegistry,
  declaration: string | undefined,
  names: readonly string[],
  ownerRoots: readonly string[] = ['.'],
): ExpoSdkSelection {
  const requested = declaration ?? registry.defaultVersion;
  const requestedMajor = validRange(requested)
    ? minVersion(requested)?.major
    : undefined;
  const snapshot =
    requestedMajor === undefined
      ? undefined
      : registry.snapshots[requestedMajor];
  if (registry.schemaVersion !== 1 || !snapshot)
    throw new Error(
      `No verified Expo SDK metadata satisfies ${requested}. Install a supported SDK with published metadata or review the SDK53–57 snapshots before generation; Megamono will not upgrade the caller's SDK.`,
    );
  const installed = ownerRoots
    .map((root) => installedExpo(tree, root))
    .find((value) => value !== undefined);
  if (
    installed &&
    major(installed.manifest.version as string) !== requestedMajor
  )
    throw new Error(
      `Installed Expo ${installed.manifest.version} conflicts with selected SDK ${requestedMajor}. Install the selected SDK before generating an app; Megamono will not silently switch SDK lanes.`,
    );
  if (installed && satisfies(installed.manifest.version as string, requested)) {
    const requirements = Object.fromEntries(
      names.flatMap((name) => {
        const version =
          installed.modules[name] ??
          installed.manifest.dependencies?.[name] ??
          installed.manifest.devDependencies?.[name];
        return version ? [[name, version]] : [];
      }),
    );
    validateRequirements(requirements);
    return {
      version: installed.manifest.version as string,
      declaration: requested,
      requirements,
      source: 'installed',
    };
  }
  if (!satisfies(snapshot.version, requested))
    throw new Error(
      `Expo ${requested} has no matching installed metadata or verified snapshot. Install that exact SDK first or explicitly select the reviewed ${snapshot.version} release; no SDK upgrade was applied.`,
    );
  const ordered = Object.fromEntries(
    Object.entries(snapshot.requirements).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  const hash = createHash('sha256')
    .update(JSON.stringify(ordered))
    .digest('hex');
  if (hash !== snapshot.requirementsSha256)
    throw new Error(
      'Verified Expo SDK requirements changed without matching provenance. Review the public SDK snapshot before generation.',
    );
  validateRequirements(snapshot.requirements);
  if (
    !satisfies(snapshot.requirements.react, snapshot.reactNativePeerReact.range)
  )
    throw new Error(
      'Verified Expo SDK React does not satisfy its published React Native peer requirement.',
    );
  return {
    version: snapshot.version,
    declaration: requested,
    requirements: snapshot.requirements,
    source: 'verified-snapshot',
  };
}
