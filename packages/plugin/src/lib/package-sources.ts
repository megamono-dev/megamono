import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { MegamonoConfig } from './config';
import type { Diagnostic } from './diagnostics';
import { packageManagerAdapter } from './package-manager';

const scopePattern = /^@[a-z0-9][a-z0-9._-]*$/;
const registriesSchema = z.record(
  z.string().regex(scopePattern),
  z.url().refine((value) => value.startsWith('https://'), {
    message: 'Registry URLs must use HTTPS.',
  }),
);
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const ignoredDirectories = new Set([
  '.git',
  '.nx',
  '.yalc',
  'dist',
  'node_modules',
]);
const versionedTarballPattern =
  /(?:^|[-_])v?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?\.tgz$/;

interface PackageAddress {
  readonly manifestPath: string;
  readonly location: string;
  readonly baseDirectory: string;
  readonly specifier: string;
}

export type PackageSourceProfileName =
  'development' | 'migration' | 'ci' | 'release';

/** A project omitted from this run's install and task set (for example `pnpm install --filter=!<project>`). */
export interface ExcludedPackageSourceProject {
  readonly name: string;
  readonly root: string;
}

function addressLocator(address: PackageAddress): string {
  return `${address.manifestPath}#${address.location}`;
}

function isLocalPackageAddress(specifier: string): boolean {
  const value = specifier.trim();
  return (
    /(?:^|[/:])\.yalc(?:\/|$)/.test(value) ||
    /^(?:file|link|portal):/.test(value)
  );
}

export function parsePackageRegistries(
  source: string | undefined,
): Readonly<Record<string, string>> {
  if (source === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error('packageRegistries must be a JSON object.', {
      cause: error,
    });
  }
  const parsed = registriesSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `packageRegistries is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')}`,
    );
  }
  return Object.fromEntries(
    Object.entries(parsed.data)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([scope, registry]) => [scope, registry.replace(/\/+$/, '')]),
  );
}

export function renderPackageRegistrySection(
  registries: Readonly<Record<string, string>>,
): string {
  const lines = Object.entries(registries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scope, registry]) => `${scope}:registry=${registry}`);
  return `\n${lines.join('\n')}\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function packageManifests(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name))
          await visit(join(directory, entry.name));
      } else if (entry.isFile() && entry.name === 'package.json') {
        output.push(join(directory, entry.name));
      }
    }
  };
  await visit(root);
  return output.sort();
}

function valueAt(
  value: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current))
      return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function collectStringAddresses(
  value: unknown,
  candidate: Omit<PackageAddress, 'location' | 'specifier'>,
  location: string,
  output: PackageAddress[],
): void {
  if (typeof value === 'string') {
    output.push({ ...candidate, location, specifier: value });
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [name, child] of Object.entries(value)) {
    collectStringAddresses(child, candidate, `${location}.${name}`, output);
  }
}

function manifestPackageAddresses(
  manifest: Record<string, unknown>,
  manifestPath: string,
  baseDirectory: string,
): PackageAddress[] {
  const output: PackageAddress[] = [];
  const candidate = { manifestPath, baseDirectory };
  for (const field of dependencyFields) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== 'object') continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier === 'string')
        output.push({
          ...candidate,
          location: `${field}.${name}`,
          specifier,
        });
    }
  }
  for (const path of [
    ['overrides'],
    ['resolutions'],
    ['pnpm', 'overrides'],
    ['pnpm', 'catalog'],
    ['pnpm', 'catalogs'],
  ] as const) {
    collectStringAddresses(
      valueAt(manifest, path),
      candidate,
      path.join('.'),
      output,
    );
  }
  return output;
}

function outsideRoot(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}

async function localPackageAddressProblem(
  root: string,
  address: PackageAddress,
): Promise<string | undefined> {
  const specifier = address.specifier.trim();
  if (/(?:^|[/:])\.yalc(?:\/|$)/.test(specifier))
    return 'Yalc addresses are development-only.';
  if (/^(?:link|portal):/.test(specifier))
    return 'Link and portal addresses are development-only.';
  if (!specifier.startsWith('file:')) return undefined;

  const localPath = specifier.slice('file:'.length);
  if (!localPath.toLowerCase().endsWith('.tgz'))
    return 'Local package directories are not immutable CI inputs.';
  if (!versionedTarballPattern.test(basename(localPath)))
    return 'Repository tarballs must include an exact semantic version in the filename.';

  const absolutePath = resolve(address.baseDirectory, localPath);
  if (outsideRoot(root, absolutePath))
    return 'Repository tarballs must resolve inside the workspace.';
  try {
    const information = await stat(absolutePath);
    if (!information.isFile()) return 'The configured tarball is not a file.';
    const resolvedRoot = await realpath(root);
    const resolvedTarball = await realpath(absolutePath);
    if (outsideRoot(resolvedRoot, resolvedTarball))
      return 'Repository tarballs must not resolve through a symlink outside the workspace.';
  } catch {
    return 'The configured repository tarball does not exist.';
  }
  return undefined;
}

async function pnpmWorkspaceAddresses(
  root: string,
): Promise<PackageAddress[] | Diagnostic> {
  const manifestPath = 'pnpm-workspace.yaml';
  const absolutePath = join(root, manifestPath);
  if (!(await exists(absolutePath))) return [];
  let workspace: unknown;
  try {
    workspace = parseYaml(await readFile(absolutePath, 'utf8'));
  } catch {
    return {
      severity: 'error',
      code: 'package-sources-config',
      path: manifestPath,
      message:
        'pnpm-workspace.yaml is malformed and package sources cannot be validated.',
    };
  }
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace))
    return [];
  const output: PackageAddress[] = [];
  const record = workspace as Record<string, unknown>;
  const candidate = {
    manifestPath,
    baseDirectory: root,
  };
  for (const field of ['overrides', 'catalog', 'catalogs'] as const) {
    collectStringAddresses(record[field], candidate, field, output);
  }
  return output;
}

function insideProject(path: string, root: string): boolean {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return (
    normalized === '.' ||
    normalized === '' ||
    path === `${normalized}/package.json` ||
    path.startsWith(`${normalized}/`)
  );
}

/** The package an override or catalog entry addresses (`a>b@^1` addresses `b`). */
function addressedPackage(location: string): string | undefined {
  const match =
    /^(?:overrides|resolutions|pnpm\.overrides|pnpm\.catalog|catalog|pnpm\.catalogs\.[^.]+|catalogs\.[^.]+)\.(.+)$/.exec(
      location,
    );
  if (!match) return undefined;
  const selector = match[1].split('>').at(-1)?.trim() ?? '';
  const name = /^(@[^/@]+\/[^@]+|[^@]+)/.exec(selector)?.[1];
  return name || undefined;
}

type LockRecord = Record<string, unknown>;

function recordAt(value: unknown, key: string): LockRecord | undefined {
  const child =
    value && typeof value === 'object' ? (value as LockRecord)[key] : undefined;
  return child && typeof child === 'object' && !Array.isArray(child)
    ? (child as LockRecord)
    : undefined;
}

/**
 * Package names installed for the included pnpm importers, from the committed
 * lockfile. Returns undefined when the lockfile cannot establish reachability,
 * so callers keep validating every address.
 */
async function pnpmReachablePackages(
  root: string,
  excludedRoots: readonly string[],
): Promise<ReadonlySet<string> | undefined> {
  const path = join(root, 'pnpm-lock.yaml');
  if (!(await exists(path))) return undefined;
  let lock: unknown;
  try {
    lock = parseYaml(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
  const importers = recordAt(lock, 'importers');
  if (!importers) return undefined;
  const snapshots = recordAt(lock, 'snapshots') ?? recordAt(lock, 'packages');
  const names = new Set<string>();
  const visitedImporters = new Set<string>();
  const visitedPackages = new Set<string>();
  const pending: Array<
    | { kind: 'importer'; id: string }
    | { kind: 'package'; name: string; version: string }
  > = Object.keys(importers)
    .filter(
      (id) =>
        !excludedRoots.some((excluded) =>
          insideProject(
            id === '.' ? 'package.json' : `${id}/package.json`,
            excluded,
          ),
        ),
    )
    .map((id) => ({ kind: 'importer' as const, id }));
  const dependencies = (entry: LockRecord | undefined) =>
    ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap(
      (field) =>
        Object.entries(recordAt(entry, field) ?? {}).flatMap(
          ([name, value]) => {
            const version =
              typeof value === 'string'
                ? value
                : recordAt({ value }, 'value')?.version;
            return typeof version === 'string' ? [{ name, version }] : [];
          },
        ),
    );
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    if (next.kind === 'importer') {
      if (visitedImporters.has(next.id)) continue;
      visitedImporters.add(next.id);
      for (const { name, version } of dependencies(
        recordAt(importers, next.id),
      )) {
        names.add(name);
        if (version.startsWith('link:')) {
          const target = relative(
            root,
            resolve(root, next.id, version.slice('link:'.length)),
          )
            .split(sep)
            .join('/');
          if (recordAt(importers, target || '.'))
            pending.push({ kind: 'importer', id: target || '.' });
        } else pending.push({ kind: 'package', name, version });
      }
      continue;
    }
    const keys = [
      `${next.name}@${next.version}`,
      `/${next.name}@${next.version}`,
      next.version,
      `/${next.version}`,
    ];
    const key = keys.find((candidate) => recordAt(snapshots, candidate));
    if (!key || visitedPackages.has(key)) continue;
    visitedPackages.add(key);
    for (const dependency of dependencies(recordAt(snapshots, key))) {
      names.add(dependency.name);
      pending.push({ kind: 'package', ...dependency });
    }
  }
  return names;
}

export async function validatePackageSources(
  root: string,
  config: MegamonoConfig,
  options: {
    readonly profile?: PackageSourceProfileName;
    /**
     * Projects this run deliberately omits (CI filtered installs). Their
     * manifests, and override/catalog addresses that the committed pnpm lockfile
     * reaches only through them, are reported as unvalidated warnings instead of
     * profile violations. Release verification never accepts exclusions.
     */
    readonly excludedProjects?: readonly ExcludedPackageSourceProject[];
  } = {},
): Promise<readonly Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const profileName = options.profile ?? 'ci';
  const excludedProjects = options.excludedProjects ?? [];
  if (excludedProjects.length && profileName === 'release')
    throw new Error(
      'The release package-source profile validates every project; excluded projects are not accepted.',
    );
  if (
    excludedProjects.some(({ root: projectRoot }) =>
      ['', '.'].includes(projectRoot.replace(/\/+$/, '')),
    )
  )
    throw new Error(
      'The workspace root project cannot be excluded from package-source validation.',
    );
  const excludedRoots = excludedProjects.map(({ root: projectRoot }) =>
    projectRoot.replace(/\\/g, '/').replace(/\/+$/, ''),
  );
  const excludedBy = (manifestPath: string) =>
    excludedProjects.find(({ root: projectRoot }) =>
      insideProject(manifestPath, projectRoot.replace(/\\/g, '/')),
    );
  const configuredPolicy = config.packageSources.profiles[profileName];
  const localReferences =
    profileName === 'ci' && !config.packageSources.forbidLocalInCi
      ? 'allow'
      : configuredPolicy.localReferences;
  const approved = new Set(
    profileName === 'release' ? [] : configuredPolicy.approved,
  );
  const manager = config.conventions.packageManager;
  const lockfiles = packageManagerAdapter(manager).lockfiles;
  const hasLockfile = (
    await Promise.all(lockfiles.map((lockfile) => exists(join(root, lockfile))))
  ).some(Boolean);
  if ((profileName === 'ci' || profileName === 'release') && !hasLockfile) {
    const lockfile = lockfiles[0] ?? 'package.json';
    diagnostics.push({
      severity: 'error',
      code: 'package-sources-lockfile',
      path: lockfile,
      message: `The ${profileName} profile requires a committed ${manager} lockfile (${lockfiles.join(' or ')}).`,
    });
  }
  const addresses: PackageAddress[] = [];
  for (const absolutePath of await packageManifests(root)) {
    const path = relative(root, absolutePath).split('\\').join('/');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await readFile(absolutePath, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    addresses.push(
      ...manifestPackageAddresses(manifest, path, dirname(absolutePath)),
    );
  }
  const pnpmAddresses = await pnpmWorkspaceAddresses(root);
  if (Array.isArray(pnpmAddresses)) addresses.push(...pnpmAddresses);
  else diagnostics.push(pnpmAddresses);
  let hasApprovedYalcReference = false;
  let hasUnapprovedYalcReference = false;
  const reachable =
    excludedProjects.length && manager === 'pnpm'
      ? await pnpmReachablePackages(root, excludedRoots)
      : undefined;
  for (const address of addresses) {
    if (!isLocalPackageAddress(address.specifier)) continue;
    const locator = addressLocator(address);
    const owner = excludedBy(address.manifestPath);
    const addressed = owner ? undefined : addressedPackage(address.location);
    if (
      localReferences !== 'allow' &&
      (owner || (addressed && reachable && !reachable.has(addressed)))
    ) {
      diagnostics.push({
        severity: 'warning',
        code: 'package-sources-excluded-project',
        path: address.manifestPath,
        message: owner
          ? `${address.location} uses local address ${address.specifier} in excluded project ${owner.name}; it is not validated by this ${profileName} run. Locator: ${locator}.`
          : `${address.location} uses local address ${address.specifier}, which the committed pnpm lockfile reaches only through excluded projects (${excludedProjects.map(({ name }) => name).join(', ')}); it is not validated by this ${profileName} run. Locator: ${locator}.`,
      });
      continue;
    }
    const isApproved = approved.has(locator);
    const isYalc = /(?:^|[/:])\.yalc(?:\/|$)/.test(address.specifier.trim());
    if (isYalc) {
      if (isApproved) hasApprovedYalcReference = true;
      else hasUnapprovedYalcReference = true;
    }
    if (localReferences === 'allow' || isApproved) continue;
    const problem = await localPackageAddressProblem(root, address);
    if (!problem && profileName !== 'release' && localReferences !== 'warn')
      continue;
    diagnostics.push({
      severity: localReferences === 'warn' ? 'warning' : 'error',
      code: 'package-sources-local-dependency',
      path: address.manifestPath,
      message:
        `${address.location} uses local address ${address.specifier}. ` +
        (problem ??
          'Release verification requires a registry-resolved package.') +
        (localReferences === 'warn'
          ? ` Replace it before running the release profile. Locator: ${locator}.`
          : ' Use a registry package or an explicitly approved CI fixture.'),
    });
  }
  for (const path of ['yalc.lock', '.yalc']) {
    if (!(await exists(join(root, path)))) continue;
    if (localReferences === 'allow') continue;
    if (
      profileName === 'ci' &&
      hasApprovedYalcReference &&
      !hasUnapprovedYalcReference
    )
      continue;
    diagnostics.push({
      severity: localReferences === 'warn' ? 'warning' : 'error',
      code: 'package-sources-local-state',
      path,
      message:
        (localReferences === 'warn'
          ? 'Yalc state is permitted during migration but must be replaced before release.'
          : `${profileName} package policy does not permit Yalc state, even when Git ignores it.`) +
        (hasApprovedYalcReference || hasUnapprovedYalcReference
          ? ' Yalc dependency addresses are present in package manifests or package-manager source configuration; replace those addresses with registry packages before release.'
          : ' No Yalc dependency addresses were found in package manifests or package-manager source configuration; this may be leftover local state, rather than an active dependency.') +
        ' Verify the committed dependency setup in a separate clean checkout without local Yalc state. This check does not remove local files or change dependency sources.',
    });
  }
  const npmrc = (await exists(join(root, '.npmrc')))
    ? await readFile(join(root, '.npmrc'), 'utf8')
    : '';
  for (const [scope, registry] of Object.entries(
    config.packageSources.registries,
  )) {
    const expected = `${scope}:registry=${registry}`;
    if (!npmrc.split(/\r?\n/).some((line) => line.trim() === expected)) {
      diagnostics.push({
        severity: 'error',
        code: 'package-sources-registry',
        path: '.npmrc',
        message: `Configured registry routing is missing: ${expected}. Authentication remains CI-owned.`,
      });
    }
  }
  return diagnostics;
}
