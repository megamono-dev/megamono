#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const yalc = process.platform === 'win32' ? 'yalc.cmd' : 'yalc';
const packages = [
  { project: '@megamono/cli', directory: 'packages/cli' },
  { project: '@megamono/plugin', directory: 'packages/plugin' },
  { project: 'nx-apple', directory: 'packages/nx-apple' },
  { project: 'nx-cargo', directory: 'packages/nx-cargo' },
  { project: 'nx-cloudflare', directory: 'packages/nx-cloudflare' },
  { project: 'nx-extension', directory: 'packages/nx-extension' },
  { project: 'nx-render', directory: 'packages/nx-render' },
  { project: 'create-megamono', directory: 'packages/create-megamono' },
];

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NX_DAEMON: 'false' },
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      reject(new Error(`Unable to run ${command}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} ${code === null ? `stopped after signal ${signal ?? 'unknown'}` : `exited with code ${code}`}`,
        ),
      );
    });
  });
}

try {
  await run(yalc, ['--version']);
  await run(npm, [
    'exec',
    'nx',
    '--',
    'run-many',
    '-t',
    'build',
    '-p',
    ...packages.map(({ project }) => project),
    '--output-style=static',
  ]);
  await run(process.execPath, ['tools/write-build-info.mjs']);
  await run(process.execPath, ['tools/check-packed-exports.mjs']);
  for (const { project, directory } of packages) {
    process.stdout.write(`\nPublishing ${project} to yalc...\n`);
    await run(yalc, ['publish'], join(root, directory));
  }
  process.stdout.write('\nPublished all Megamono packages to yalc.\n');
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
