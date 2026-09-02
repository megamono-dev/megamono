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
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 || options.allowFailure) {
        resolvePromise({ code, signal, stdout, stderr });
        return;
      }
      reject(
        new Error(
          [
            `${command} ${args.join(' ')} exited ${code ?? `after signal ${signal ?? 'unknown'}`}`,
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
      server.close((error) =>
        error ? reject(error) : resolvePromise(address.port),
      );
    });
  });
}

async function waitForRegistry(registry, child, log) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Verdaccio exited before startup.\n${log()}`);
    try {
      if ((await fetch(registry)).ok) return;
    } catch {
      // The registry has not bound its socket yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for Verdaccio at ${registry}.\n${log()}`);
}

function workerProject(name, root) {
  return `${JSON.stringify(
    {
      name,
      projectType: 'application',
      sourceRoot: `${root}/src`,
      tags: [
        'platform:worker',
        'scope:probe',
        'type:app',
        'visibility:internal',
      ],
    },
    null,
    2,
  )}\n`;
}

async function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = resolve(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }
}

async function writeFixture(root) {
  await writeFiles(root, {
    'package.json': `${JSON.stringify(
      {
        name: 'nx-cloudflare-local-registry-fixture',
        private: true,
        devDependencies: {
          '@megamono/nx-cloudflare': '0.0.1',
          nx: compatibility.scaffoldPackages['create-nx-workspace'],
          typescript: compatibility.scaffoldPackages.typescript,
          wrangler: compatibility.cloudflare.testedWranglerMinimum,
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
            plugin: '@megamono/nx-cloudflare',
            options: {
              scope: 'probe',
              externalWorkers: ['external-worker'],
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    'tsconfig.base.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
        },
      },
      null,
      2,
    )}\n`,
    'apps/api/project.json': workerProject('probe-api', 'apps/api'),
    'apps/api/src/index.ts':
      "export default { fetch: () => new Response('api') };\n",
    'apps/api/wrangler.jsonc': `{
  // JSONC must remain a first-class project identity.
  "name": "api-worker",
  "main": "src/index.ts",
  "compatibility_date": "${compatibility.cloudflare.compatibilityDate}",
  "compatibility_flags": ["nodejs_compat"],
  "services": [
    { "binding": "BACKEND", "service": "backend-worker" },
    { "binding": "REMOTE", "service": "external-worker" }
  ],
  "durable_objects": { "bindings": [
    { "name": "STATE", "class_name": "State", "script_name": "backend-worker" }
  ] },
  "workflows": [
    { "binding": "FLOW", "name": "flow", "script_name": "backend-worker" }
  ],
  "tail_consumers": [{ "service": "backend-worker" }],
  "d1_databases": [{ "binding": "DB", "database_name": "probe" }],
  "dev": { "port": 8788 },
  "env": { "staging": { "services": [
    { "binding": "ENV_ONLY", "service": "backend-worker" }
  ] } }
}
`,
    'apps/backend/project.json': workerProject('probe-backend', 'apps/backend'),
    'apps/backend/src/index.ts':
      "export default { fetch: () => new Response('backend') };\n",
    'apps/backend/wrangler.toml': `name = "backend-worker"
main = "src/index.ts"
compatibility_date = "${compatibility.cloudflare.compatibilityDate}"
compatibility_flags = ["nodejs_compat"]

[[queues.producers]]
binding = "EVENTS"
queue = "probe-events"
`,
    'apps/producer/project.json': workerProject(
      'probe-producer',
      'apps/producer',
    ),
    'apps/producer/src/index.ts':
      "export default { fetch: () => new Response('producer') };\n",
    'apps/producer/wrangler.json': `${JSON.stringify(
      {
        name: 'producer-worker',
        main: 'src/index.ts',
        compatibility_date: compatibility.cloudflare.compatibilityDate,
        compatibility_flags: ['nodejs_compat'],
        queues: {
          producers: [{ binding: 'EVENTS', queue: 'probe-events' }],
        },
      },
      null,
      2,
    )}\n`,
    'apps/consumer/project.json': workerProject(
      'probe-consumer',
      'apps/consumer',
    ),
    'apps/consumer/src/index.ts':
      "export default { fetch: () => new Response('consumer') };\n",
    'apps/consumer/wrangler.toml': `name = "consumer-worker"
main = "src/index.ts"
compatibility_date = "${compatibility.cloudflare.compatibilityDate}"
compatibility_flags = ["nodejs_compat"]

[[queues.consumers]]
queue = "probe-events"
`,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasStaticEdge(graph, source, target) {
  return graph.graph.dependencies[source]?.some(
    (dependency) =>
      dependency.target === target && dependency.type === 'static',
  );
}

const temporaryRoot = await mkdtemp(
  join(tmpdir(), 'megamono-nx-cloudflare-registry-e2e-'),
);
const fixtureRoot = resolve(temporaryRoot, 'fixture');
const incompatibleRoot = resolve(temporaryRoot, 'incompatible');
const registryStorage = resolve(temporaryRoot, 'registry-storage');
const npmCache = resolve(temporaryRoot, 'npm-cache');
const npmConfig = resolve(temporaryRoot, 'npmrc');
const registryConfig = resolve(temporaryRoot, 'verdaccio.json');
const port = await availablePort();
const registry = `http://127.0.0.1:${port}`;
await mkdir(fixtureRoot, { recursive: true });
await mkdir(incompatibleRoot, { recursive: true });
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
verdaccio.stdout.on('data', (chunk) => (registryLog += chunk));
verdaccio.stderr.on('data', (chunk) => (registryLog += chunk));

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
      './packages/nx-cloudflare',
      '--registry',
      registry,
      '--access',
      'public',
      '--provenance=false',
    ],
    { env: npmEnvironment },
  );

  await writeFile(
    resolve(incompatibleRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'nx-cloudflare-incompatible-wrangler-fixture',
        private: true,
        devDependencies: {
          '@megamono/nx-cloudflare': '0.0.1',
          wrangler: '4.104.0',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const incompatibleInstall = await run(
    'npm',
    ['install', '--registry', registry, '--audit=false', '--fund=false'],
    { cwd: incompatibleRoot, env: npmEnvironment, allowFailure: true },
  );
  assert(
    incompatibleInstall.code !== 0 &&
      `${incompatibleInstall.stdout}\n${incompatibleInstall.stderr}`.includes(
        'ERESOLVE',
      ),
    'Out-of-range Wrangler did not fail the packed package peer gate.',
  );

  await writeFixture(fixtureRoot);
  await run(
    'npm',
    ['install', '--registry', registry, '--audit=false', '--fund=false'],
    { cwd: fixtureRoot, env: npmEnvironment },
  );
  const minimumWrangler = JSON.parse(
    await readFile(resolve(fixtureRoot, 'node_modules/wrangler/package.json')),
  );
  assert(
    minimumWrangler.version === compatibility.cloudflare.testedWranglerMinimum,
    `Fixture did not install Wrangler ${compatibility.cloudflare.testedWranglerMinimum}.`,
  );
  const nxEnvironment = {
    NX_DAEMON: 'false',
    NX_CACHE_PROJECT_GRAPH: 'false',
  };
  const show = await run(
    'npm',
    ['exec', 'nx', '--', 'show', 'project', 'probe-api', '--json'],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  const project = JSON.parse(show.stdout);
  assert(project.targets.dev?.continuous, 'Worker dev must be continuous.');
  assert(project.targets.tail?.continuous, 'Worker tail must be continuous.');
  assert(project.targets.deploy?.cache === false, 'Deploy must not cache.');
  assert(project.targets.typegen?.cache === true, 'Typegen must cache.');
  assert(!project.targets.build, 'Worker inference must not invent build.');
  assert(
    project.targets.deploy.configurations.staging.command.includes(
      "'--env=staging'",
    ),
    'Named environment target configuration is missing.',
  );
  const metadata = project.metadata['megamono:cloudflare'];
  assert(metadata.schemaVersion === 1, 'Vendor metadata is not schema v1.');
  assert(metadata.devPort === 8788, 'Explicit Wrangler dev port is missing.');
  assert(metadata.resources.d1_databases.length === 1, 'D1 metadata missing.');
  assert(
    metadata.externalWorkers.some(({ worker }) => worker === 'external-worker'),
    'Explicit external Worker metadata is missing.',
  );
  await run('npm', ['exec', 'nx', '--', 'run', 'probe-backend:typegen'], {
    cwd: fixtureRoot,
    env: nxEnvironment,
  });

  await run('npm', ['exec', 'nx', '--', 'graph', '--file=graph.json'], {
    cwd: fixtureRoot,
    env: nxEnvironment,
  });
  const graph = JSON.parse(
    await readFile(resolve(fixtureRoot, 'graph.json'), 'utf8'),
  );
  assert(
    hasStaticEdge(graph, 'probe-api', 'probe-backend'),
    'Direct Worker bindings did not produce a static Nx edge.',
  );
  assert(
    hasStaticEdge(graph, 'probe-consumer', 'probe-backend') &&
      hasStaticEdge(graph, 'probe-consumer', 'probe-producer'),
    'Queue fan-in did not produce one static edge per local producer.',
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
      '--files=apps/backend/src/index.ts',
      '--json',
    ],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  const affectedProjects = JSON.parse(affected.stdout);
  assert(
    affectedProjects.includes('probe-api') &&
      affectedProjects.includes('probe-backend') &&
      affectedProjects.includes('probe-consumer'),
    `Worker dependency changes did not propagate through affected: ${affected.stdout.trim()}`,
  );

  const dryRun = await run(
    'npm',
    [
      'exec',
      'nx',
      '--',
      'generate',
      '@megamono/nx-cloudflare:worker',
      'generated',
      '--directory=apps/generated',
      '--scope=probe',
      '--dryRun',
      '--no-interactive',
    ],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  assert(
    dryRun.stdout.includes('@megamono/nx-cloudflare worker plan'),
    'Packed Worker generator did not print its dry-run plan.',
  );
  await run(
    'npm',
    [
      'exec',
      'nx',
      '--',
      'generate',
      '@megamono/nx-cloudflare:worker',
      'generated',
      '--directory=apps/generated',
      '--scope=probe',
      '--no-interactive',
    ],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  await run(
    'npm',
    [
      'exec',
      'nx',
      '--',
      'generate',
      '@megamono/nx-cloudflare:binding',
      '--project=generated',
      '--type=service',
      '--binding=API',
      '--resource=api-worker',
      '--no-interactive',
    ],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  await run(
    'npm',
    [
      'exec',
      'nx',
      '--',
      'generate',
      '@megamono/nx-cloudflare:durable-object',
      'SessionStore',
      '--project=generated',
      '--migrationTag=v1',
      '--no-interactive',
    ],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  const generatedConfig = await readFile(
    resolve(fixtureRoot, 'apps/generated/wrangler.jsonc'),
    'utf8',
  );
  const generatedSource = await readFile(
    resolve(fixtureRoot, 'apps/generated/src/index.ts'),
    'utf8',
  );
  assert(generatedConfig.includes('api-worker'), 'Binding generator failed.');
  assert(
    generatedConfig.includes('SessionStore') &&
      generatedSource.includes('SessionStore'),
    'Durable Object generator failed.',
  );
  await readFile(
    resolve(fixtureRoot, 'apps/generated/worker-configuration.d.ts'),
    'utf8',
  );
  await run('npm', ['exec', 'nx', '--', 'run', 'generated:typegen'], {
    cwd: fixtureRoot,
    env: nxEnvironment,
  });

  const installedManifest = JSON.parse(
    await readFile(
      resolve(fixtureRoot, 'node_modules/@megamono/nx-cloudflare/package.json'),
      'utf8',
    ),
  );
  assert(
    installedManifest.version === '0.0.1',
    'Fixture did not install the published Cloudflare plugin.',
  );
  assert(
    !JSON.stringify(installedManifest).toLowerCase().includes('springbar') &&
      !generatedConfig.toLowerCase().includes('springbar') &&
      !generatedSource.toLowerCase().includes('springbar'),
    'Springbar leaked into the package manifest or generated Worker files.',
  );

  succeeded = true;
  process.stdout.write(
    `nx-cloudflare local-registry e2e passed: Wrangler ${compatibility.cloudflare.testedWranglerMinimum} adoption, peer gate, mixed config inference, targets, metadata, graph, affected propagation, typegen, and generators verified.\n`,
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
