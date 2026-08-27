#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const privatePackages = new Map([
  ['@megamono/cli', 'packages/cli/package.json'],
  ['@megamono/plugin', 'packages/plugin/package.json'],
  ['@megamono/nx-apple', 'packages/nx-apple/package.json'],
  ['@megamono/nx-cargo', 'packages/nx-cargo/package.json'],
  ['@megamono/nx-cloudflare', 'packages/nx-cloudflare/package.json'],
]);
const expectedProjects = [
  '@megamono/cli',
  '@megamono/plugin',
  'nx-apple',
  'nx-cargo',
  'nx-cloudflare',
];
const expectedRepository = 'git+https://github.com/megamono-dev/megamono.git';
const expectedRegistry = 'https://registry.npmjs.org';
const failures = [];

const nx = JSON.parse(await readFile(join(root, 'nx.json'), 'utf8'));
const privateGroup = nx.release?.groups?.megamono;
const entryGroup = nx.release?.groups?.['create-megamono'];
const configuredProjects = privateGroup?.projects ?? [];

if (JSON.stringify(configuredProjects) !== JSON.stringify(expectedProjects)) {
  failures.push(
    `Nx release group megamono must contain ${expectedProjects.join(', ')}`,
  );
}
if (privateGroup?.projectsRelationship !== 'fixed') {
  failures.push('Nx release group megamono must have a fixed relationship');
}
if (privateGroup?.releaseTag?.pattern !== 'megamono@{version}') {
  failures.push('Nx release group megamono must use megamono@{version} tags');
}
if (
  JSON.stringify(entryGroup?.projects) !==
    JSON.stringify(['create-megamono']) ||
  entryGroup?.projectsRelationship !== 'independent' ||
  entryGroup?.releaseTag?.pattern !== 'create-megamono@{version}'
) {
  failures.push(
    'Nx release group create-megamono must remain an independently tagged entry package',
  );
}

for (const [name, relativePath] of privatePackages) {
  const manifest = JSON.parse(await readFile(join(root, relativePath), 'utf8'));
  const fail = (message) => failures.push(`${name}: ${message}`);

  if (manifest.name !== name) fail(`manifest name must be ${name}`);
  if (manifest.private) fail('private prevents registry publication');
  if (manifest.repository?.url !== expectedRepository) {
    fail('repository must link megamono-dev/megamono');
  }
  if (manifest.publishConfig?.registry !== expectedRegistry) {
    fail(`publish registry must be ${expectedRegistry}`);
  }
  if (manifest.publishConfig?.access !== 'restricted') {
    fail('publish access must be restricted');
  }
}

const entryManifest = JSON.parse(
  await readFile(join(root, 'packages/create-megamono/package.json'), 'utf8'),
);
if (entryManifest.publishConfig) {
  failures.push(
    'create-megamono: unscoped entry package must remain outside the private release channel',
  );
}

if (failures.length > 0) {
  console.error(`Private publish policy failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('Private publish policy passed for 5 scoped @megamono packages.');
