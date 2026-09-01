#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const yalc = process.platform === 'win32' ? 'yalc.cmd' : 'yalc';
const globalPackages = [
  {
    directory: 'packages/create-megamono',
    executable: 'create-megamono',
    smoke: [
      'global-install-check',
      '--apps=web',
      '--interactive=false',
      '--verify=none',
      '--dry-run',
    ],
  },
  {
    directory: 'packages/cli',
    executable: 'megamono',
    smoke: ['--version'],
  },
];

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

  const yalcDirectory = await run(yalc, ['dir'], { capture: true });
  packDirectory = await mkdtemp(join(tmpdir(), 'megamono-global-clis-'));

  const globalPrefix = await run(npm, ['prefix', '--global'], {
    capture: true,
  });
  const cliManifest = JSON.parse(
    await readFile(join(root, 'packages/cli/package.json'), 'utf8'),
  );
  const hostedPeerRange = cliManifest.peerDependencies?.['@playstack/client-auth'];
  const hostedPeerVersion = hostedPeerRange?.match(
    /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/,
  )?.[0];
  if (hostedPeerVersion) {
    const hostedPeerDirectory = join(
      yalcDirectory,
      'packages',
      '@playstack',
      'client-auth',
      hostedPeerVersion,
    );
    try {
      await access(join(hostedPeerDirectory, 'package.json'));
      const packedPeer = JSON.parse(
        await run(
          npm,
          [
            'pack',
            hostedPeerDirectory,
            '--pack-destination',
            packDirectory,
            '--json',
          ],
          { capture: true },
        ),
      );
      await run(npm, [
        'install',
        '--global',
        join(packDirectory, packedPeer[0].filename),
      ]);
      process.stdout.write(
        `\nInstalled @playstack/client-auth@${hostedPeerVersion} globally for optional hosted commands.\n`,
      );
    } catch {
      process.stdout.write(
        '\n@playstack/client-auth is not published in yalc; core Megamono commands remain available, but hosted auth commands require that optional peer.\n',
      );
    }
  }
  for (const entry of globalPackages) {
    const packageJson = JSON.parse(
      await readFile(join(root, entry.directory, 'package.json'), 'utf8'),
    );
    const packageDirectory = join(
      yalcDirectory,
      'packages',
      ...packageJson.name.split('/'),
      packageJson.version,
    );
    await access(join(packageDirectory, 'package.json'));
    const packResult = JSON.parse(
      await run(
        npm,
        [
          'pack',
          packageDirectory,
          '--pack-destination',
          packDirectory,
          '--json',
        ],
        { capture: true },
      ),
    );
    const tarball = join(packDirectory, packResult[0].filename);
    await run(npm, ['install', '--global', tarball]);
    const executablePath = join(
      globalPrefix,
      process.platform === 'win32' ? '' : 'bin',
      process.platform === 'win32'
        ? `${entry.executable}.cmd`
        : entry.executable,
    );
    await run(executablePath, entry.smoke);
    process.stdout.write(
      `\nInstalled ${packageJson.name}@${packageJson.version} globally from the yalc artifact.\n`,
    );
  }
  process.stdout.write(
    'Run create-megamono <name> for a new workspace or megamono init in an existing Nx workspace.\n',
  );
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
