import { spawn } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '../../..');

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspaceRoot,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolvePromise({ stdout, stderr });
      reject(
        new Error(
          [
            `${command} ${args.join(' ')} exited ${
              code === null ? `after signal ${signal ?? 'unknown'}` : code
            }`,
            stdout.trim(),
            stderr.trim(),
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'megamono-cli-playstack-'));
const environment = {
  FORCE_COLOR: '0',
  NX_DAEMON: 'false',
  npm_config_audit: 'false',
  npm_config_cache: resolve(temporaryRoot, 'npm-cache'),
  npm_config_fund: 'false',
};
let succeeded = false;
try {
  const yalcStore = (await run('yalc', ['dir'])).stdout.trim();
  for (const packageName of ['@playstack/cli', '@playstack/auth']) {
    const packageRoot = resolve(
      yalcStore,
      'packages',
      ...packageName.split('/'),
    );
    assert(
      await exists(packageRoot),
      `${packageName} is missing from ${yalcStore}; publish Playstack to yalc before running this fixture.`,
    );
  }

  const packRoot = resolve(temporaryRoot, 'pack');
  await mkdir(packRoot, { recursive: true });
  const packed = JSON.parse(
    (
      await run(
        'npm',
        ['pack', './packages/plugin', '--pack-destination', packRoot, '--json'],
        { env: environment },
      )
    ).stdout,
  );
  const pluginTarball = resolve(packRoot, packed[0].filename);
  const fixtureRoot = resolve(temporaryRoot, 'workspace');
  await json(resolve(fixtureRoot, 'package.json'), {
    name: 'megamono-cli-playstack-yalc-fixture',
    private: true,
    packageManager: 'pnpm@11.24.0',
    devDependencies: {
      '@megamono/plugin': `file:${pluginTarball}`,
      nx: '23.1.1',
      typescript: '6.0.3',
    },
  });
  await json(resolve(fixtureRoot, 'nx.json'), {
    $schema: './node_modules/nx/schemas/nx-schema.json',
  });
  await json(resolve(fixtureRoot, 'tsconfig.base.json'), {
    compilerOptions: { paths: {} },
  });
  await writeFile(
    resolve(fixtureRoot, 'pnpm-workspace.yaml'),
    'packages: []\n\nallowBuilds:\n  argon2: true\n  esbuild: true\n  nx: true\n',
  );
  await writeFile(
    resolve(fixtureRoot, '.gitignore'),
    '.nx\n.yalc\nnode_modules\n',
  );
  await run('pnpm', ['install'], { cwd: fixtureRoot, env: environment });
  await run('git', ['init', '--initial-branch=main'], { cwd: fixtureRoot });
  await run('git', ['config', 'user.email', 'fixture@megamono.dev'], {
    cwd: fixtureRoot,
  });
  await run('git', ['config', 'user.name', 'Megamono Fixture'], {
    cwd: fixtureRoot,
  });
  await run('git', ['add', '.'], { cwd: fixtureRoot });
  await run('git', ['commit', '-m', 'test: initialize fixture'], {
    cwd: fixtureRoot,
  });
  const remoteRoot = resolve(temporaryRoot, 'origin.git');
  await run('git', ['init', '--bare', '--initial-branch=main', remoteRoot]);
  await run('git', ['remote', 'add', 'origin', remoteRoot], {
    cwd: fixtureRoot,
  });
  await run('git', ['push', '--set-upstream', 'origin', 'main'], {
    cwd: fixtureRoot,
  });
  await run('git', ['remote', 'set-head', 'origin', 'main'], {
    cwd: fixtureRoot,
  });
  await run('git', ['switch', '--create', 'test/integration'], {
    cwd: fixtureRoot,
  });
  await run(
    process.execPath,
    [
      resolve(workspaceRoot, 'packages/cli/dist/bin.js'),
      'init',
      '--only=docs',
      '--interactive=false',
      '--yes',
      '--playstack-packages=auth',
      '--local-packages=yalc',
    ],
    { cwd: fixtureRoot, env: environment },
  );

  const manifest = JSON.parse(
    await readFile(resolve(fixtureRoot, 'package.json'), 'utf8'),
  );
  assert(
    manifest.devDependencies['@playstack/cli'] === 'file:.yalc/@playstack/cli',
    'Megamono did not install the real Playstack CLI from yalc.',
  );
  assert(
    manifest.dependencies['@playstack/auth'] === 'file:.yalc/@playstack/auth',
    'Megamono did not delegate auth capability installation to Playstack yalc resolution.',
  );
  assert(
    await exists(resolve(fixtureRoot, 'megamono.json')),
    'Megamono workspace initialization did not complete.',
  );
  assert(
    await exists(resolve(fixtureRoot, 'playstack.json')),
    'Playstack initialization did not complete.',
  );
  succeeded = true;
  process.stdout.write(
    'Megamono CLI Playstack yalc e2e passed: the real Playstack CLI resolved and installed the auth capability.\n',
  );
} finally {
  if (succeeded || process.env.MEGAMONO_E2E_KEEP !== 'true') {
    await rm(temporaryRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`Retained failed fixture: ${temporaryRoot}\n`);
  }
}
