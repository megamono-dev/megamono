import { packageVersion } from '../../../tools/package-version.mjs';
import { spawn } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
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

function availablePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        return reject(new Error('Unable to allocate a registry port.'));
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
  throw new Error(`Timed out waiting for ${registry}.\n${log()}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function applicationContract(root, environment) {
  const project = JSON.parse(
    (
      await run(
        'npm',
        ['exec', 'nx', '--', 'show', 'project', 'fixture-web', '--json'],
        { cwd: root, env: environment },
      )
    ).stdout,
  );
  const app = JSON.parse(
    await readFile(resolve(root, 'apps/web/package.json'), 'utf8'),
  );
  const e2e = JSON.parse(
    await readFile(resolve(root, 'apps/web-e2e/package.json'), 'utf8'),
  );
  const theme = JSON.parse(
    await readFile(resolve(root, 'packages/theme/package.json'), 'utf8'),
  );
  const config = JSON.parse(
    await readFile(resolve(root, 'megamono.json'), 'utf8'),
  );
  return {
    project: {
      root: project.root,
      projectType: project.projectType,
      tags: [...project.tags].sort(),
      targets: Object.keys(project.targets ?? {}).sort(),
    },
    app: { name: app.name, dependencies: app.dependencies, nx: app.nx },
    e2e: { name: e2e.name, nx: e2e.nx },
    theme: {
      name: theme.name,
      dependencies: theme.dependencies,
      private: theme.private,
    },
    ports: config.ports,
    appShell: await readFile(
      resolve(root, 'apps/web/src/pages/_app.tsx'),
      'utf8',
    ),
    billboard: await readFile(
      resolve(root, 'apps/web/src/pages/index.tsx'),
      'utf8',
    ),
    browserTest: await readFile(
      resolve(root, 'apps/web-e2e/src/example.spec.ts'),
      'utf8',
    ),
    playwright: await readFile(
      resolve(root, 'apps/web-e2e/playwright.config.mts'),
      'utf8',
    ),
    themeSystem: await readFile(
      resolve(root, 'packages/theme/src/lib/system.ts'),
      'utf8',
    ),
  };
}

async function databaseContract(root, environment) {
  const project = JSON.parse(
    (
      await run(
        'npm',
        [
          'exec',
          'nx',
          '--',
          'show',
          'project',
          'fixture-database-events',
          '--json',
        ],
        { cwd: root, env: environment },
      )
    ).stdout,
  );
  const manifest = JSON.parse(
    await readFile(
      resolve(root, 'packages/database-events/package.json'),
      'utf8',
    ),
  );
  const megamono = JSON.parse(
    await readFile(resolve(root, 'megamono.json'), 'utf8'),
  );
  const playstack = JSON.parse(
    await readFile(resolve(root, 'playstack.json'), 'utf8'),
  );
  return {
    project: {
      root: project.root,
      projectType: project.projectType,
      tags: [...project.tags].sort(),
      targets: project.targets,
    },
    manifest,
    megamono: megamono.databases.events,
    playstack: playstack.databases.events,
    drizzleConfig: await readFile(
      resolve(root, 'packages/database-events/drizzle.config.ts'),
      'utf8',
    ),
    schema: await readFile(
      resolve(root, 'packages/database-events/src/schema/index.ts'),
      'utf8',
    ),
  };
}

const temporaryRoot = await mkdtemp(
  join(tmpdir(), 'megamono-add-equivalence-e2e-'),
);
const npmConfig = resolve(temporaryRoot, 'npmrc');
const registryConfig = resolve(temporaryRoot, 'verdaccio.json');
const npmCache = resolve(temporaryRoot, 'npm-cache');
const port = await availablePort();
const registry = `http://127.0.0.1:${port}`;

await writeFile(
  npmConfig,
  `registry=${registry}\n//127.0.0.1:${port}/:_authToken=local-e2e-token\n`,
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
verdaccio.stdout.on('data', (chunk) => (registryLog += chunk));
verdaccio.stderr.on('data', (chunk) => (registryLog += chunk));

let succeeded = false;
try {
  await waitForRegistry(registry, verdaccio, () => registryLog);
  const environment = {
    NX_DAEMON: 'false',
    npm_config_cache: npmCache,
    npm_config_userconfig: npmConfig,
  };
  for (const packagePath of [
    './packages/plugin',
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

  const launcher = resolve(temporaryRoot, 'launcher');
  await mkdir(launcher);
  await writeFile(
    resolve(launcher, 'package.json'),
    '{"name":"megamono-equivalence-launcher","private":true}\n',
  );
  await run(
    'npm',
    [
      'install',
      '--save-exact',
      `create-megamono@${await packageVersion('create-megamono')}`,
    ],
    {
      cwd: launcher,
      env: environment,
    },
  );
  const createCli = resolve(
    launcher,
    'node_modules/create-megamono/dist/cli.js',
  );
  assert(await exists(createCli), 'Packed create-megamono CLI is missing.');

  const createdRoot = resolve(temporaryRoot, 'created');
  await run(
    process.execPath,
    [
      createCli,
      'Fixture',
      '--directory=created',
      '--apps=web',
      '--package-manager=npm',
      '--database-adapter=drizzle',
      '--database-name=events',
      '--interactive=false',
      '--verify=config',
    ],
    { cwd: temporaryRoot, env: environment },
  );

  await run(
    'npm',
    [
      'exec',
      '--yes',
      'create-nx-workspace@23.1.1',
      '--',
      'adopted',
      '--preset=ts',
      '--workspaceType=integrated',
      '--packageManager=npm',
      '--interactive=false',
      '--nxCloud=skip',
      '--skipGit',
    ],
    { cwd: temporaryRoot, env: environment },
  );
  const adoptedRoot = resolve(temporaryRoot, 'adopted');
  await run(
    'npm',
    [
      'install',
      '--save-dev',
      '--save-exact',
      `@megamono/plugin@${await packageVersion('@megamono/plugin')}`,
      `@megamono/cli@${await packageVersion('@megamono/cli')}`,
    ],
    { cwd: adoptedRoot, env: environment },
  );
  await run('git', ['init'], { cwd: adoptedRoot, env: environment });
  await run('git', ['config', 'user.email', 'fixture@megamono.dev'], {
    cwd: adoptedRoot,
    env: environment,
  });
  await run('git', ['config', 'user.name', 'Megamono Fixture'], {
    cwd: adoptedRoot,
    env: environment,
  });
  await run('git', ['add', '.'], { cwd: adoptedRoot, env: environment });
  await run('git', ['commit', '-m', 'chore: create fixture'], {
    cwd: adoptedRoot,
    env: environment,
  });
  await run('git', ['branch', '-M', 'main'], {
    cwd: adoptedRoot,
    env: environment,
  });
  const origin = resolve(temporaryRoot, 'adopted-origin.git');
  await run('git', ['init', '--bare', origin], { env: environment });
  await run('git', ['remote', 'add', 'origin', origin], {
    cwd: adoptedRoot,
    env: environment,
  });
  await run('git', ['push', '-u', 'origin', 'main'], {
    cwd: adoptedRoot,
    env: environment,
  });
  await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
    cwd: origin,
    env: environment,
  });
  await run('git', ['remote', 'set-head', 'origin', '--auto'], {
    cwd: adoptedRoot,
    env: environment,
  });
  await run('git', ['checkout', '-b', 'test/megamono-init'], {
    cwd: adoptedRoot,
    env: environment,
  });
  const megamonoCli = resolve(
    adoptedRoot,
    'node_modules/@megamono/cli/dist/bin.js',
  );
  await run(
    process.execPath,
    [
      megamonoCli,
      'init',
      '--defaultScope=fixture',
      '--only=docs,agents,ci,release,lint,skills,health,inference',
      '--yes',
      '--interactive=false',
    ],
    { cwd: adoptedRoot, env: environment },
  );
  await run('git', ['add', '.'], { cwd: adoptedRoot, env: environment });
  await run('git', ['commit', '-m', 'chore: initialize megamono'], {
    cwd: adoptedRoot,
    env: environment,
  });

  const beforePreview = (
    await run('git', ['status', '--porcelain'], {
      cwd: adoptedRoot,
      env: environment,
    })
  ).stdout;
  await run(
    process.execPath,
    [
      megamonoCli,
      'add',
      'app',
      'web',
      '--scope=fixture',
      '--workspaceName=Fixture',
      '--dry-run',
    ],
    { cwd: adoptedRoot, env: environment },
  );
  const afterPreview = (
    await run('git', ['status', '--porcelain'], {
      cwd: adoptedRoot,
      env: environment,
    })
  ).stdout;
  assert(
    beforePreview === afterPreview,
    'Packed app dry-run mutated the workspace.',
  );

  await run(
    process.execPath,
    [
      megamonoCli,
      'add',
      'app',
      'web',
      '--scope=fixture',
      '--workspaceName=Fixture',
      '--interactive=false',
      '--yes',
    ],
    { cwd: adoptedRoot, env: environment },
  );
  const beforeDatabasePreview = (
    await run('git', ['status', '--porcelain'], {
      cwd: adoptedRoot,
      env: environment,
    })
  ).stdout;
  await run(
    process.execPath,
    [
      megamonoCli,
      'add',
      'database',
      'events',
      '--adapter=drizzle',
      '--scope=fixture',
      '--dry-run',
    ],
    { cwd: adoptedRoot, env: environment },
  );
  const afterDatabasePreview = (
    await run('git', ['status', '--porcelain'], {
      cwd: adoptedRoot,
      env: environment,
    })
  ).stdout;
  assert(
    beforeDatabasePreview === afterDatabasePreview,
    'Packed database dry-run mutated the workspace.',
  );
  await run(
    process.execPath,
    [
      megamonoCli,
      'add',
      'database',
      'events',
      '--adapter=drizzle',
      '--scope=fixture',
      '--interactive=false',
      '--yes',
    ],
    { cwd: adoptedRoot, env: environment },
  );
  const createdContract = await applicationContract(createdRoot, environment);
  const adoptedContract = await applicationContract(adoptedRoot, environment);
  assert(
    JSON.stringify(adoptedContract) === JSON.stringify(createdContract),
    'create-megamono and megamono add app web emitted different contracts.',
  );
  const createdDatabaseContract = await databaseContract(
    createdRoot,
    environment,
  );
  const adoptedDatabaseContract = await databaseContract(
    adoptedRoot,
    environment,
  );
  assert(
    JSON.stringify(adoptedDatabaseContract) ===
      JSON.stringify(createdDatabaseContract),
    'create-megamono and megamono add database emitted different contracts.',
  );
  for (const root of [createdRoot, adoptedRoot]) {
    await run(
      'npm',
      [
        'exec',
        'nx',
        '--',
        'run',
        'fixture-database-events:validate',
        '--output-style=static',
      ],
      { cwd: root, env: environment },
    );
  }

  await run(
    process.execPath,
    [
      megamonoCli,
      'add',
      'app',
      'web',
      '--name=admin',
      '--scope=fixture',
      '--workspaceName=Fixture',
      '--interactive=false',
      '--yes',
    ],
    { cwd: adoptedRoot, env: environment },
  );
  const config = JSON.parse(
    await readFile(resolve(adoptedRoot, 'megamono.json'), 'utf8'),
  );
  assert(
    config.ports.web === 45451 && config.ports.admin === 45461,
    'Named app port allocation did not preserve the existing assignment.',
  );

  succeeded = true;
  process.stdout.write(
    'Packed create/add equivalence passed: dry-run, shared app and database contracts, and named-instance allocation.\n',
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
      `Retained failed packed equivalence fixture: ${temporaryRoot}\n`,
    );
}
