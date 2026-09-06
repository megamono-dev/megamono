#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDirectories = [
  'packages/cli',
  'packages/plugin',
  'packages/nx-apple',
  'packages/nx-cargo',
  'packages/nx-cloudflare',
  'packages/nx-extension',
  'packages/nx-render',
  'packages/nx-laravel',
  'packages/nx-phpnative',
  'packages/create-megamono',
];

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (entry.isFile() && entry.name !== 'build-info.json') found.push(path);
  }
  return found.sort();
}

const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const dirty =
  execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  }).trim().length > 0;

for (const directory of packageDirectories) {
  const packageRoot = join(root, directory);
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json')));
  const dist = join(packageRoot, 'dist');
  const hash = createHash('sha256');
  for (const path of await files(dist)) {
    hash.update(relative(dist, path));
    hash.update(await readFile(path));
  }
  const identity = {
    schemaVersion: 1,
    package: manifest.name,
    version: manifest.version,
    revision,
    dirty,
    buildId: hash.digest('hex').slice(0, 16),
  };
  await writeFile(
    join(dist, 'build-info.json'),
    `${JSON.stringify(identity, null, 2)}\n`,
  );
  process.stdout.write(
    `${identity.package}@${identity.version} ${identity.revision.slice(0, 12)} ${identity.buildId}${dirty ? ' dirty' : ''}\n`,
  );
}
