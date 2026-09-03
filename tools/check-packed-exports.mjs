#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheRoot = mkdtempSync(join(tmpdir(), 'megamono-pack-exports-'));
const packageDirectories = [
  'packages/cli',
  'packages/create-megamono',
  'packages/nx-apple',
  'packages/nx-cargo',
  'packages/nx-cloudflare',
  'packages/nx-extension',
  'packages/nx-render',
  'packages/plugin',
];

function localTargets(value) {
  if (typeof value === 'string') return value.startsWith('./') ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(localTargets);
}

function manifestTargets(manifest) {
  return [
    ...localTargets(manifest.exports),
    ...localTargets(manifest.main),
    ...localTargets(manifest.module),
    ...localTargets(manifest.types),
    ...localTargets(manifest.bin),
    ...localTargets(manifest.generators),
    ...localTargets(manifest.executors),
  ];
}

function packedFiles(directory) {
  const result = execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      'pack',
      join(workspaceRoot, directory),
      '--dry-run',
      '--json',
      '--ignore-scripts',
    ],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cacheRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const report = JSON.parse(result)[0];
  if (!report || !Array.isArray(report.files)) {
    throw new Error(`npm pack returned no file inventory for ${directory}.`);
  }
  return new Set(report.files.map(({ path }) => normalize(path)));
}

try {
  const failures = [];
  for (const directory of packageDirectories) {
    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, directory, 'package.json'), 'utf8'),
    );
    const files = packedFiles(directory);
    for (const target of [...new Set(manifestTargets(manifest))].sort()) {
      if (target.includes('*')) continue;
      const path = normalize(target.slice(2));
      if (!files.has(path)) failures.push(`${manifest.name}: ${target}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `Packed package export validation failed:\n- ${failures.join('\n- ')}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Packed package export validation passed for ${packageDirectories.length} Megamono packages.`,
    );
  }
} finally {
  rmSync(cacheRoot, { recursive: true, force: true });
}
