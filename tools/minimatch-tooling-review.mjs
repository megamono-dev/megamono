#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventoryToolingDependency } from './tooling-dependency-inventory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (value) => createHash('sha256').update(value).digest('hex');

export async function reviewMinimatch(workspaceRoot) {
  const inventory = await inventoryToolingDependency(
    workspaceRoot,
    'minimatch',
  );
  const { root, layout } = inventory;
  // Concrete legacy APIs; an absent/changed anchor cannot establish remediation.
  const anchors = [
    ['nx', 'dist/src/utils/find-matching-projects.js', 'makeRe('],
    ['nx', 'dist/src/generators/utils/glob.js', 'makeRe('],
    ['@verdaccio/core', 'build/auth-utils.js', 'makeRe('],
    ['@rollup/plugin-commonjs', 'sync.js', 'this.minimatch.set', 'glob'],
    [
      'fork-ts-checker-webpack-plugin',
      'lib/issue/issue-match.js',
      'minimatch_1.default)',
    ],
  ];
  const sourceEvidence = [];
  for (const [name, file, api, resolvedDependency] of anchors) {
    let owners;
    try {
      owners = layout?.packageRoots(name) ?? [];
    } catch (error) {
      sourceEvidence.push({ owner: name, file, api, error: error.message });
      continue;
    }
    if (!owners.length)
      sourceEvidence.push({ owner: name, file, api, missing: true });
    for (const owner of owners) {
      let path;
      try {
        let directory = owner;
        if (resolvedDependency) {
          const require = createRequire(join(owner, 'package.json'));
          directory = dirname(
            layout.artifact(
              require.resolve(`${resolvedDependency}/package.json`),
            ),
          );
        }
        path = layout.artifact(join(directory, file));
        const bytes = await readFile(path);
        const lines = bytes
          .toString('utf8')
          .split('\n')
          .flatMap((line, index) => (line.includes(api) ? [index + 1] : []));
        sourceEvidence.push({
          owner: name,
          consumerPath: relative(root, owner).replaceAll('\\', '/'),
          path: relative(root, path).replaceAll('\\', '/'),
          api,
          lines,
          sha256: digest(bytes),
        });
      } catch (error) {
        sourceEvidence.push({
          owner: name,
          consumerPath: relative(root, owner).replaceAll('\\', '/'),
          file,
          api,
          ...(error.code === 'ENOENT' ||
          error.code === 'MODULE_NOT_FOUND' ||
          error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
            ? { missing: true }
            : { error: error.message }),
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    reviewedAt: new Date().toISOString(),
    scope:
      'Read-only npm/PNPM lockfile, actual installed resolutions, and bounded legacy API inventory.',
    lockfile: inventory.lockfile,
    lockfileSha256: inventory.lockfile.sha256,
    consumers: inventory.consumers.map((consumer) => ({
      ...consumer,
      requestedMinimatch: consumer.declaredRange ?? consumer.range,
      ...(consumer.installed
        ? {
            installed: {
              ...consumer.installed,
              path: consumer.installed.packagePath,
              matchesLock: consumer.installed.matchesLockedVersion,
            },
          }
        : {}),
    })),
    sourceEvidence,
    coverage: { installedResolutions: inventory.installedResolutions },
    errors: inventory.errors,
    limitations: [
      'Not a registry audit, advisory exception, exploit assessment, or release approval.',
      'PNPM snapshot dependency references are exact resolutions; declared ranges are read from installed consumer manifests.',
      'PNPM physical copies retain snapshot candidates; peer-context directory encodings are not inferred and differing target-version candidates remain incomplete coverage.',
      'Legacy API anchors are deliberately bounded and are not all minimatch call sites.',
      'An absent anchor or changed dependency version does not establish remediation.',
    ],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 2)
      throw new Error('Usage: node tools/minimatch-tooling-review.mjs');
    const report = await reviewMinimatch(root);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
