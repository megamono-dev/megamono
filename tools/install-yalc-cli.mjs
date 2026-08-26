#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const yalc = process.platform === 'win32' ? 'yalc.cmd' : 'yalc';
const executable =
  process.platform === 'win32' ? 'create-megamono.cmd' : 'create-megamono';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, NX_DAEMON: 'false' },
      shell: false,
      stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let output = '';
    if (options.capture) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
    }
    child.once('error', (error) => {
      reject(new Error(`Unable to run ${command}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(output.trim());
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

let packDirectory;
try {
  await run(process.execPath, [join(root, 'tools/publish-yalc.mjs')]);

  const packageJson = JSON.parse(
    await readFile(join(root, 'packages/create-megamono/package.json'), 'utf8'),
  );
  const yalcDirectory = await run(yalc, ['dir'], { capture: true });
  const packageDirectory = join(
    yalcDirectory,
    'packages',
    packageJson.name,
    packageJson.version,
  );
  await access(join(packageDirectory, 'package.json'));

  packDirectory = await mkdtemp(join(tmpdir(), 'create-megamono-global-'));
  const packResult = JSON.parse(
    await run(
      npm,
      ['pack', packageDirectory, '--pack-destination', packDirectory, '--json'],
      { capture: true },
    ),
  );
  const tarball = join(packDirectory, packResult[0].filename);
  await run(npm, ['install', '--global', tarball]);

  const globalPrefix = await run(npm, ['prefix', '--global'], {
    capture: true,
  });
  const executablePath = join(
    globalPrefix,
    process.platform === 'win32' ? '' : 'bin',
    executable,
  );
  await run(executablePath, [
    'global-install-check',
    '--apps=web',
    '--interactive=false',
    '--verify=none',
    '--dry-run',
  ]);

  process.stdout.write(
    `\nInstalled create-megamono@${packageJson.version} globally from the yalc artifact.\n`,
  );
  process.stdout.write('Run create-megamono <name> to create a workspace.\n');
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (packDirectory) {
    await rm(packDirectory, { recursive: true, force: true });
  }
}
