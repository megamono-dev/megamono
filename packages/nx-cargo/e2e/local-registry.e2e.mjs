import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '../../..');
const compatibility = JSON.parse(
  await readFile(
    resolve(workspaceRoot, 'packages/plugin/compatibility.json'),
    'utf8',
  ),
);

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
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
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

function availablePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a local-registry port.'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolvePromise(port);
      });
    });
  });
}

async function waitForRegistry(registry, child, log) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Verdaccio exited before startup.\n${log()}`);
    }
    try {
      const response = await fetch(registry);
      if (response.ok) return;
    } catch {
      // The registry has not bound its socket yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for Verdaccio at ${registry}.\n${log()}`);
}

async function writeFixture(root) {
  const files = {
    'package.json': `${JSON.stringify(
      {
        name: 'nx-cargo-local-registry-fixture',
        private: true,
        workspaces: ['apps/*'],
        devDependencies: {
          '@megamono/nx-cargo': '0.0.1',
          '@nx/js': compatibility.scaffoldPackages['@nx/js'],
          nx: compatibility.scaffoldPackages['create-nx-workspace'],
          typescript: compatibility.scaffoldPackages.typescript,
        },
      },
      null,
      2,
    )}\n`,
    'nx.json': `${JSON.stringify(
      {
        $schema: './node_modules/nx/schemas/nx-schema.json',
        plugins: [
          {
            plugin: '@nx/js/typescript',
            options: {
              typecheck: { targetName: 'typecheck' },
              build: {
                targetName: 'build',
                configName: 'tsconfig.lib.json',
              },
            },
          },
          {
            plugin: '@megamono/nx-cargo',
            options: {
              scope: 'probe',
              tauriTargetName: 'tauri-build',
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    'Cargo.toml':
      '[workspace]\nmembers = ["apps/desktop/src-tauri", "crates/core"]\nresolver = "2"\n',
    'crates/core/Cargo.toml':
      '[package]\nname = "probe-core"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "src/lib.rs"\n',
    'crates/core/src/lib.rs': 'pub fn answer() -> u8 {\n    42\n}\n',
    'apps/desktop/package.json': `${JSON.stringify(
      {
        name: 'probe-desktop',
        private: true,
        version: '0.1.0',
        type: 'module',
        scripts: { tauri: 'tauri' },
        devDependencies: {
          '@tauri-apps/cli': compatibility.scaffoldPackages['@tauri-apps/cli'],
        },
      },
      null,
      2,
    )}\n`,
    'apps/desktop/tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
    'apps/desktop/src/main.ts': "export const desktop = 'probe';\n",
    'apps/desktop/src-tauri/Cargo.toml':
      '[package]\nname = "probe-desktop"\nversion = "0.1.0"\nedition = "2021"\n\n[[bin]]\nname = "probe-desktop"\npath = "src/main.rs"\n\n[dependencies]\nprobe-core = { path = "../../../crates/core" }\n',
    'apps/desktop/src-tauri/src/main.rs':
      'fn main() {\n    println!("{}", probe_core::answer());\n}\n',
    'apps/desktop/src-tauri/tauri.conf.json': '{}\n',
  };
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = resolve(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const temporaryRoot = await mkdtemp(
  join(tmpdir(), 'megamono-nx-cargo-registry-e2e-'),
);
const fixtureRoot = resolve(temporaryRoot, 'fixture');
const registryStorage = resolve(temporaryRoot, 'registry-storage');
const npmCache = resolve(temporaryRoot, 'npm-cache');
const npmConfig = resolve(temporaryRoot, 'npmrc');
const registryConfig = resolve(temporaryRoot, 'verdaccio.json');
const port = await availablePort();
const registry = `http://127.0.0.1:${port}`;
await mkdir(fixtureRoot, { recursive: true });
await writeFile(
  npmConfig,
  `registry=${registry}\n//127.0.0.1:${port}/:_authToken=local-e2e-token\n`,
  'utf8',
);
await writeFile(
  registryConfig,
  `${JSON.stringify(
    {
      storage: registryStorage,
      uplinks: { npmjs: { url: 'https://registry.npmjs.org/' } },
      packages: {
        '**': {
          access: '$all',
          publish: '$all',
          unpublish: '$all',
          proxy: 'npmjs',
        },
      },
      log: { type: 'stdout', format: 'pretty', level: 'warn' },
      publish: { allow_offline: true },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const verdaccio = spawn(
  process.execPath,
  [
    resolve(workspaceRoot, 'node_modules/verdaccio/bin/verdaccio'),
    '--config',
    registryConfig,
    '--listen',
    `127.0.0.1:${port}`,
  ],
  {
    cwd: workspaceRoot,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let registryLog = '';
verdaccio.stdout.on('data', (chunk) => {
  registryLog += chunk;
});
verdaccio.stderr.on('data', (chunk) => {
  registryLog += chunk;
});

let succeeded = false;
try {
  await waitForRegistry(registry, verdaccio, () => registryLog);
  const npmEnvironment = {
    npm_config_cache: npmCache,
    npm_config_userconfig: npmConfig,
  };
  await run(
    'npm',
    [
      'publish',
      './packages/nx-cargo',
      '--registry',
      registry,
      '--access',
      'public',
      '--provenance=false',
    ],
    { env: npmEnvironment },
  );
  await writeFixture(fixtureRoot);
  await run(
    'npm',
    ['install', '--registry', registry, '--audit=false', '--fund=false'],
    { cwd: fixtureRoot, env: npmEnvironment },
  );

  const nxEnvironment = {
    NX_DAEMON: 'false',
    NX_CACHE_PROJECT_GRAPH: 'false',
  };
  const show = await run(
    'npm',
    ['exec', 'nx', '--', 'show', 'project', 'probe-desktop', '--json'],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  const project = JSON.parse(show.stdout);
  assert(
    project.root === 'apps/desktop',
    'Desktop project root was not lifted.',
  );
  assert(
    project.tags.includes('scope:probe'),
    'Configured scope tag is missing.',
  );
  assert(project.targets.typecheck, 'TypeScript target did not merge.');
  assert(project.targets.build, 'Cargo build target is missing.');
  assert(project.targets.test, 'Cargo test target is missing.');
  assert(project.targets.lint, 'Cargo lint target is missing.');
  assert(project.targets.tauri, 'Tauri npm-script target is missing.');
  assert(project.targets['tauri-build'], 'Tauri build target is missing.');
  assert(
    project.targets['tauri-build'].options.cwd === 'apps/desktop',
    'Tauri build target does not run from the app root.',
  );
  assert(
    project.targets['tauri-build'].options.command.includes(
      "'npm' 'exec' 'tauri' '--' 'build' '--ci'",
    ),
    'Tauri build target does not use the workspace-local npm CLI.',
  );

  await run(
    'npm',
    [
      'exec',
      'nx',
      '--',
      'run-many',
      '-t',
      'build,test,lint',
      '--projects=probe-core,probe-desktop',
      '--output-style=static',
    ],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  await run('npm', ['exec', 'nx', '--', 'graph', '--file=graph.json'], {
    cwd: fixtureRoot,
    env: nxEnvironment,
  });
  const graph = JSON.parse(
    await readFile(resolve(fixtureRoot, 'graph.json'), 'utf8'),
  );
  assert(
    graph.graph.dependencies['probe-desktop']?.some(
      ({ target, type }) => target === 'probe-core' && type === 'static',
    ),
    'Cargo path dependency did not produce a static Nx edge.',
  );
  const affected = await run(
    'npm',
    [
      'exec',
      'nx',
      '--',
      'show',
      'projects',
      '--affected',
      '--files=crates/core/src/lib.rs',
      '--json',
    ],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  assert(
    JSON.stringify(JSON.parse(affected.stdout).sort()) ===
      JSON.stringify(['probe-core', 'probe-desktop']),
    `Unexpected affected projects: ${affected.stdout.trim()}`,
  );
  const installedPlugin = JSON.parse(
    await readFile(
      resolve(fixtureRoot, 'node_modules/@megamono/nx-cargo/package.json'),
      'utf8',
    ),
  );
  assert(
    installedPlugin.version === '0.0.1',
    'Fixture did not install the published Cargo plugin.',
  );
  succeeded = true;
  process.stdout.write(
    'nx-cargo local-registry e2e passed: mixed project, targets, static edge, and affected propagation verified.\n',
  );
} finally {
  verdaccio.kill('SIGTERM');
  await new Promise((resolvePromise) => {
    if (verdaccio.exitCode !== null) resolvePromise();
    else verdaccio.once('exit', resolvePromise);
  });
  if (succeeded) await rm(temporaryRoot, { recursive: true, force: true });
  else
    process.stderr.write(
      `Retained failed e2e workspace for inspection: ${temporaryRoot}\n`,
    );
}
