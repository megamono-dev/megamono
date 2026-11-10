import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';

const workspace = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(workspace, 'package.json'));
const { createTreeWithEmptyWorkspace } = require('@nx/devkit/testing');
const { readJson, writeJson } = require('@nx/devkit');
const { appGenerator } = require(
  join(workspace, 'packages/plugin/dist/generators/app/app.js'),
);
const root = mkdtempSync(join(tmpdir(), 'megamono-web-scaffold-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith('NX_') && key !== 'NODE_ENV' && key !== 'NODE_PATH',
  ),
);
Object.assign(env, {
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  NEXT_TELEMETRY_DISABLED: '1',
  CI: 'true',
});
const run = (args, cwd = root) =>
  execFileSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 8_000_000,
  });
let server;
let serverUrl;
let qualified = false;
async function stop() {
  if (!server) return;
  const current = server;
  const exited =
    current.exitCode === null && current.signalCode === null
      ? once(current, 'exit')
      : Promise.resolve();
  const signal = (value) => {
    if (!current.pid) return;
    try {
      process.kill(-current.pid, value);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  // Nx and Next both spawn descendants. Stop only this fixture's process group.
  signal('SIGTERM');
  const timer = setTimeout(() => {
    signal('SIGKILL');
  }, 10000);
  await exited;
  clearTimeout(timer);
  server = undefined;
  if (serverUrl) {
    const address = serverUrl;
    serverUrl = undefined;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        await fetch(address, { signal: AbortSignal.timeout(1000) });
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`Stopped fixture still responds at ${address}`);
  }
}
try {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    ...readJson(tree, 'package.json'),
    name: '@fixture/source',
    packageManager: 'pnpm@11.28.9',
    devDependencies: {
      ...readJson(tree, 'package.json').devDependencies,
      nx: require('nx/package.json').version,
      '@nx/devkit': require('@nx/devkit/package.json').version,
      typescript: require('typescript/package.json').version,
      '@megamono/plugin': 'file:./plugin.tgz',
    },
  });
  tree.write(
    'pnpm-workspace.yaml',
    'packages:\n  - apps/*\n  - packages/*\nautoInstallPeers: false\n',
  );
  writeJson(tree, 'megamono.json', {
    version: 1,
    conventions: { packageManager: 'pnpm', rules: {} },
  });
  await appGenerator(tree, {
    type: 'site',
    scope: 'fixture',
    styling: 'chakra',
    interactive: false,
    yes: true,
    skipInstall: true,
  });
  execFileSync('pnpm', ['pack', '--out', join(root, 'plugin.tgz')], {
    cwd: join(workspace, 'packages/plugin'),
    env,
    stdio: 'pipe',
    timeout: 120000,
  });
  for (const change of tree.listChanges()) {
    if (change.type === 'DELETE') continue;
    const path = join(root, change.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, change.content);
  }
  writeFileSync(
    join(root, '.npmrc'),
    'store-dir=.pnpm-store\ncache-dir=.pnpm-cache\n',
  );
  execFileSync(
    'pnpm',
    ['install', '--ignore-scripts', '--no-frozen-lockfile'],
    { cwd: root, env, stdio: 'pipe', timeout: 240000, maxBuffer: 8_000_000 },
  );
  execFileSync('pnpm', ['install', '--ignore-scripts', '--frozen-lockfile'], {
    cwd: root,
    env,
    stdio: 'pipe',
    timeout: 240000,
    maxBuffer: 8_000_000,
  });
  const consumerRequire = createRequire(join(root, 'package.json'));
  assert(
    realpathSync(consumerRequire.resolve('nx/package.json')).startsWith(
      `${realpathSync(root)}/`,
    ),
    'The consumer must resolve its own installed Nx, without ambient NODE_PATH fallback.',
  );
  const nx = resolve(
    dirname(consumerRequire.resolve('nx/package.json')),
    consumerRequire('nx/package.json').bin.nx,
  );
  const typescript = consumerRequire.resolve('typescript/bin/tsc');
  const hookProbe = join(root, 'apps/site/src/hooks-misuse.tsx');
  writeFileSync(
    hookProbe,
    "import { useState } from 'react';\nexport function Misuse({active}: {active:boolean}) { if (active) useState(0); return null; }\n",
  );
  const eslint = resolve(
    dirname(consumerRequire.resolve('eslint/package.json')),
    consumerRequire('eslint/package.json').bin.eslint,
  );
  assert.throws(
    () => run([eslint, 'src/hooks-misuse.tsx'], join(root, 'apps/site')),
    (error) => /react-hooks\/rules-of-hooks/.test(error.stdout ?? ''),
  );
  rmSync(hookProbe);
  run([typescript, '-p', 'packages/theme/tsconfig.lib.json', '--noEmit']);
  const broken = join(root, 'packages/theme/src/source-error.ts');
  writeFileSync(broken, 'export const sourceError: string = 1;\n');
  assert.throws(
    () =>
      run([typescript, '-p', 'packages/theme/tsconfig.lib.json', '--noEmit']),
    (error) => /TS2322/.test(error.stdout ?? ''),
  );
  rmSync(broken);
  const themeRequire = createRequire(join(root, 'packages/theme/package.json'));
  const appRequire = createRequire(join(root, 'apps/site/package.json'));
  for (const singleton of ['react', '@chakra-ui/react', '@emotion/react'])
    assert.equal(
      themeRequire.resolve(singleton),
      appRequire.resolve(singleton),
    );
  const project = JSON.parse(
    run([nx, 'show', 'project', 'fixture-site', '--json']),
  );
  assert.equal(
    project.targets.build.command ?? project.targets.build.options?.command,
    'next build',
  );
  assert(
    project.targets.lint,
    'The new site must have a resolved lint target.',
  );
  assert.equal(project.targets.serve.options.cwd, 'apps/site');
  run([nx, 'run', 'fixture-site:build', '--output-style=static']);
  for (const nested of [false, true]) {
    let output = '';
    server = spawn(
      process.execPath,
      [
        nx,
        'run',
        nested ? 'fixture-site:serve' : 'fixture-site:start',
        '--hostname=127.0.0.1',
        '--output-style=stream',
      ],
      {
        cwd: nested ? join(root, 'apps/site') : root,
        env: { ...env, PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    server.stdout.on('data', (chunk) => {
      output += chunk;
    });
    server.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const deadline = Date.now() + 90000;
    let response;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(output);
      const port = /http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(
        output,
      )?.[1];
      if (port) {
        serverUrl = `http://127.0.0.1:${port}`;
        try {
          response = await fetch(serverUrl, {
            signal: AbortSignal.timeout(5000),
          });
          if (response.ok) break;
        } catch {
          /* The development server may still be compiling. */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(response?.ok, output);
    assert.match(await response.text(), /ready to build/);
    await stop();
    console.log(
      `Generated Chakra site: inferred targets, injected PORT and ${nested ? 'app-directory' : 'workspace-root'} invocation passed.`,
    );
  }
  qualified = true;
} finally {
  await stop();
  if (qualified) rmSync(root, { recursive: true, force: true });
  else console.error(`Retained failed web scaffold for inspection: ${root}`);
}
