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

export async function validatePackageSources(
  root: string,
  config: MegamonoConfig,
  options: { readonly profile?: PackageSourceProfileName } = {},
): Promise<readonly Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const profileName = options.profile ?? 'ci';
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
  for (const address of addresses) {
    if (!isLocalPackageAddress(address.specifier)) continue;
    const locator = addressLocator(address);
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
        localReferences === 'warn'
          ? 'Yalc state is permitted during migration but must be replaced before release.'
          : `${profileName} package policy does not permit Yalc state.`,
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
