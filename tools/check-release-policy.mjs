#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const publicPackages = new Map([
  [
    '@megamono/cli',
    { manifest: 'packages/cli/package.json', directory: 'packages/cli' },
  ],
  [
    '@megamono/plugin',
    { manifest: 'packages/plugin/package.json', directory: 'packages/plugin' },
  ],
  [
    '@megamono/nx-apple',
    {
      manifest: 'packages/nx-apple/package.json',
      directory: 'packages/nx-apple',
    },
  ],
  [
    '@megamono/nx-cargo',
    {
      manifest: 'packages/nx-cargo/package.json',
      directory: 'packages/nx-cargo',
    },
  ],
  [
    '@megamono/nx-cloudflare',
    {
      manifest: 'packages/nx-cloudflare/package.json',
      directory: 'packages/nx-cloudflare',
    },
  ],
  [
    '@megamono/nx-extension',
    {
      manifest: 'packages/nx-extension/package.json',
      directory: 'packages/nx-extension',
    },
  ],
  [
    '@megamono/nx-render',
    {
      manifest: 'packages/nx-render/package.json',
      directory: 'packages/nx-render',
    },
  ],
  [
    'create-megamono',
    {
      manifest: 'packages/create-megamono/package.json',
      directory: 'packages/create-megamono',
    },
  ],
  ...['nx-laravel', 'nx-phpnative'].map((name) => [
    `@megamono/${name}`,
    {
      manifest: `packages/${name}/package.json`,
      directory: `packages/${name}`,
    },
  ]),
]);
const expectedProjects = [
  '@megamono/cli',
  '@megamono/plugin',
  'nx-apple',
  'nx-cargo',
  'nx-cloudflare',
  'nx-extension',
  'nx-render',
  'nx-laravel',
  'nx-phpnative',
];
const expectedRepository = 'git+https://github.com/megamono-dev/megamono.git';
const expectedRegistry = 'https://registry.npmjs.org';
const failures = [];

const nx = JSON.parse(await readFile(join(root, 'nx.json'), 'utf8'));
const packageGroup = nx.release?.groups?.megamono;
const entryGroup = nx.release?.groups?.['create-megamono'];
const configuredProjects = packageGroup?.projects ?? [];

if (JSON.stringify(configuredProjects) !== JSON.stringify(expectedProjects)) {
  failures.push(
    `Nx release group megamono must contain ${expectedProjects.join(', ')}`,
  );
}
if (packageGroup?.projectsRelationship !== 'fixed') {
  failures.push('Nx release group megamono must have a fixed relationship');
}
if (packageGroup?.releaseTag?.pattern !== 'megamono@{version}') {
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

for (const [name, definition] of publicPackages) {
  const manifest = JSON.parse(
    await readFile(join(root, definition.manifest), 'utf8'),
  );
  const fail = (message) => failures.push(`${name}: ${message}`);

  if (manifest.name !== name) fail(`manifest name must be ${name}`);
  if (manifest.private) fail('private prevents registry publication');
  if (manifest.license !== 'MIT') fail('license must be MIT');
  for (const field of ['description', 'homepage', 'author']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      fail(`${field} is required for the npm listing`);
    }
  }
  if (typeof manifest.bugs?.url !== 'string' || !manifest.bugs.url.trim()) {
    fail('bugs.url is required for the npm listing');
  }
  if (
    !Array.isArray(manifest.keywords) ||
    manifest.keywords.length === 0 ||
    manifest.keywords.some(
      (keyword) => typeof keyword !== 'string' || !keyword.trim(),
    )
  ) {
    fail('keywords must contain nonempty strings for npm discoverability');
  }
  for (const file of ['LICENSE', 'README.md']) {
    try {
      const content = await readFile(
        join(root, definition.directory, file),
        'utf8',
      );
      if (!content.trim()) fail(`${file} must not be empty`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fail(`${file} is missing from ${definition.directory}`);
    }
  }
  if (manifest.repository?.url !== expectedRepository) {
    fail('repository must link megamono-dev/megamono');
  }
  if (manifest.repository?.directory !== definition.directory) {
    fail(`repository directory must be ${definition.directory}`);
  }
  if (manifest.publishConfig?.registry !== expectedRegistry) {
    fail(`publish registry must be ${expectedRegistry}`);
  }
  if (manifest.publishConfig?.access !== 'public') {
    fail('publish access must be public');
  }
}

if (failures.length > 0) {
  console.error(`Public release policy failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(
  `Public release policy passed for all ${publicPackages.size} Megamono packages.`,
);
