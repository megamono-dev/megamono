import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { runMegamonoCli } from '../dist/lib/cli.js';

const workspace = resolve(import.meta.dirname, '../../..');
const root = await mkdtemp(join(tmpdir(), 'megamono-ephemeral-consumer-'));
const json = async (path, value) => {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};
try {
  await json(join(root, 'package.json'), {
    name: 'survey-consumer',
    private: true,
  });
  await json(join(root, 'nx.json'), { analytics: false });
  await json(join(root, 'apps/api/project.json'), {
    name: 'nested-api',
    projectType: 'application',
    targets: {},
  });
  await mkdir(join(root, 'node_modules'));
  // The consumer has real Nx, but no Megamono dependency or plugin symlink.
  await symlink(
    join(workspace, 'node_modules/nx'),
    join(root, 'node_modules/nx'),
    'dir',
  );
  const before = await readFile(join(root, 'package.json'), 'utf8');
  let output = '';
  let diagnostics = '';
  const result = await runMegamonoCli(['adopt', '--format=json'], {
    cwd: root,
    version: '0.0.1',
    stdout(message) {
      output += message;
    },
    stderr(message) {
      diagnostics += message;
    },
    async runCommand(command, args, options) {
      if (args[0]?.endsWith('/npm/bin/npm-cli.js')) {
        assert.equal(command, process.execPath);
        // Substitute only transport/install. Nx and the built generator execute
        // for real, outside the consumer's module search path.
        await mkdir(join(options.cwd, 'node_modules/@megamono'), {
          recursive: true,
        });
        await symlink(
          join(workspace, 'packages/plugin'),
          join(options.cwd, 'node_modules/@megamono/plugin'),
          'dir',
        );
        return { exitCode: 0 };
      }
      try {
        const stdout = execFileSync(command, args, {
          cwd: options.cwd,
          encoding: 'utf8',
          timeout: 30_000,
          killSignal: 'SIGKILL',
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => !key.startsWith('NX_'),
              ),
            ),
            CI: 'true',
            NX_INTERACTIVE: 'false',
            NX_SKIP_NATIVE_FILE_CACHE: 'true',
            NODE_DISABLE_COMPILE_CACHE: '1',
            NX_WORKSPACE_ROOT_PATH: root,
            NX_CACHE_DIRECTORY: join(root, '.nx/cache'),
            NX_WORKSPACE_DATA_DIRECTORY: join(root, '.nx/workspace-data'),
            NX_DAEMON: 'false',
            NX_ISOLATE_PLUGINS: 'false',
          },
        });
        return { exitCode: 0, stdout };
      } catch (error) {
        output += `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
        throw error;
      }
    },
  });
  assert.equal(result.exitCode, 0, diagnostics);
  assert(JSON.parse(output).projects.some(({ name }) => name === 'nested-api'));
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), before);
  for (const path of [
    'megamono.json',
    'package-lock.json',
    '.yalc',
    'node_modules/@megamono/plugin',
  ]) {
    await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
  }
  console.log(
    'Real Nx ephemeral survey passed without installing Megamono into the consumer.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
