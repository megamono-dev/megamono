import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createToolingLayout, readToolingLock } from './tooling-lock.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pathIn = (root, path) => {
  const value = relative(root, path);
  return !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
};
const portable = (path) => path.replaceAll('\\', '/');
const exactVersion = (ref) => {
  const version = typeof ref === 'string' ? ref.split('(')[0] : undefined;
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? ''))
    throw new Error(`Unsupported dependency resolution reference: ${ref}`);
  return version;
};

async function ownerManifest(root, path, layout) {
  const directory = resolve(root, path);
  if (!pathIn(root, directory))
    throw new Error(`Consumer path escapes workspace: ${path}`);
  if (path.startsWith('node_modules/'))
    layout.artifact(directory, { directory: true });
  else {
    let current = root;
    for (const segment of relative(root, directory)
      .split(sep)
      .filter(Boolean)) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Refusing a symlinked workspace consumer: ${path}`);
    }
  }
  const file = join(directory, 'package.json');
  if ((await lstat(file)).isSymbolicLink())
    throw new Error(`Refusing a symlinked consumer manifest: ${path}`);
  return {
    directory,
    file,
    manifest: JSON.parse(await readFile(file, 'utf8')),
  };
}

async function inspectTarget(root, layout, owner, dependency, edge) {
  const require = createRequire(owner.file);
  const entry = layout.artifact(require.resolve(dependency));
  let directory = dirname(entry);
  let manifestPath;
  let manifestBytes;
  let manifest;
  while (
    pathIn(layout.nodeModules, directory) &&
    directory !== layout.nodeModules
  ) {
    try {
      const candidate = layout.artifact(join(directory, 'package.json'));
      const bytes = await readFile(candidate);
      const value = JSON.parse(bytes);
      if (value.name === dependency) {
        manifestPath = candidate;
        manifestBytes = bytes;
        manifest = value;
        break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    directory = dirname(directory);
  }
  if (!manifestPath)
    throw new Error(
      `Resolved ${dependency} entry has no matching package manifest.`,
    );
  const packagePath = portable(relative(root, dirname(manifestPath)));
  const candidates =
    layout.lock.format === 'npm'
      ? layout.lock.entries.filter((record) => record.key === packagePath)
      : layout.lock.entries.filter(
          (record) =>
            record.name === dependency && record.version === manifest.version,
        );
  const expectedVersions = edge.resolutionRefs
    ? [...new Set(edge.resolutionRefs.map(exactVersion))]
    : [...new Set(candidates.map((record) => record.version))];
  const unambiguous = expectedVersions.length === 1;
  return {
    packagePath,
    version: manifest.version,
    manifestSha256: digest(manifestBytes),
    entry: portable(relative(root, entry)),
    entrySha256: digest(await readFile(entry)),
    lockedVersion: unambiguous ? expectedVersions[0] : null,
    lockedVersions: expectedVersions,
    matchingLockKeys: candidates.map((record) => record.key).sort(),
    matchesLockedVersion:
      unambiguous &&
      expectedVersions[0] === manifest.version &&
      candidates.length > 0,
    ...(layout.lock.format === 'pnpm'
      ? {
          peerContextAssociation: unambiguous
            ? 'not-inferred-identical-target-versions'
            : 'ambiguous-differing-target-versions',
        }
      : {}),
  };
}

function edgesFromLock(lock, dependency) {
  const edges = [];
  if (lock.format === 'npm') {
    for (const record of lock.entries) {
      const sections = [
        'dependencies',
        'optionalDependencies',
        ...(!record.key.startsWith('node_modules/') ? ['devDependencies'] : []),
      ];
      for (const section of sections) {
        if (!record[section]?.[dependency]) continue;
        edges.push({
          path: record.key,
          name: record.name,
          version: record.version,
          section,
          range: record[section][dependency],
          lockKeys: [record.key],
        });
      }
    }
  } else {
    const groups = new Map();
    for (const record of lock.entries) {
      for (const section of ['dependencies', 'optionalDependencies']) {
        const ref = record[section]?.[dependency];
        if (!ref) continue;
        const key = `${record.name}\0${record.version}\0${section}`;
        const group = groups.get(key) ?? {
          name: record.name,
          version: record.version,
          section,
          lockKeys: [],
          resolutionRefs: [],
        };
        group.lockKeys.push(record.key);
        group.resolutionRefs.push(ref);
        groups.set(key, group);
      }
    }
    edges.push(...groups.values());
    for (const [path, importer] of Object.entries(lock.raw.importers ?? {})) {
      for (const section of [
        'dependencies',
        'optionalDependencies',
        'devDependencies',
      ]) {
        const value = importer[section]?.[dependency];
        if (!value) continue;
        if (typeof value !== 'object' || typeof value.version !== 'string')
          throw new Error(
            `Unsupported pnpm importer dependency: ${path}:${dependency}`,
          );
        edges.push({
          path: path === '.' ? '' : path,
          section,
          lockedSpecifier: value.specifier ?? null,
          importer: path,
          lockKeys: [`importer:${path}`],
          resolutionRefs: [value.version],
        });
      }
    }
  }
  return edges;
}

/** Direct locked edges and actual installed resolutions; never infers PNPM peer-folder encodings. */
export async function inventoryToolingDependency(workspaceRoot, dependency) {
  const root = await realpath(workspaceRoot);
  const lock = readToolingLock(root);
  const edges = edgesFromLock(lock, dependency);
  const errors = [];
  let layout;
  let layoutError;
  try {
    layout = createToolingLayout(root, lock);
  } catch (error) {
    layoutError = error.message;
    errors.push(layoutError);
  }
  const consumers = [];
  for (const edge of edges) {
    let paths;
    try {
      if (edge.path !== undefined) paths = [edge.path];
      else {
        if (layoutError) throw new Error(layoutError);
        paths = [];
        for (const directory of layout.packageRoots(edge.name)) {
          const manifest = JSON.parse(
            await readFile(
              layout.artifact(join(directory, 'package.json')),
              'utf8',
            ),
          );
          if (manifest.version === edge.version)
            paths.push(portable(relative(root, directory)));
        }
      }
    } catch (error) {
      paths = [];
      errors.push(`${edge.name ?? edge.path}: ${error.message}`);
    }
    if (!paths.length) paths = [undefined];
    for (const path of paths) {
      const consumer = {
        ...edge,
        path: path ?? `snapshot:${edge.lockKeys.join(',')}`,
      };
      try {
        if (layoutError) throw new Error(layoutError);
        if (path === undefined)
          throw new Error(
            `No installed physical copy of ${edge.name}@${edge.version}.`,
          );
        const owner = await ownerManifest(root, path, layout);
        if (edge.name && owner.manifest.name !== edge.name)
          throw new Error(
            'Installed consumer name differs from lock inventory.',
          );
        consumer.name = owner.manifest.name ?? edge.name;
        consumer.version = owner.manifest.version ?? edge.version;
        if (edge.version && consumer.version !== edge.version)
          throw new Error(
            'Installed consumer version differs from lock inventory.',
          );
        const declared = [
          edge.section,
          ...[
            'dependencies',
            'optionalDependencies',
            'peerDependencies',
            'devDependencies',
          ].filter((section) => section !== edge.section),
        ].find((section) => owner.manifest[section]?.[dependency]);
        consumer.declaredSection = declared ?? null;
        consumer.declaredRange = declared
          ? owner.manifest[declared][dependency]
          : null;
        if (lock.format === 'pnpm') consumer.range = consumer.declaredRange;
        consumer.installed = await inspectTarget(
          root,
          layout,
          owner,
          dependency,
          edge,
        );
        if (!consumer.installed.matchesLockedVersion)
          errors.push(
            `${consumer.path}: installed ${dependency} does not match an unambiguous locked version.`,
          );
      } catch (error) {
        consumer.error = error.message;
        errors.push(`${consumer.path}: ${error.message}`);
      }
      consumers.push(consumer);
    }
  }
  return {
    root,
    lock,
    layout,
    consumers: consumers.sort((a, b) =>
      `${a.path}:${a.section}`.localeCompare(`${b.path}:${b.section}`),
    ),
    errors,
    lockfile: {
      format: lock.format,
      file: lock.file,
      sha256: digest(lock.bytes),
    },
    installedResolutions: errors.length ? 'partial' : 'completed',
  };
}
