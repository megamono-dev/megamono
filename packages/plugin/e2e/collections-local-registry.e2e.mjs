import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
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

function runResult(command, args, options = {}) {
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
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

async function run(command, args, options = {}) {
  const result = await runResult(command, args, options);
  if (result.code === 0) return result;
  throw new Error(
    [
      `${command} ${args.join(' ')} exited ${
        result.code === null
          ? `after signal ${result.signal ?? 'unknown'}`
          : result.code
      }`,
      result.stdout.trim(),
      result.stderr.trim(),
    ]
      .filter(Boolean)
      .join('\n'),
  );
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

function sorted(value) {
  return [...value].sort((left, right) => left.localeCompare(right));
}

function assertSameNames(actual, expected, label) {
  const actualNames = sorted(Object.keys(actual));
  const expectedNames = sorted(expected);
  assert(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    `${label} mismatch. Expected ${expectedNames.join(', ')}; received ${actualNames.join(', ')}.`,
  );
}

function assertDescriptorMatches(name, collectionEntry, availabilityEntry) {
  for (const field of ['description', 'schema']) {
    assert(
      collectionEntry[field] === availabilityEntry[field],
      `${name} ${field} differs between its collection and availability registry.`,
    );
  }
  const implementationField =
    'factory' in availabilityEntry ? 'factory' : 'implementation';
  assert(
    collectionEntry[implementationField] ===
      availabilityEntry[implementationField],
    `${name} ${implementationField} differs between its collection and availability registry.`,
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function verifyInstalledCollections(fixtureRoot, environment) {
  const fixtureRequire = createRequire(
    resolve(fixtureRoot, '.megamono-collection-resolution.cjs'),
  );
  const packageJsonPath = fixtureRequire.resolve(
    '@megamono/plugin/package.json',
  );
  const packageRoot = dirname(packageJsonPath);
  const packageJson = await readJson(packageJsonPath);
  assert(
    packageJson.version === compatibility.scaffoldPackages['@megamono/plugin'],
    `Fixture installed @megamono/plugin ${packageJson.version} instead of ${compatibility.scaffoldPackages['@megamono/plugin']}.`,
  );

  const availability = await readJson(resolve(packageRoot, 'availability.json'));
  const generators = (await readJson(resolve(packageRoot, 'generators.json')))
    .generators;
  const executors = (await readJson(resolve(packageRoot, 'executors.json')))
    .executors;
  const availableGenerators = Object.entries(availability.generators)
    .filter(([, entry]) => entry.status === 'available')
    .map(([name]) => name);
  const unavailableGenerators = Object.entries(availability.generators)
    .filter(([, entry]) => entry.status !== 'available')
    .map(([name]) => name);
  const availableExecutors = Object.entries(availability.executors)
    .filter(([, entry]) => entry.status === 'available')
    .map(([name]) => name);

  assertSameNames(
    generators,
    availableGenerators,
    'Installed generator collection',
  );
  assertSameNames(executors, availableExecutors, 'Installed executor collection');
  for (const name of unavailableGenerators) {
    assert(
      !(name in generators),
      `Unavailable generator ${name} was published in generators.json.`,
    );
  }

  const listed = await run(
    'npm',
    ['exec', 'nx', '--', 'list', '@megamono/plugin', '--json'],
    { cwd: fixtureRoot, env: environment },
  );
  const capabilities = JSON.parse(listed.stdout);
  assertSameNames(
    capabilities.generators,
    availableGenerators,
    'Nx generator discovery',
  );
  assertSameNames(
    capabilities.executors,
    availableExecutors,
    'Nx executor discovery',
  );

  const collections = [
    ['generator', generators, availability.generators, 'factory'],
    ['executor', executors, availability.executors, 'implementation'],
  ];
  for (const [kind, collection, registry, implementationField] of collections) {
    for (const [name, descriptor] of Object.entries(collection)) {
      const availabilityEntry = registry[name];
      assertDescriptorMatches(name, descriptor, availabilityEntry);
      const implementationPath = resolve(
        packageRoot,
        `${descriptor[implementationField]}.js`,
      );
      const implementation = fixtureRequire(implementationPath);
      assert(
        typeof implementation.default === 'function',
        `Installed ${kind} ${name} does not expose a default function.`,
      );
      const schemaPath = resolve(packageRoot, descriptor.schema);
      const schema = await readJson(schemaPath);
      assert(
        schema && typeof schema === 'object',
        `Installed ${kind} ${name} schema is not a JSON object.`,
      );
    }
  }

  return {
    executors: availableExecutors.length,
    generators: availableGenerators.length,
  };
}

const temporaryRoot = await mkdtemp(
  join(tmpdir(), 'megamono-collections-registry-e2e-'),
);
const fixtureRoot = resolve(temporaryRoot, 'fixture');
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
await writeFile(
  resolve(fixtureRoot, 'package.json'),
  `${JSON.stringify(
    {
      name: 'megamono-collection-resolution-fixture',
      private: true,
      devDependencies: {
        '@megamono/plugin':
          compatibility.scaffoldPackages['@megamono/plugin'],
        nx: compatibility.scaffoldPackages['create-nx-workspace'],
        typescript: compatibility.scaffoldPackages.typescript,
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
);
await writeFile(
  resolve(fixtureRoot, 'nx.json'),
  `${JSON.stringify(
    { $schema: './node_modules/nx/schemas/nx-schema.json', plugins: [] },
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
    FORCE_COLOR: '0',
    NX_DAEMON: 'false',
    npm_config_audit: 'false',
    npm_config_cache: npmCache,
    npm_config_fund: 'false',
    npm_config_userconfig: npmConfig,
  };
  await run(
    'npm',
    [
      'publish',
      './packages/plugin',
      '--registry',
      registry,
      '--access',
      'public',
      '--provenance=false',
      '--tag=latest',
    ],
    { env: environment },
  );
  await run('npm', ['install', '--registry', registry], {
    cwd: fixtureRoot,
    env: environment,
  });
  const verified = await verifyInstalledCollections(fixtureRoot, environment);

  succeeded = true;
  process.stdout.write(
    `plugin collection local-registry e2e passed: ${verified.generators} generators and ${verified.executors} executors discovered and resolved from the installed package.\n`,
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
      `Retained failed collection fixture: ${temporaryRoot}\n`,
    );
}
