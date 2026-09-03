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
  'packages/create-megamono/package.json',
];

export function validateNextPromotion(packages) {
  const failures = [];
  for (const { name, currentVersion, publishedVersion } of packages) {
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
  }
  if (failures.length > 0) {
    throw new Error(
      `Stable promotion preflight failed:\n- ${failures.join('\n- ')}`,
    );
  }
}

async function publishedNextVersion(name) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const { stdout } = await execFileAsync(
      npm,
      ['view', `${name}@next`, 'version', '--json'],
      { encoding: 'utf8' },
    );
    const value = JSON.parse(stdout);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

async function main() {
  const packages = await Promise.all(
    manifests.map(async (manifestPath) => {
      const manifest = JSON.parse(
        await readFile(join(root, manifestPath), 'utf8'),
      );
      return {
        name: manifest.name,
        currentVersion: manifest.version,
        publishedVersion: await publishedNextVersion(manifest.name),
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
