#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const publishedPackages = new Map([
  ['@megamono/cli', 'packages/cli'],
  ['@megamono/plugin', 'packages/plugin'],
  ['@megamono/nx-apple', 'packages/nx-apple'],
  ['@megamono/nx-cargo', 'packages/nx-cargo'],
  ['@megamono/nx-cloudflare', 'packages/nx-cloudflare'],
  ['create-megamono', 'packages/create-megamono'],
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
const scopedGroup = nx.release?.groups?.megamono;
const entryGroup = nx.release?.groups?.['create-megamono'];
const configuredProjects = scopedGroup?.projects ?? [];

if (JSON.stringify(configuredProjects) !== JSON.stringify(expectedProjects)) {
  failures.push(
    `Nx release group megamono must contain ${expectedProjects.join(', ')}`,
  );
}
if (scopedGroup?.projectsRelationship !== 'fixed') {
  failures.push('Nx release group megamono must have a fixed relationship');
}
if (scopedGroup?.releaseTag?.pattern !== 'megamono@{version}') {
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

for (const [name, directory] of publishedPackages) {
  const manifest = JSON.parse(
    await readFile(join(root, directory, 'package.json'), 'utf8'),
  );
  const fail = (message) => failures.push(`${name}: ${message}`);

  if (manifest.name !== name) fail(`manifest name must be ${name}`);
  if (manifest.private) fail('private prevents registry publication');
  if (manifest.license !== 'MIT') fail('license must be MIT');
  if (manifest.repository?.url !== expectedRepository) {
    fail('repository must link megamono-dev/megamono');
  }
  if (manifest.repository?.directory !== directory) {
    fail(`repository directory must be ${directory}`);
  }
  if (manifest.publishConfig?.registry !== expectedRegistry) {
    fail(`publish registry must be ${expectedRegistry}`);
  }
  // Scoped packages default to restricted on npm, so public access has to be
  // declared rather than assumed.
  if (manifest.publishConfig?.access !== 'public') {
    fail('publish access must be public');
  }
  for (const field of ['description', 'homepage', 'author']) {
    if (!manifest[field]) fail(`${field} is required for the npm listing`);
  }
  if (!manifest.bugs?.url) fail('bugs.url is required for the npm listing');
  if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0) {
    fail('keywords are required for npm discoverability');
  }
  // npm always ships LICENSE and README from the package directory, but only
  // if they exist there — a monorepo root copy does not reach the tarball.
  for (const file of ['LICENSE', 'README.md']) {
    try {
      await readFile(join(root, directory, file), 'utf8');
    } catch {
      fail(`${file} is missing from ${directory}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Publish policy failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(
  `Publish policy passed for ${publishedPackages.size} public Megamono packages.`,
);
