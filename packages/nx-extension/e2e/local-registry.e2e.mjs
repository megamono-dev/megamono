import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '../../..');
const compatibility = JSON.parse(
  await readFile(
    resolve(workspaceRoot, 'packages/plugin/compatibility.json'),
    'utf8',
  ),
);
const fixtureTypeScript =
  process.env.MEGAMONO_EXTENSION_TEST_TYPESCRIPT ??
  compatibility.scaffoldPackages.typescript;

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
      server.close((error) => {
        if (error) reject(error);
        else resolvePromise(address.port);
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const temporaryRoot = await mkdtemp(
  join(tmpdir(), 'megamono-nx-extension-registry-e2e-'),
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
  const environment = {
    NX_DAEMON: 'false',
    NX_ISOLATE_PLUGINS: 'false',
    npm_config_cache: npmCache,
    npm_config_userconfig: npmConfig,
  };
  await run(
    'npm',
    [
      'publish',
      './packages/nx-extension',
      '--registry',
      registry,
      '--access',
      'public',
      '--provenance=false',
    ],
    { env: environment },
  );
  await writeFile(
    resolve(fixtureRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: '@fixture/workspace',
        version: '0.0.0',
        private: true,
        workspaces: ['apps/*'],
        devDependencies: {
          '@megamono/nx-extension': '0.0.1',
          '@nx/devkit': compatibility.scaffoldPackages['create-nx-workspace'],
          nx: compatibility.scaffoldPackages['create-nx-workspace'],
          typescript: fixtureTypeScript,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    resolve(fixtureRoot, 'nx.json'),
    `${JSON.stringify({ plugins: ['@megamono/nx-extension'] }, null, 2)}\n`,
    'utf8',
  );
  await run('npm', ['install', '--audit=false', '--fund=false'], {
    cwd: fixtureRoot,
    env: environment,
  });
  await run(
    'npm',
    [
      'exec',
      'nx',
      '--',
      'generate',
      '@megamono/nx-extension:application',
      'browser',
      '--scope=fixture',
      '--directory=apps/browser',
      '--displayName=Fixture Browser',
      '--manifestVersion=3',
      '--skipFormat',
      '--interactive=false',
    ],
    { cwd: fixtureRoot, env: environment },
  );

  const show = await run(
    'npm',
    ['exec', 'nx', '--', 'show', 'project', 'fixture-browser', '--json'],
    { cwd: fixtureRoot, env: environment },
  );
  const project = JSON.parse(show.stdout);
  assert(project.root === 'apps/browser', 'Generated extension root is wrong.');
  assert(project.targets['build-chrome'], 'Chrome build target is missing.');
  assert(project.targets['build-firefox'], 'Firefox build target is missing.');
  assert(
    project.targets['package-firefox-source'],
    'Firefox source-package target is missing.',
  );
  assert(!project.targets.deploy, 'Deploy target must require store commands.');
  assert(
    project.metadata?.['megamono:extension']?.safari ===
      'separate-apple-project',
    'Safari boundary metadata is missing.',
  );
  const generatedManifest = JSON.parse(
    await readFile(resolve(fixtureRoot, 'apps/browser/package.json'), 'utf8'),
  );
  assert(
    generatedManifest.devDependencies.wxt === '0.21.4',
    'Generated extension did not pin the supported WXT version.',
  );
  assert(
    generatedManifest.devDependencies.typescript === fixtureTypeScript,
    'Repository TypeScript selection was not preserved.',
  );
  assert(
    generatedManifest.devDependencies.vite === '8.2.2' &&
      generatedManifest.devDependencies.esbuild === '0.28.2',
    'Qualified app-local peers were not declared.',
  );
  const installedPlugin = JSON.parse(
    await readFile(
      resolve(fixtureRoot, 'node_modules/@megamono/nx-extension/package.json'),
      'utf8',
    ),
  );
  assert(
    installedPlugin.version === '0.0.1',
    'Fixture did not install the published extension plugin.',
  );
  // Remove generated browser targets so this build exercises inference rather
  // than project.json overrides. WXT must find the app-local configuration.
  const projectPath = resolve(fixtureRoot, 'apps/browser/project.json');
  const authored = JSON.parse(await readFile(projectPath, 'utf8'));
  for (const target of [
    'prepare',
    'typecheck',
    'build',
    'build-chrome',
    'build-firefox',
    'package',
    'package-chrome',
    'package-firefox',
    'package-firefox-source',
  ])
    delete authored.targets[target];
  await writeFile(projectPath, JSON.stringify(authored));
  await run(
    'npm',
    [
      'exec',
      'nx',
      '--',
      'run-many',
      '-p',
      'fixture-browser',
      '-t',
      'build,package,typecheck',
      '--parallel=8',
    ],
    { cwd: fixtureRoot, env: environment },
  );
  for (const browser of ['chrome', 'firefox']) {
    const manifest = JSON.parse(
      await readFile(
        resolve(
          fixtureRoot,
          `apps/browser/.output/${browser}-mv3/manifest.json`,
        ),
        'utf8',
      ),
    );
    assert(
      manifest.manifest_version === 3,
      `${browser} did not build MV3 through the inferred target`,
    );
    assert(
      manifest.name === 'Fixture Browser',
      `${browser} lost its product display name`,
    );
    assert(
      !manifest.content_scripts?.length &&
        !manifest.host_permissions?.length &&
        !manifest.permissions?.length,
      `${browser} default scaffold unexpectedly requests access`,
    );
  }
  await rm(resolve(fixtureRoot, 'apps/browser/.wxt'), {
    recursive: true,
    force: true,
  });
  await run('npm', ['exec', 'nx', '--', 'run', 'fixture-browser:typecheck'], {
    cwd: fixtureRoot,
    env: environment,
  });
  await readFile(
    resolve(fixtureRoot, 'apps/browser/.wxt/tsconfig.json'),
    'utf8',
  );
  succeeded = true;
  process.stdout.write(
    `nx-extension local-registry e2e passed (TypeScript ${fixtureTypeScript}): published generator, peer verification, parallel-requested serial builds/packages, typechecking after .wxt deletion, least privilege, display name, and Safari boundary verified.\n`,
  );
} finally {
  verdaccio.kill('SIGTERM');
  await new Promise((resolvePromise) => {
    if (verdaccio.exitCode !== null) resolvePromise();
    else verdaccio.once('exit', resolvePromise);
  });
  if (succeeded) await rm(temporaryRoot, { recursive: true, force: true });
  else {
    process.stderr.write(
      `Retained failed e2e workspace for inspection: ${temporaryRoot}\n`,
    );
  }
}
