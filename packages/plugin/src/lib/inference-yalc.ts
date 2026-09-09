import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { rcompare, satisfies, valid } from 'semver';

interface Manifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/** Preflight is read-only; Yalc consumer registration happens only post-flush. */
export function planInferenceYalc(
  names: readonly string[],
  version: string,
  root: string,
  store = execFileSync('yalc', ['dir'], { encoding: 'utf8' }).trim(),
  add: (args: string[], cwd: string) => void = (args, cwd) => {
    execFileSync('yalc', args, { cwd, stdio: 'inherit' });
  },
) {
  const selected = new Map<string, Manifest>();
  const visit = (name: string, range: string) => {
    const existing = selected.get(name);
    if (existing) {
      if (!satisfies(existing.version, range, { includePrerelease: true }))
        throw new Error(
          `Conflicting inferred Yalc dependency ${name}: ${existing.version} does not satisfy ${range}.`,
        );
      return;
    }
    if (!/^@megamono\/[a-z0-9-]+$/.test(name))
      throw new Error(`Invalid inferred package name ${name}.`);
    const directory = join(store, 'packages', name);
    let candidates: string[];
    try {
      candidates = readdirSync(directory)
        .filter(
          (entry) =>
            valid(entry) &&
            satisfies(entry, range, { includePrerelease: true }),
        )
        .sort(rcompare);
    } catch (error) {
      throw new Error(
        `Cannot read Yalc artifacts for ${name} at ${directory}; check store permissions and publication.`,
        { cause: error },
      );
    }
    const chosen = candidates[0];
    if (!chosen)
      throw new Error(
        `No published Yalc artifact satisfies ${name}@${range}. Publish the required build before adoption.`,
      );
    const manifest = JSON.parse(
      readFileSync(join(directory, chosen, 'package.json'), 'utf8'),
    ) as Manifest;
    if (manifest.name !== name || manifest.version !== chosen)
      throw new Error(`Yalc manifest identity mismatch for ${name}@${chosen}.`);
    selected.set(name, manifest);
    for (const [dependency, required] of Object.entries(
      manifest.dependencies ?? {},
    ))
      if (dependency.startsWith('@megamono/')) visit(dependency, required);
    for (const [dependency, required] of Object.entries(
      manifest.peerDependencies ?? {},
    ))
      if (
        dependency.startsWith('@megamono/') &&
        !manifest.peerDependenciesMeta?.[dependency]?.optional
      )
        visit(dependency, required);
  };
  for (const name of [...names].sort()) visit(name, version);
  const packages = [...selected.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return {
    packages: packages.map(({ name, version }) => `${name}@${version}`),
    dependencies: Object.fromEntries(
      packages.map(({ name }) => [name, `file:.yalc/${name}`]),
    ),
    install: async () => {
      // Do not refresh or register consumers during survey/dry-run planning.
      add(
        [
          'add',
          ...packages.map(({ name, version }) => `${name}@${version}`),
          '--dev',
          '--no-pure',
        ],
        root,
      );
      for (const artifact of packages) {
        const directory = join(root, '.yalc', artifact.name);
        const path = join(directory, 'package.json');
        const installed = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
        if (
          installed.name !== artifact.name ||
          installed.version !== artifact.version
        )
          throw new Error(
            `Installed Yalc identity changed for ${artifact.name}; reconcile before installing dependencies.`,
          );
        // Bind transitive runtime edges to the same local closure. Required peers
        // are installed at the root and retain their compatibility ranges.
        const dependencies = installed.dependencies ?? {};
        for (const dependency of Object.keys(dependencies))
          if (selected.has(dependency))
            dependencies[dependency] =
              `file:${relative(directory, join(root, '.yalc', dependency)).replaceAll('\\', '/')}`;
        writeFileSync(path, `${JSON.stringify(installed, null, 2)}\n`);
      }
    },
  };
}
