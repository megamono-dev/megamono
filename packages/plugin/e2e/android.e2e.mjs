import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const workspace = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(workspace, 'package.json'));
const { createTreeWithEmptyWorkspace } = require('@nx/devkit/testing');
const { writeJson } = require('@nx/devkit');
const nxCli = resolve(
  dirname(require.resolve('nx/package.json')),
  require('nx/package.json').bin.nx,
);
const root = mkdtempSync(join(tmpdir(), 'megamono-android-consumer-'));
const env = {
  ...process.env,
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  NX_WORKSPACE_DATA_DIRECTORY: join(root, '.nx-data'),
};
delete env.NX_TASK_HASH;
delete env.NX_TASK_TARGET_PROJECT;
delete env.NX_TASK_TARGET_TARGET;
const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    env,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 16_000_000,
  });
try {
  assert(
    process.env.npm_execpath?.endsWith('npm-cli.js'),
    'Run this fixture through npm exec nx.',
  );
  symlinkSync(
    join(workspace, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const packed = JSON.parse(
    run(process.execPath, [
      process.env.npm_execpath,
      'pack',
      join(workspace, 'packages/plugin'),
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      root,
    ]),
  )[0];
  run('tar', ['-xf', join(root, packed.filename)]);
  const { appGenerator } = require(
    join(root, 'package/dist/generators/app/app.js'),
  );
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    name: 'android-fixture',
    private: true,
    packageManager: 'npm@11.17.0',
  });
  writeJson(tree, 'nx.json', {
    targetDefaults: { build: { cache: true }, test: { cache: true } },
  });
  const options = {
    type: 'android',
    scope: 'fixture',
    directory: 'apps/native reader',
    applicationId: 'com.example.reader',
    displayName: 'Reader',
    bootstrap: true,
    interactive: false,
    yes: true,
    skipInstall: true,
  };
  const before = tree.listChanges();
  await appGenerator(tree, { ...options, dryRun: true });
  assert.deepEqual(tree.listChanges(), before);
  await appGenerator(tree, options);
  for (const change of tree.listChanges()) {
    if (change.type === 'DELETE') continue;
    const file = join(root, change.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, change.content);
    if (change.options?.mode) chmodSync(file, change.options.mode);
  }
  const graph = JSON.parse(
    run(process.execPath, [
      nxCli,
      'show',
      'project',
      'fixture-android',
      '--json',
    ]),
  );
  assert.equal(graph.root, 'apps/native reader');
  assert.equal(graph.targets.build.cache, false);
  assert.equal(graph.targets.build.parallelism, false);
  assert.deepEqual(graph.tags, [
    'platform:android',
    'scope:fixture',
    'type:app',
    'visibility:internal',
  ]);
  console.log(
    'Packed Android generation and resolved Nx graph passed (path with spaces).',
  );
  if (process.env.MEGAMONO_ANDROID_NATIVE_E2E === 'true') {
    console.log(
      'Running actual generated Nx build, JVM test, and Android Lint. No device installation.',
    );
    for (const target of ['build', 'test', 'lint']) {
      console.log(
        run(process.execPath, [nxCli, 'run', `fixture-android:${target}`]),
      );
    }
    const apk = readFileSync(
      join(
        root,
        'apps/native reader/app/build/outputs/apk/debug/app-debug.apk',
      ),
    );
    assert(apk.length > 0);
    console.log(
      `Debug APK generated (${apk.length} bytes). Native macOS/Linux/Windows execution qualification applies only to this host: ${process.platform}.`,
    );
  } else {
    console.log(
      'Native build skipped. Set MEGAMONO_ANDROID_NATIVE_E2E=true with JAVA_HOME and ANDROID_HOME to qualify actual Gradle tasks.',
    );
  }
} catch (error) {
  console.error(error.stdout?.toString(), error.stderr?.toString());
  throw error;
} finally {
  rmSync(root, { recursive: true, force: true });
}
