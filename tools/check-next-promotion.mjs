#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifests = [
  'packages/cli/package.json',
  'packages/plugin/package.json',
  'packages/nx-apple/package.json',
  'packages/nx-cargo/package.json',
  'packages/nx-cloudflare/package.json',
  'packages/nx-extension/package.json',
  'packages/nx-render/package.json',
  'packages/nx-laravel/package.json',
  'packages/nx-phpnative/package.json',
  'packages/create-megamono/package.json',
];

export function validateNextPromotion(packages) {
  const failures = [];
  for (const {
    name,
    currentVersion,
    publishedVersion,
    currentTree,
    publishedTree,
    publishedRevision,
  } of packages) {
    if (!/^\d+\.\d+\.\d+-next\.\d+$/.test(currentVersion)) {
      failures.push(
        `${name}: current version ${currentVersion} is not a next prerelease`,
      );
    }
    if (publishedVersion !== currentVersion) {
      failures.push(
        `${name}: npm next is ${publishedVersion || '(missing)'}, expected ${currentVersion}`,
      );
    }
    if (
      !/^[a-f0-9]{40}$/.test(publishedRevision ?? '') ||
      !/^[a-f0-9]{40}$/.test(publishedTree ?? '') ||
      currentTree !== publishedTree
    ) {
      failures.push(
        `${name}: checkout source does not match the published next revision; publish and evaluate a new next version first`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Stable promotion preflight failed:\n- ${failures.join('\n- ')}`,
    );
  }
}

async function publishedNext(name) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const { stdout } = await execFileAsync(
      npm,
      ['view', `${name}@next`, '--json'],
      { encoding: 'utf8' },
    );
    const value = JSON.parse(stdout);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function main() {
  const git = async (...args) =>
    (
      await execFileAsync('git', args, { cwd: root, encoding: 'utf8' })
    ).stdout.trim();
  if (await git('status', '--porcelain', '--untracked-files=all'))
    throw new Error('Stable promotion requires a clean checkout.');
  const currentTree = await git('rev-parse', 'HEAD^{tree}');
  const packages = await Promise.all(
    manifests.map(async (manifestPath) => {
      const manifest = JSON.parse(
        await readFile(join(root, manifestPath), 'utf8'),
      );
      const published = await publishedNext(manifest.name);
      const publishedRevision = published.gitHead;
      let publishedTree = '';
      if (/^[a-f0-9]{40}$/.test(publishedRevision ?? '')) {
        try {
          publishedTree = await git('rev-parse', `${publishedRevision}^{tree}`);
        } catch {
          /* Missing source history must fail closed, not skip verification. */
        }
      }
      return {
        name: manifest.name,
        currentVersion: manifest.version,
        publishedVersion: published.version,
        publishedRevision,
        currentTree,
        publishedTree,
      };
    }),
  );
  validateNextPromotion(packages);
  process.stdout.write(
    `Stable promotion preflight passed for ${packages.length} packages.\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
