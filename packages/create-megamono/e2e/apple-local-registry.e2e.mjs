import { packageVersion } from '../../../tools/package-version.mjs';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
    if (child.exitCode !== null)
      throw new Error(`Verdaccio exited before startup.\n${log()}`);
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
  join(tmpdir(), 'megamono-create-apple-registry-e2e-'),
);
const npmCache = resolve(temporaryRoot, 'npm-cache');
const npmConfig = resolve(temporaryRoot, 'npmrc');
const registryConfig = resolve(temporaryRoot, 'verdaccio.json');
const swiftCache = resolve(temporaryRoot, 'swift-module-cache');
const destination = resolve(temporaryRoot, 'acme-tools');
const port = await availablePort();
const registry = `http://127.0.0.1:${port}`;

await mkdir(swiftCache, { recursive: true });
await writeFile(
  npmConfig,
  `registry=${registry}\n//127.0.0.1:${port}/:_authToken=local-e2e-token\n`,
  'utf8',
);
await writeFile(
  registryConfig,
  `${JSON.stringify(
    {
      storage: resolve(temporaryRoot, 'registry-storage'),
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
  { cwd: workspaceRoot, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
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
    CLANG_MODULE_CACHE_PATH: swiftCache,
    CODE_SIGNING_ALLOWED: 'NO',
    NX_DAEMON: 'false',
    SWIFTPM_MODULECACHE_OVERRIDE: swiftCache,
    npm_config_cache: npmCache,
    npm_config_userconfig: npmConfig,
  };

  for (const packagePath of [
    './packages/plugin',
    './packages/nx-apple',
    './packages/cli',
    './packages/create-megamono',
  ]) {
    await run(
      'npm',
      [
        'publish',
        packagePath,
        '--registry',
        registry,
        '--access',
        'public',
        '--provenance=false',
        '--tag=latest',
      ],
      { env: environment },
    );
  }

  const created = await run(
    'npm',
    [
      'exec',
      '--yes',
      `create-megamono@${await packageVersion('create-megamono')}`,
      '--',
      'Acme Tools',
      '--directory=acme-tools',
      '--apps=apple',
      '--interactive=false',
      '--verify=build',
    ],
    { cwd: temporaryRoot, env: environment },
  );
  assert(
    created.stdout.includes('@megamono/nx-apple:application'),
    'Packed CLI did not execute the Apple generator step.',
  );

  const project = JSON.parse(
    (
      await run(
        'npm',
        ['exec', 'nx', '--', 'show', 'project', 'acme-tools-apple', '--json'],
        { cwd: destination, env: environment },
      )
    ).stdout,
  );
  assert(project.root === 'apps/apple', 'Created Apple project root is wrong.');
  assert(project.targets.build, 'Created Apple build target is missing.');
  assert(project.targets.test, 'Created Apple test target is missing.');
  assert(project.targets.archive, 'Created Apple archive target is missing.');
  assert(
    project.tags.includes('platform:apple'),
    'Created Apple platform tag is missing.',
  );

  const megamono = JSON.parse(
    await readFile(resolve(destination, 'megamono.json'), 'utf8'),
  );
  assert(
    JSON.stringify(megamono.platforms) === JSON.stringify(['apple']),
    'Created workspace platform metadata is wrong.',
  );
  const pbx = await readFile(
    resolve(
      destination,
      'apps/apple/acme-tools-apple.xcodeproj/project.pbxproj',
    ),
    'utf8',
  );
  assert(
    pbx.includes('PRODUCT_BUNDLE_IDENTIFIER = com.acme-tools.apple;'),
    'Created Apple bundle identifier is wrong.',
  );
  assert(
    await readFile(
      resolve(
        destination,
        '.nx/apple/acme-tools-apple/Build/Products/Debug/acme-tools-apple.app/Contents/Info.plist',
      ),
      'utf8',
    ),
    'create-megamono build verification did not produce the Apple app.',
  );

  succeeded = true;
  process.stdout.write(
    'create-megamono Apple local-registry e2e passed: packed CLI staged, verified, and committed a build-ready native app.\n',
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
