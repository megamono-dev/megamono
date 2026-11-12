import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

const inside = (parent, candidate) => {
  const path = relative(parent, candidate);
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
};

function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function safeKey(key) {
  if (isAbsolute(key) || key.includes('\\') || key.split('/').includes('..'))
    throw new Error(`Refusing an escaped tooling lock path: ${key}`);
}

function packageIdentity(key) {
  const base = key.replace(/^\//, '').split('(')[0];
  const at = base.lastIndexOf('@');
  if (at <= 0) throw new Error(`Unsupported pnpm package identity: ${key}`);
  return { name: base.slice(0, at), version: base.slice(at + 1), base };
}

/** Normalize lock evidence without installing, resolving packages, or executing code. */
export function readToolingLock(workspaceRoot) {
  const root = realpathSync(workspaceRoot);
  const files = ['package-lock.json', 'pnpm-lock.yaml'].filter((file) =>
    existsSync(join(root, file)),
  );
  if (files.length !== 1)
    throw new Error('Expected exactly one npm or pnpm tooling lockfile.');
  const file = files[0];
  const path = join(root, file);
  if (lstatSync(path).isSymbolicLink())
    throw new Error('Refusing a symlinked tooling lockfile.');
  const bytes = readFileSync(path);
  const format = file === 'pnpm-lock.yaml' ? 'pnpm' : 'npm';
  const raw =
    format === 'pnpm' ? parse(bytes.toString()) : JSON.parse(bytes.toString());
  if (!raw?.packages || typeof raw.packages !== 'object')
    throw new Error('The tooling lockfile has no packages inventory.');
  let entries;
  if (format === 'npm') {
    entries = Object.entries(raw.packages).map(([key, value]) => {
      safeKey(key);
      return {
        ...value,
        key,
        name:
          value.name ??
          key.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1] ??
          (key === '' ? raw.name : undefined),
      };
    });
  } else {
    if (!raw.snapshots || typeof raw.snapshots !== 'object')
      throw new Error('The pnpm lockfile has no snapshots inventory.');
    for (const key of Object.keys(raw.importers ?? {})) safeKey(key);
    entries = Object.entries(raw.snapshots).map(([key, value]) => {
      const identity = packageIdentity(key);
      const record = raw.packages[key] ?? raw.packages[identity.base];
      if (!record)
        throw new Error(`Missing pnpm package provenance for ${key}.`);
      return {
        ...value,
        key,
        ...identity,
        integrity: record.resolution?.integrity,
      };
    });
  }
  return { root, format, file, bytes, raw, entries };
}

function packageLink(relativePath) {
  const segments = relativePath.split(sep);
  let names;
  if (segments[0] !== '.pnpm') names = segments;
  else if (segments[1] === 'node_modules') names = segments.slice(2);
  else if (segments[2] === 'node_modules') names = segments.slice(3);
  else return false;
  return names.length === (names[0]?.startsWith('@') ? 2 : 1);
}

/** Only package links managed inside this workspace's virtual store may be followed. */
export function createToolingLayout(
  workspaceRoot,
  lock = readToolingLock(workspaceRoot),
) {
  const root = realpathSync(workspaceRoot);
  const requestedRoot = resolve(workspaceRoot);
  const nodeModules = join(root, 'node_modules');
  if (
    lstatSync(nodeModules).isSymbolicLink() ||
    realpathSync(nodeModules) !== nodeModules
  )
    throw new Error('Refusing node_modules outside the selected workspace.');
  const virtualStore =
    lock.format === 'pnpm' ? join(nodeModules, '.pnpm') : undefined;
  if (
    virtualStore &&
    (lstatSync(virtualStore).isSymbolicLink() ||
      realpathSync(virtualStore) !== virtualStore)
  )
    throw new Error('Refusing an external or symlinked pnpm virtual store.');

  const confined = (candidate, directory = false, managed = false) => {
    const requested = resolve(candidate);
    // Canonicalize only the caller's workspace prefix (e.g. macOS /var).
    // Artifact segments still undergo the strict symlink walk below.
    const absolute = inside(requestedRoot, requested)
      ? resolve(root, relative(requestedRoot, requested))
      : requested;
    if (!inside(nodeModules, absolute))
      throw new Error(
        `Refusing a tooling path outside ${nodeModules}: ${candidate}`,
      );
    let current = nodeModules;
    for (const segment of relative(nodeModules, absolute).split(sep)) {
      current = join(current, segment);
      if (!lstatSync(current).isSymbolicLink()) continue;
      const actual = realpathSync(current);
      if (
        !managed ||
        !virtualStore ||
        !packageLink(relative(nodeModules, current)) ||
        !inside(virtualStore, actual)
      )
        throw new Error(
          `Refusing an external or symlinked tooling path: ${current}`,
        );
    }
    const actual = realpathSync(absolute);
    const stat = lstatSync(actual);
    if (
      !inside(nodeModules, actual) ||
      (directory ? !stat.isDirectory() : !stat.isFile())
    )
      throw new Error(`Refusing an unexpected tooling artifact: ${candidate}`);
    return actual;
  };
  const artifact = (candidate, { directory = false } = {}) =>
    confined(candidate, directory);
  const packageRoots = (name) => {
    if (
      !/^(@[^/]+\/)?[^/]+$/.test(name) ||
      name.includes('..') ||
      name.includes('\\')
    )
      throw new Error(`Invalid tooling package name: ${name}`);
    const found = new Set();
    const alias = join(nodeModules, name);
    if (present(alias)) found.add(confined(alias, true, true));
    if (virtualStore) {
      for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        if (entry.isSymbolicLink())
          throw new Error(
            `Refusing a symlinked pnpm store entry: ${entry.name}`,
          );
        if (!entry.isDirectory()) continue;
        const candidate = join(virtualStore, entry.name, 'node_modules', name);
        if (present(candidate)) found.add(confined(candidate, true, true));
      }
    } else {
      for (const entry of lock.entries.filter(
        (entry) => entry.name === name && entry.key.startsWith('node_modules/'),
      )) {
        const candidate = join(root, entry.key);
        if (present(candidate)) found.add(confined(candidate, true));
      }
    }
    return [...found].sort();
  };
  return { root, nodeModules, virtualStore, lock, artifact, packageRoots };
}

export function verifyToolingLock(lock, manifestPath, expected) {
  const key = relative(lock.root, dirname(manifestPath)).replaceAll('\\', '/');
  const entries = lock.entries.filter((entry) =>
    lock.format === 'npm'
      ? entry.key === key
      : entry.name === expected.name && entry.version === expected.version,
  );
  if (
    !entries.length ||
    entries.some(
      (entry) =>
        entry.version !== expected.version ||
        entry.integrity !== expected.tarballIntegrity,
    )
  )
    throw new Error(
      `Unreviewed locked ${expected.name}@${expected.version} integrity at ${key}.`,
    );
  return entries;
}
