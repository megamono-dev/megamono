#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolDirectory = dirname(fileURLToPath(import.meta.url));
export const provenance = JSON.parse(
  readFileSync(
    join(toolDirectory, 'minimatch-consumers.provenance.json'),
    'utf8',
  ),
);
const hash = (value) => createHash('sha256').update(value).digest('hex');

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

function confined(parent, candidate, directory = false) {
  const absolute = resolve(candidate);
  if (!inside(parent, absolute)) {
    throw new Error(`Refusing a tooling path outside ${parent}: ${candidate}`);
  }
  let current = parent;
  for (const segment of relative(parent, absolute).split(sep)) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Refusing a symlinked tooling path: ${current}`);
    }
  }
  const actual = realpathSync(absolute);
  const stat = lstatSync(actual);
  if (
    !inside(parent, actual) ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  ) {
    throw new Error(`Refusing an unexpected tooling artifact: ${candidate}`);
  }
  return actual;
}

function verifyManifest(path, expected) {
  const bytes = readFileSync(path);
  const manifest = JSON.parse(bytes);
  if (
    manifest.name !== expected.name ||
    manifest.version !== expected.version ||
    hash(bytes) !== expected.manifestSha256
  ) {
    throw new Error(
      `Unreviewed ${expected.name}@${manifest.version} manifest at ${path}; expected ${expected.version} and recorded SHA256.`,
    );
  }
}

function verifyLock(root, lock, manifestPath, expected) {
  const key = relative(root, dirname(manifestPath)).replaceAll('\\', '/');
  const entry = lock.packages?.[key];
  if (
    entry?.version !== expected.version ||
    entry?.integrity !== expected.tarballIntegrity
  ) {
    throw new Error(
      `Unreviewed locked ${expected.name}@${expected.version} integrity at ${key}.`,
    );
  }
}

function transform(source, file) {
  let patched = source;
  for (const { before, after, count } of file.replacements) {
    if (patched.split(before).length - 1 !== count) {
      throw new Error(`Unexpected replacement boundary in ${file.path}.`);
    }
    patched = patched.replaceAll(before, after);
  }
  if (hash(patched) !== file.patchedSha256) {
    throw new Error(
      `Transformation does not match reviewed ${file.path} bytes.`,
    );
  }
  return patched;
}

/** Repository-local, byte-guarded migrations. No downloads, installs, or network. */
export function patchMinimatchConsumers(workspaceRoot, { check = false } = {}) {
  const root = realpathSync(workspaceRoot);
  const nodeModules = confined(root, join(root, 'node_modules'), true);
  const lock = JSON.parse(
    readFileSync(confined(root, join(root, 'package-lock.json')), 'utf8'),
  );
  const plans = [];

  // Validate every package, resolution, and file before staging any writes.
  for (const expected of provenance.packages) {
    const packageRoot = confined(
      nodeModules,
      join(nodeModules, expected.name),
      true,
    );
    const manifestPath = confined(
      packageRoot,
      join(packageRoot, 'package.json'),
    );
    verifyManifest(manifestPath, expected);
    verifyLock(root, lock, manifestPath, expected);
    const dependency = provenance.dependencies[expected.requiredDependency];
    const require = createRequire(manifestPath);
    const dependencyManifest = confined(
      nodeModules,
      require.resolve(`${dependency.name}/package.json`),
    );
    verifyManifest(dependencyManifest, dependency);
    verifyLock(root, lock, dependencyManifest, dependency);

    for (const file of expected.files) {
      const path = confined(packageRoot, join(packageRoot, file.path));
      const source = readFileSync(path, 'utf8');
      const digest = hash(source);
      if (digest === file.patchedSha256) continue;
      if (digest !== file.originalSha256) {
        throw new Error(`Unrecognized ${expected.name}/${file.path} SHA256.`);
      }
      plans.push({ path, source, patched: transform(source, file) });
    }
  }

  if (check && plans.length > 0) {
    throw new Error(
      `${plans.length} reviewed tooling files still require the minimatch migration.`,
    );
  }
  const staged = [];
  try {
    for (const plan of plans) {
      const temporaryPath = `${plan.path}.megamono-minimatch-${process.pid}.tmp`;
      const descriptor = openSync(
        temporaryPath,
        'wx',
        lstatSync(plan.path).mode,
      );
      staged.push({ ...plan, temporaryPath });
      try {
        writeFileSync(descriptor, plan.patched);
      } finally {
        closeSync(descriptor);
      }
    }
    // Recheck all destinations before the first atomic file replacement.
    for (const plan of staged) {
      if (
        readFileSync(confined(nodeModules, plan.path), 'utf8') !== plan.source
      ) {
        throw new Error(`Tooling artifact changed while staging: ${plan.path}`);
      }
    }
    for (const plan of staged) renameSync(plan.temporaryPath, plan.path);
  } finally {
    for (const plan of staged) rmSync(plan.temporaryPath, { force: true });
  }
  return {
    status: plans.length > 0 ? 'patched' : 'verified',
    changedFiles: plans.length,
    reviewedFiles: provenance.packages.reduce(
      (total, expected) => total + expected.files.length,
      0,
    ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--check') || args.length > 1) {
      throw new Error(
        'Usage: node tools/patch-minimatch-consumers.mjs [--check]',
      );
    }
    const result = patchMinimatchConsumers(dirname(toolDirectory), {
      check: args.includes('--check'),
    });
    console.log(
      `Repository minimatch migration: ${result.status} ${result.reviewedFiles} reviewed files (${result.changedFiles} changed).`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
