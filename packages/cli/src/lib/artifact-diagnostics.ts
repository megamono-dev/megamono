import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

export const ARTIFACT_HELP = `Usage: megamono diagnostics packages [--json] [--packages=<names>]
       [--yalc-store=<directory>] [--source-root=<repository>]

Compare package manifests and built dist bytes across node_modules, .yalc,
the Yalc store, PATH-selected CLIs, and optional source repository builds.
Defaults to declared Megamono/Playstack packages plus the Megamono store inventory.
Read-only: never installs, reconciles dependencies, or executes inspected CLIs.
Exit 1 means differences or unreadable artifacts need review, not automatic repair.
Source builds are not proof that current unbuilt source has been published.`;

const validName = (name: string) =>
  /^(?:@(?:megamono|playstack)\/[a-z0-9._-]+|create-megamono)$/.test(name);
const json = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8'));
function entries(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export interface ArtifactLocation {
  kind: 'installed' | 'payload' | 'store' | 'source-build' | 'path-cli';
  path: string;
  status: 'present' | 'missing' | 'unreadable';
  version?: string;
  digest?: string;
  build?: unknown;
  error?: string;
}

/** Deliberately bounded to manifest semantics and emitted files, not source certification. */
function inspect(
  name: string,
  kind: ArtifactLocation['kind'],
  path: string,
): ArtifactLocation {
  const location: ArtifactLocation = { kind, path, status: 'missing' };
  try {
    if (!existsSync(join(path, 'package.json'))) return location;
    const manifest = json(join(path, 'package.json'));
    if (manifest.name !== name || typeof manifest.version !== 'string')
      throw new Error('Package identity does not match the selected package.');
    location.version = manifest.version;
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, entry]) => [key, canonical(entry)]),
            )
          : value;
    const hash = createHash('sha256');
    hash.update(
      JSON.stringify(
        canonical(
          Object.fromEntries(
            [
              'name',
              'version',
              'type',
              'main',
              'module',
              'types',
              'exports',
              'dependencies',
              'peerDependencies',
              'peerDependenciesMeta',
              'engines',
              'bin',
            ].map((key) => [key, manifest[key]]),
          ),
        ),
      ),
    );
    let count = 0;
    const walk = (relative: string) => {
      for (const child of entries(join(path, relative))) {
        if (
          child === 'node_modules' ||
          child.endsWith('.tsbuildinfo') ||
          child === 'build-info.json'
        )
          continue;
        const file = join(relative, child);
        const stat = lstatSync(join(path, file));
        if (stat.isSymbolicLink())
          throw new Error(`Cannot qualify symlinked emitted file ${file}.`);
        if (stat.isDirectory()) walk(file);
        else if (stat.isFile()) {
          hash.update(JSON.stringify(file));
          hash.update(readFileSync(join(path, file)));
          count++;
        }
      }
    };
    walk('dist');
    if (!count)
      throw new Error(
        'No emitted dist files; build identity alone cannot establish artifact equality.',
      );
    location.digest = hash.digest('hex');
    if (existsSync(join(path, 'dist/build-info.json')))
      location.build = json(join(path, 'dist/build-info.json'));
    location.status = 'present';
  } catch (error) {
    location.status = 'unreadable';
    location.error = error instanceof Error ? error.message : String(error);
  }
  return location;
}

/** Resolve the first executable in PATH without executing a development checkout. */
function pathCli(name: string, pathValue: string): string | undefined {
  const executable = (
    {
      '@megamono/cli': 'megamono',
      'create-megamono': 'create-megamono',
      '@playstack/cli': 'playstack',
    } as Record<string, string>
  )[name];
  if (!executable) return undefined;
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const file = join(directory, executable);
    try {
      accessSync(file, constants.X_OK);
    } catch {
      continue;
    }
    let current = dirname(realpathSync(file));
    while (true) {
      if (
        existsSync(join(current, 'package.json')) &&
        json(join(current, 'package.json')).name === name
      )
        return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    // Do not silently inspect a later PATH entry when a wrapper shadows it.
    return undefined;
  }
  return undefined;
}

export function diagnoseArtifacts(options: {
  root: string;
  packages?: string[];
  store?: string;
  sourceRoot?: string;
  path?: string;
}) {
  const store = options.store ?? join(homedir(), '.yalc');
  const rootManifest = existsSync(join(options.root, 'package.json'))
    ? json(join(options.root, 'package.json'))
    : {};
  const declared = ['dependencies', 'devDependencies', 'optionalDependencies']
    .flatMap((key) =>
      Object.keys((rootManifest[key] as object | undefined) ?? {}),
    )
    .filter(validName);
  const names = [
    ...new Set(
      options.packages ?? [
        ...declared,
        '@megamono/cli',
        'create-megamono',
        ...entries(join(store, 'packages/@megamono')).map(
          (name) => `@megamono/${name}`,
        ),
      ],
    ),
  ].sort();
  if (!names.length || names.some((name) => !validName(name)))
    throw new Error(
      'Select Megamono/Playstack package names, not paths or package specifications.',
    );
  const sourcePackages = new Map<string, string>();
  if (options.sourceRoot)
    for (const directory of entries(join(options.sourceRoot, 'packages'))) {
      const path = join(options.sourceRoot, 'packages', directory);
      if (existsSync(join(path, 'package.json'))) {
        const name = json(join(path, 'package.json')).name;
        if (typeof name === 'string') sourcePackages.set(name, path);
      }
    }
  const packages = names.map((name) => {
    let installed = join(options.root, 'node_modules', name);
    try {
      installed = dirname(
        createRequire(join(options.root, 'package.json')).resolve(
          `${name}/package.json`,
        ),
      );
    } catch {
      /* Keep an explicit missing location. */
    }
    const locations = [
      inspect(name, 'installed', installed),
      inspect(name, 'payload', join(options.root, '.yalc', name)),
    ];
    for (const version of entries(join(store, 'packages', name)))
      locations.push(
        inspect(name, 'store', join(store, 'packages', name, version)),
      );
    const source = sourcePackages.get(name);
    if (source) locations.push(inspect(name, 'source-build', source));
    const global = pathCli(name, options.path ?? process.env.PATH ?? '');
    if (global) locations.push(inspect(name, 'path-cli', global));
    const findings: string[] = locations
      .filter((location) => location.status === 'unreadable')
      .map((location) => `${location.kind}: ${location.error}`);
    const present = locations.filter(
      (location) => location.status === 'present',
    );
    for (const version of new Set(
      present.map((location) => location.version),
    )) {
      const sameVersion = present.filter(
        (location) => location.version === version,
      );
      if (new Set(sameVersion.map((location) => location.digest)).size > 1)
        findings.push(
          `Same-version artifact drift at ${version}: ${sameVersion.map((location) => location.kind).join(', ')}. Review bytes before reconciling installs.`,
        );
    }
    const consumer = present.filter((location) =>
      ['installed', 'payload', 'path-cli'].includes(location.kind),
    );
    if (new Set(consumer.map((location) => location.version)).size > 1)
      findings.push('Installed, payload, or PATH CLI versions differ.');
    if (locations[0].status === 'missing' && locations[1].status === 'present')
      findings.push(
        'Yalc payload is present but no installed package resolves. A push alone did not complete installation.',
      );
    if (!present.length) findings.push('No inspectable built artifact found.');
    return { name, locations, findings };
  });
  return {
    schemaVersion: 1,
    comparisonScope: 'manifest-and-dist',
    root: options.root,
    store,
    packages,
    limitations: [
      'No runtime, peer-installation, or source freshness qualification was performed.',
      'PATH wrappers without a resolvable package manifest are not inspected; no CLI was executed.',
      'Different store versions are inventory, not an automatic upgrade recommendation.',
    ],
  };
}

export function artifactDiagnosticOptions(
  args: readonly string[],
  cwd: string,
) {
  const options: {
    root: string;
    packages?: string[];
    store?: string;
    sourceRoot?: string;
    json: boolean;
  } = { root: resolve(cwd), json: false };
  for (const arg of args) {
    if (arg === '--json') options.json = true;
    else if (arg.startsWith('--packages=') && arg.slice(11))
      options.packages = arg.slice(11).split(',');
    else if (arg.startsWith('--yalc-store=') && arg.slice(13))
      options.store = resolve(cwd, arg.slice(13));
    else if (arg.startsWith('--source-root=') && arg.slice(14))
      options.sourceRoot = resolve(cwd, arg.slice(14));
    else
      throw new Error(
        `Unknown or empty diagnostics option ${arg}.\n${ARTIFACT_HELP}`,
      );
  }
  return options;
}
