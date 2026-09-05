import type { Tree } from '@nx/devkit';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { satisfies, validRange } from 'semver';
import { z } from 'zod';
import { integrationFingerprint } from './integration-migrations';

const manifestSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    dependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    peerDependenciesMeta: z
      .record(
        z.string(),
        z.object({ optional: z.boolean().optional() }).passthrough(),
      )
      .optional(),
  })
  .passthrough();
export interface InstalledArtifact {
  name: string;
  version: string;
  digest: string;
  contentDigest: string;
  manifestDigest: string;
  buildIdentity?: unknown;
  dependencies: {
    name: string;
    range: string;
    version?: string;
    manifestDigest?: string;
    optional: boolean;
  }[];
}
export interface ArtifactProvenance {
  schemaVersion: 1;
  roots: string[];
  packages: InstalledArtifact[];
  fingerprint: string;
  findings: {
    code:
      | 'stale-installed-artifact'
      | 'yalc-store-differs'
      | 'peer-unavailable'
      | 'peer-incompatible';
    package: string;
    severity: 'error' | 'warning';
    message: string;
  }[];
}

/** Hash actual installed bytes; build-info and Yalc signatures are not trusted substitutes. */
export function collectIntegrationProvenance(
  tree: Tree,
  roots: readonly string[],
  yalcStore = join(homedir(), '.yalc'),
): ArtifactProvenance {
  const read = (path: string): Buffer | null => {
    if (!path.startsWith('/')) {
      const value = tree.read(path);
      if (value !== null) return value;
    }
    if (tree.root === '/virtual') return null;
    try {
      return readFileSync(resolve(tree.root, path));
    } catch (error) {
      if (
        ['ENOENT', 'ENOTDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        return null;
      throw error;
    }
  };
  const children = (path: string): string[] => {
    const virtual = !path.startsWith('/') ? tree.children(path) : [];
    if (virtual.length || tree.root === '/virtual') return virtual;
    try {
      return readdirSync(resolve(tree.root, path));
    } catch (error) {
      if (
        ['ENOENT', 'ENOTDIR'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        return [];
      throw error;
    }
  };
  const packageRoot = (name: string, parent = ''): string | undefined => {
    if (
      !/^@(?:playstack|megamono)\/[a-z0-9._-]+$/.test(name) &&
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)
    )
      throw new Error(`Invalid package identity ${name}.`);
    if (tree.root !== '/virtual') {
      try {
        return dirname(
          createRequire(resolve(tree.root, parent, 'package.json')).resolve(
            `${name}/package.json`,
          ),
        );
      } catch {
        /* Virtual generator additions may not yet exist on disk. */
      }
    }
    for (const candidate of [
      join(parent, 'node_modules', name),
      join('node_modules', name),
    ])
      if (read(join(candidate, 'package.json'))) return candidate;
    return undefined;
  };
  const inspect = (root: string): InstalledArtifact => {
    const raw = read(join(root, 'package.json'));
    if (!raw)
      throw new Error(
        `Missing installed package manifest ${root}/package.json.`,
      );
    const manifest = manifestSchema.parse(JSON.parse(raw.toString()));
    const normalizedManifest = Object.fromEntries(
      Object.entries(manifest).filter(
        ([key]) => !key.startsWith('_') && key !== 'yalcSig',
      ),
    );
    const hash = createHash('sha256');
    let count = 0;
    let bytes = 0;
    const walk = (path: string, prefix = '') => {
      for (const name of children(path).sort()) {
        if (
          [
            'node_modules',
            '.git',
            '.yalc',
            'yalc.sig',
            'build-info.json',
          ].includes(name) ||
          (!prefix && name === 'package.json') ||
          name.endsWith('.tsbuildinfo')
        )
          continue;
        const file = join(path, name);
        if (tree.root !== '/virtual') {
          try {
            if (lstatSync(resolve(tree.root, file)).isSymbolicLink())
              throw new Error(
                `Package artifact contains a nested symlink: ${file}.`,
              );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        let value: Buffer | null;
        try {
          value = read(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
          value = null;
        }
        if (value === null) {
          walk(file, `${prefix}${name}/`);
          continue;
        }
        if (++count > 30_000 || (bytes += value.length) > 200_000_000)
          throw new Error(
            `Package ${manifest.name} exceeds artifact snapshot limits.`,
          );
        hash.update(`${prefix}${name}\0${value.length}\0`).update(value);
      }
    };
    walk(root);
    const build = read(join(root, 'dist/build-info.json'));
    const buildIdentity: unknown = build
      ? z
          .object({
            revision: z
              .string()
              .regex(/^[a-f0-9]{40}$/)
              .optional(),
            buildId: z
              .string()
              .regex(/^[a-f0-9]+$/)
              .optional(),
            dirty: z.boolean().optional(),
          })
          .parse(JSON.parse(build.toString()))
      : undefined;
    const manifestDigest = integrationFingerprint(normalizedManifest);
    const contentDigest = hash.digest('hex');
    return {
      name: manifest.name,
      version: manifest.version,
      manifestDigest,
      contentDigest,
      digest: integrationFingerprint({
        manifestDigest,
        contentDigest,
        buildIdentity,
      }),
      ...(buildIdentity ? { buildIdentity } : {}),
      dependencies: [],
    };
  };
  const packages = new Map<string, InstalledArtifact>();
  const displayRange = (range: string) =>
    validRange(range) ? range : '[non-semver specifier]';
  const findings: ArtifactProvenance['findings'] = [];
  const seen = new Set<string>();
  const visit = (name: string, parent = '') => {
    const location = packageRoot(name, parent);
    if (!location)
      throw new Error(
        `Required integration package ${name} is not installed; no dependency installation was attempted.`,
      );
    if (seen.has(location)) return;
    seen.add(location);
    const artifact = inspect(location);
    if (artifact.name !== name)
      throw new Error(
        `Resolved ${name} has unexpected identity ${artifact.name}.`,
      );
    const prior = packages.get(name);
    if (prior && prior.digest !== artifact.digest)
      throw new Error(
        `Multiple different installed builds of ${name} occur in the selected closure.`,
      );
    packages.set(name, artifact);
    const manifest = manifestSchema.parse(
      JSON.parse(read(join(location, 'package.json'))?.toString() ?? '{}'),
    );
    const edges = new Map(
      Object.entries(manifest.dependencies ?? {}).map(([dependency, range]) => [
        dependency,
        { range, optional: false },
      ]),
    );
    for (const [dependency, range] of Object.entries(
      manifest.peerDependencies ?? {},
    )) {
      const optional =
        manifest.peerDependenciesMeta?.[dependency]?.optional === true;
      const dependencyRoot = packageRoot(dependency, location);
      const peer = dependencyRoot
        ? manifestSchema.parse(
            JSON.parse(
              read(join(dependencyRoot, 'package.json'))?.toString() ?? '{}',
            ),
          )
        : undefined;
      if (!peer && !optional)
        findings.push({
          code: 'peer-unavailable',
          package: dependency,
          severity: 'error',
          message: `${name} requires peer ${dependency}@${displayRange(range)}; install it explicitly.`,
        });
      if (peer && !satisfies(peer.version, range, { includePrerelease: true }))
        findings.push({
          code: 'peer-incompatible',
          package: dependency,
          severity: 'error',
          message: `${name} requires ${dependency}@${displayRange(range)}, but ${peer.version} is installed.`,
        });
      if (!edges.has(dependency)) edges.set(dependency, { range, optional });
    }
    for (const [dependency, edge] of [...edges].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const dependencyRoot = packageRoot(dependency, location);
      const raw = dependencyRoot
        ? read(join(dependencyRoot, 'package.json'))
        : null;
      const resolved = raw
        ? manifestSchema.parse(JSON.parse(raw.toString()))
        : undefined;
      artifact.dependencies.push({
        name: dependency,
        ...edge,
        range: displayRange(edge.range),
        ...(resolved
          ? {
              version: resolved.version,
              manifestDigest: integrationFingerprint(resolved),
            }
          : {}),
      });
      if (
        /^@(?:playstack|megamono)\//.test(dependency) &&
        (!edge.optional || resolved)
      )
        visit(dependency, location);
    }
    for (const [kind, candidate] of [
      ['consumer', join('.yalc', name)],
      ['store', join(yalcStore, 'packages', name, artifact.version)],
    ] as const) {
      if (!read(join(candidate, 'package.json'))) continue;
      const other = inspect(candidate);
      if (
        artifact.contentDigest !== other.contentDigest ||
        artifact.version !== other.version
      )
        findings.push({
          code:
            kind === 'consumer'
              ? 'stale-installed-artifact'
              : 'yalc-store-differs',
          package: name,
          severity: kind === 'consumer' ? 'error' : 'warning',
          message:
            kind === 'consumer'
              ? `Installed ${name} differs from the consumer .yalc payload. Review and refresh dependencies explicitly; a Yalc push alone may not update node_modules.`
              : `The Yalc store has different bytes for ${name}@${artifact.version}; the plan binds the installed build, not the store.`,
        });
    }
  };
  for (const name of [...new Set(roots)].sort()) visit(name);
  const records = [...packages.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return {
    schemaVersion: 1,
    roots: [...new Set(roots)].sort(),
    packages: records,
    fingerprint: integrationFingerprint(records),
    findings,
  };
}
