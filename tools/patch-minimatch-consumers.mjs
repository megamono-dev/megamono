#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createToolingLayout, verifyToolingLock } from './tooling-lock.mjs';

const toolDirectory = dirname(fileURLToPath(import.meta.url));
export const provenance = JSON.parse(
  readFileSync(
    join(toolDirectory, 'minimatch-consumers.provenance.json'),
    'utf8',
  ),
);
const hash = (value) => createHash('sha256').update(value).digest('hex');

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
  const layout = createToolingLayout(workspaceRoot);
  const { lock } = layout;
  const plans = [];
  let reviewedFiles = 0;

  // Validate every package, resolution, and file before staging any writes.
  for (const expected of provenance.packages) {
    const packageRoots = layout.packageRoots(expected.name);
    if (!packageRoots.length)
      throw new Error(`Missing reviewed tooling package ${expected.name}.`);
    for (const packageRoot of packageRoots) {
      const manifestPath = layout.artifact(join(packageRoot, 'package.json'));
      verifyManifest(manifestPath, expected);
      verifyToolingLock(lock, manifestPath, expected);
      const dependency = provenance.dependencies[expected.requiredDependency];
      const require = createRequire(manifestPath);
      const dependencyManifest = layout.artifact(
        require.resolve(`${dependency.name}/package.json`),
      );
      verifyManifest(dependencyManifest, dependency);
      verifyToolingLock(lock, dependencyManifest, dependency);
      reviewedFiles += expected.files.length;
      for (const file of expected.files) {
        const path = layout.artifact(join(packageRoot, file.path));
        const source = readFileSync(path, 'utf8');
        const digest = hash(source);
        if (digest === file.patchedSha256) continue;
        if (digest !== file.originalSha256) {
          throw new Error(`Unrecognized ${expected.name}/${file.path} SHA256.`);
        }
        plans.push({ path, source, patched: transform(source, file) });
      }
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
      if (readFileSync(layout.artifact(plan.path), 'utf8') !== plan.source) {
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
    reviewedFiles,
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
