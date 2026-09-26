import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const workspace = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(workspace, 'package.json'));
const root = mkdtempSync(join(tmpdir(), "megamono native & space's-"));
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this fixture through npm exec nx.');
const env = { ...process.env, NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false' };
for (const key of Object.keys(env))
  if (
    key.startsWith('NX_') &&
    !['NX_DAEMON', 'NX_ISOLATE_PLUGINS'].includes(key)
  )
    delete env[key];
const run = (file, args, cwd = root) =>
  execFileSync(file, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 8000000,
  });
const npm = (args, cwd = root) => run(process.execPath, [npmCli, ...args], cwd);
const put = (path, value) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(
    join(root, path),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
};
try {
  const [{ filename }] = JSON.parse(
    npm(
      ['pack', '--ignore-scripts', '--json', '--pack-destination', root],
      join(workspace, 'packages/nx-cargo'),
    ),
  );
  put('package.json', {
    private: true,
    workspaces: ['apps/*'],
    dependencies: {
      nx: require('nx/package.json').version,
      '@nx/devkit': require('@nx/devkit/package.json').version,
      '@megamono/nx-cargo': `file:./${filename}`,
    },
  });
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  put('nx.json', {
    plugins: [
      {
        plugin: '@megamono/nx-cargo',
        options: {
          buildTargetName: 'rust-build',
          testTargetName: 'rust-test',
          lintTargetName: 'rust-lint',
          tauriTargetName: 'tauri-build',
          locked: true,
          allTargets: true,
          denyWarnings: true,
        },
      },
    ],
  });
  put('apps/desktop space/package.json', {
    name: 'desktop',
    private: true,
    scripts: { tauri: 'node -e "process.exit(0)"' },
    devDependencies: { '@tauri-apps/cli': '0.0.0' },
  });
  put(
    'apps/desktop space/src-tauri/Cargo.toml',
    '[package]\nname="desktop"\nversion="0.1.0"\nedition="2021"\n',
  );
  put('apps/desktop space/src-tauri/tauri.conf.json', '{}');
  put(
    'apps/desktop space/src-tauri/src/lib.rs',
    '#[test]\nfn works() { assert_eq!(2 + 2, 4); }\n',
  );
  // This checks the local Node launcher, not a real signed Tauri bundle.
  put('apps/desktop space/node_modules/@tauri-apps/cli/package.json', {
    name: '@tauri-apps/cli',
    version: '0.0.0',
    bin: { tauri: 'tauri.cjs' },
  });
  put(
    'apps/desktop space/node_modules/@tauri-apps/cli/tauri.cjs',
    `require('node:fs').writeFileSync('tauri-args.json', JSON.stringify(process.argv.slice(2)));`,
  );
  run('cargo', [
    'generate-lockfile',
    '--manifest-path',
    'apps/desktop space/src-tauri/Cargo.toml',
  ]);
  const nxPackage = join(root, 'node_modules/nx/package.json');
  const nxBin = resolve(
    dirname(nxPackage),
    JSON.parse(readFileSync(nxPackage, 'utf8')).bin.nx,
  );
  const nx = (args) => run(process.execPath, [nxBin, ...args]);
  const project = JSON.parse(nx(['show', 'project', 'desktop', '--json']));
  assert.equal(project.root, 'apps/desktop space');
  assert(project.targets.tauri, 'Existing npm target must remain');
  for (const name of ['rust-build', 'rust-test', 'rust-lint', 'tauri-build']) {
    assert.equal(project.targets[name].cache, false);
    nx(['run', `desktop:${name}`]);
  }
  const names = JSON.parse(nx(['show', 'projects', '--json']));
  assert.equal(names.filter((name) => name === 'desktop').length, 1);
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(root, 'apps/desktop space/tauri-args.json'), 'utf8'),
    ),
    [
      'build',
      '--ci',
      '--',
      '--package',
      'desktop',
      '--target-dir',
      '../../.nx/cargo/desktop',
    ],
  );
  put('apps/desktop space/src-tauri/src/lib.rs', 'fn unused() {}\n');
  assert.throws(
    () => nx(['run', 'desktop:rust-lint']),
    /failed|non-zero|Command failed/,
  );
  console.log(
    `Packed Cargo build/test/strict lint and local Tauri argv passed on ${process.platform}; signed Tauri outputs not qualified.`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
