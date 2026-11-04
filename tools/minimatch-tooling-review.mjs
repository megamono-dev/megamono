#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const lockBytes = await readFile(join(root, 'package-lock.json'));
const lock = JSON.parse(lockBytes);

async function installedMinimatch(consumerPath) {
  try {
    const require = createRequire(join(root, consumerPath, 'package.json'));
    let directory = dirname(require.resolve('minimatch'));
    while (directory !== dirname(directory)) {
      try {
        const manifestPath = join(directory, 'package.json');
        const bytes = await readFile(manifestPath);
        const manifest = JSON.parse(bytes);
        if (manifest.name === 'minimatch') {
          const path = relative(root, directory).replaceAll('\\', '/');
          return {
            path,
            version: manifest.version,
            manifestSha256: digest(bytes),
            lockedVersion: lock.packages[path]?.version ?? null,
            matchesLock: lock.packages[path]?.version === manifest.version,
          };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      directory = dirname(directory);
    }
    return { error: 'Resolved entry has no minimatch package manifest.' };
  } catch (error) {
    return { error: error.code ?? error.message };
  }
}

const consumers = await Promise.all(
  Object.entries(lock.packages)
    .filter(([, manifest]) => manifest.dependencies?.minimatch)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(async ([path, manifest]) => ({
      path,
      name: path.slice(path.lastIndexOf('node_modules/') + 13),
      version: manifest.version,
      requestedMinimatch: manifest.dependencies.minimatch,
      installed: await installedMinimatch(path),
    })),
);

// These are concrete legacy API consumers, not an exhaustive source scan.
const anchors = [
  ['node_modules/nx/dist/src/utils/find-matching-projects.js', 'makeRe('],
  ['node_modules/nx/dist/src/generators/utils/glob.js', 'makeRe('],
  ['node_modules/@verdaccio/core/build/auth-utils.js', 'makeRe('],
  [
    'node_modules/@rollup/plugin-commonjs/node_modules/glob/sync.js',
    'this.minimatch.set',
  ],
  [
    'node_modules/fork-ts-checker-webpack-plugin/lib/issue/issue-match.js',
    'minimatch_1.default)',
  ],
];
const sourceEvidence = await Promise.all(
  anchors.map(async ([path, api]) => {
    try {
      const bytes = await readFile(join(root, path));
      const lines = bytes
        .toString('utf8')
        .split('\n')
        .flatMap((line, index) => (line.includes(api) ? [index + 1] : []));
      return { path, api, lines, sha256: digest(bytes) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { path, api, missing: true };
    }
  }),
);

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      reviewedAt: new Date().toISOString(),
      scope:
        'Read-only npm lockfile, installed-resolution, and legacy API inventory.',
      lockfileSha256: digest(lockBytes),
      consumers,
      sourceEvidence,
      limitations: [
        'Not a registry audit, advisory exception, exploit assessment, or release approval.',
        'Legacy API anchors are deliberately bounded and are not all minimatch call sites.',
        'An absent anchor or changed dependency version does not establish remediation.',
      ],
    },
    null,
    2,
  )}\n`,
);
