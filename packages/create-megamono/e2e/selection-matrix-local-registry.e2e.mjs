import { packageVersion } from '../../../tools/package-version.mjs';
import { spawn } from 'node:child_process';
import {
  access,
  chmod,
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
const compatibility = JSON.parse(
  await readFile(
    resolve(workspaceRoot, 'packages/create-megamono/compatibility.json'),
    'utf8',
  ),
);
const appRoots = {
  api: 'apps/api',
  apple: 'apps/apple',
  desktop: 'apps/desktop',
  extension: 'apps/extension',
  mobile: 'apps/mobile',
  site: 'apps/site',
  web: 'apps/web',
  worker: 'apps/worker',
};
const appPlatforms = {
  api: 'node',
  apple: 'apple',
  desktop: 'rust',
  extension: 'extension',
  mobile: 'mobile',
  site: 'web',
  web: 'web',
  worker: 'worker',
};
const allApps = Object.keys(appRoots).sort();
const matrixCases = [
  {
    id: 'packages-pnpm',
    apps: [],
    packages: ['core', 'client'],
    packageManager: 'pnpm',
  },
  { id: 'packages-npm', apps: [], packages: ['core'], packageManager: 'npm' },
  {
    id: 'apps-and-packages',
    apps: ['api'],
    packages: ['client'],
    packageManager: 'pnpm',
  },
  ...allApps.map((app) => ({
    id: app,
    apps: [app],
    packageManager: 'pnpm',
    ...(app === 'api'
      ? { database: { adapter: 'drizzle', name: 'events' } }
      : {}),
  })),
  { id: 'all', apps: allApps, packageManager: 'pnpm' },
  {
    id: 'named-apps',
    apps: [
      'site:marketing',
      'extension:extension-grids',
      'extension:extension-guides',
      'api',
      'web:admin',
      'web',
    ],
    packageManager: 'pnpm',
    positionalApps: true,
  },
  {
    id: 'web-npm',
    apps: ['web'],
    packageManager: 'npm',
    database: { adapter: 'prisma', name: 'primary' },
  },
  {
    id: 'web-no-install',
    apps: ['web'],
    packageManager: 'npm',
    install: false,
  },
  ...['tailwind', 'panda', 'stylex'].map((styling) => ({
    id: `web-${styling}`,
    apps: ['web'],
    packageManager: 'pnpm',
    styling,
  })),
];
const requestedCases = new Set(
  (process.env.MEGAMONO_MATRIX_CASES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const cases = requestedCases.size
  ? matrixCases.filter(({ id }) => requestedCases.has(id))
  : matrixCases;
const verifyMode = process.env.MEGAMONO_MATRIX_VERIFY ?? 'config';
if (cases.length === 0)
  throw new Error(
    `MEGAMONO_MATRIX_CASES did not match: ${matrixCases.map(({ id }) => id).join(', ')}.`,
  );
if (!['config', 'build'].includes(verifyMode))
  throw new Error('MEGAMONO_MATRIX_VERIFY must be config or build.');

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

function parseJsonRecord(output, label) {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Continue past package-manager and sync output that resembles JSON.
    }
  }
  throw new Error(`${label} did not emit a JSON record.\n${output}`);
}

function nxInvocation(packageManager, args) {
  return packageManager === 'pnpm'
    ? { command: 'pnpm', args: ['exec', 'nx', ...args] }
    : { command: 'npm', args: ['exec', 'nx', '--', ...args] };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function appInstance(descriptor) {
  const [type, requestedName] = descriptor.split(':');
  return { type, name: requestedName ?? type };
}

async function verifyCase(root, testCase, environment, createCliPath) {
  const scope = `matrix-${testCase.id}`;
  const destination = resolve(root, scope);
  const staging = resolve(root, `megamono-${scope}-staging`);
  const npmCache = resolve(root, `npm-cache-${testCase.id}`);
  const caseEnvironment = {
    ...environment,
    npm_config_cache: npmCache,
    ...(verifyMode === 'build' ? { NODE_ENV: 'production' } : {}),
  };
  const packageManager = testCase.packageManager;
  process.stdout.write(
    `create-megamono selection matrix: ${testCase.id} (${testCase.apps.join(',')})\n`,
  );
  const created = await run(
    process.execPath,
    [
      createCliPath,
      `Matrix ${testCase.id}`,
      `--directory=${scope}`,
      ...(testCase.positionalApps
        ? testCase.apps
        : [`--apps=${testCase.apps.join(',')}`]),
      ...(testCase.styling ? [`--styling=${testCase.styling}`] : []),
      ...(testCase.packages
        ? [
            `--packages=${testCase.packages.join(',')}`,
            '--package-access=restricted',
          ]
        : []),
      `--package-manager=${packageManager}`,
      ...(testCase.database
        ? [
            `--database-adapter=${testCase.database.adapter}`,
            `--database-name=${testCase.database.name}`,
          ]
        : []),
      `--install=${String(testCase.install ?? true)}`,
      '--interactive=false',
      `--verify=${verifyMode}`,
    ],
    {
      cwd: root,
      env: caseEnvironment,
    },
  );
  assert(
    created.stdout.includes('megamono:check'),
    `${testCase.id}: packed CLI did not execute config verification.`,
  );
  assert(await exists(destination), `${testCase.id}: destination is missing.`);
  assert(
    !(await exists(staging)),
    `${testCase.id}: staging remained after atomic commit.`,
  );
  if (testCase.install === false) {
    assert(
      !(await exists(resolve(destination, 'node_modules'))),
      `${testCase.id}: no-install destination retained node_modules.`,
    );
    const installInvocation =
      packageManager === 'pnpm'
        ? { command: 'pnpm', args: ['install', '--frozen-lockfile'] }
        : { command: 'npm', args: ['ci'] };
    await run(installInvocation.command, installInvocation.args, {
      cwd: destination,
      env: caseEnvironment,
    });
  }

  const megamono = JSON.parse(
    await readFile(resolve(destination, 'megamono.json'), 'utf8'),
  );
  const expectedPlatforms = [
    ...new Set([
      ...(testCase.packages?.length ? ['node'] : []),
      ...testCase.apps.map((app) => appPlatforms[appInstance(app).type]),
    ]),
  ].sort();
  assert(
    JSON.stringify(megamono.platforms) === JSON.stringify(expectedPlatforms),
    `${testCase.id}: expected platforms ${expectedPlatforms.join(',')}, received ${JSON.stringify(megamono.platforms)}.`,
  );
  if (testCase.database) {
    const { adapter, name } = testCase.database;
    const projectName = `${scope}-database-${name}`;
    const expectedRoot = `packages/database-${name}`;
    assert(
      JSON.stringify(megamono.databases?.[name]) ===
        JSON.stringify({ adapter, project: projectName }),
      `${testCase.id}: Megamono database mapping is incorrect.`,
    );
    const playstack = JSON.parse(
      await readFile(resolve(destination, 'playstack.json'), 'utf8'),
    );
    const expectedTarget =
      adapter === 'prisma'
        ? `${expectedRoot}/prisma/models`
        : `${expectedRoot}/src/schema`;
    assert(
      JSON.stringify(playstack.databases?.[name]) ===
        JSON.stringify({
          adapter,
          ...(adapter === 'drizzle' ? { dialect: 'postgresql' } : {}),
          target: expectedTarget,
        }),
      `${testCase.id}: Playstack database target is incorrect.`,
    );
    const showDatabase = nxInvocation(packageManager, [
      'show',
      'project',
      projectName,
      '--json',
    ]);
    const databaseProject = parseJsonRecord(
      (
        await run(showDatabase.command, showDatabase.args, {
          cwd: destination,
          env: caseEnvironment,
        })
      ).stdout,
      `${testCase.id}: database project query`,
    );
    assert(
      databaseProject.root === expectedRoot &&
        databaseProject.tags.includes('type:data') &&
        databaseProject.tags.includes(`database:${adapter}`),
      `${testCase.id}: generated database project does not match its adapter contract.`,
    );
    const validateDatabase = nxInvocation(packageManager, [
      'run',
      `${projectName}:validate`,
      '--output-style=static',
    ]);
    await run(validateDatabase.command, validateDatabase.args, {
      cwd: destination,
      env: caseEnvironment,
    });
  }

  const healthInvocation = nxInvocation(packageManager, [
    'run',
    'megamono-docs:health',
    '--output-style=static',
  ]);
  await run(healthInvocation.command, healthInvocation.args, {
    cwd: destination,
    env: caseEnvironment,
  });
  const health = JSON.parse(
    await readFile(resolve(destination, '.megamono/health.json'), 'utf8'),
  );
  assert(
    health.schemaVersion === 1 && Array.isArray(health.findings),
    `${testCase.id}: packed health executor did not emit a valid report.`,
  );
  assert(
    !health.findings.some(({ fingerprint }) =>
      fingerprint.startsWith('database:'),
    ),
    `${testCase.id}: generated database configuration failed Megamono health.`,
  );
  const packageManifest = JSON.parse(
    await readFile(resolve(destination, 'package.json'), 'utf8'),
  );
  assert(
    packageManifest.packageManager.startsWith(`${packageManager}@`),
    `${testCase.id}: packageManager does not record ${packageManager}.`,
  );
  assert(
    (await exists(resolve(destination, 'pnpm-lock.yaml'))) ===
      (packageManager === 'pnpm') &&
      (await exists(resolve(destination, 'package-lock.json'))) ===
        (packageManager === 'npm'),
    `${testCase.id}: generated lockfile does not match ${packageManager}.`,
  );
  const healthWorkflow = await readFile(
    resolve(destination, '.github/workflows/megamono-health.yml'),
    'utf8',
  );
  assert(
    /cron:\s*['"]17 9 \* \* 1['"]/.test(healthWorkflow) &&
      healthWorkflow.includes('issues: write') &&
      !/^\s{2}pull_request:/m.test(healthWorkflow),
    `${testCase.id}: generated health workflow does not match the scheduled issue contract.`,
  );
  const ciPath = (await exists(
    resolve(destination, '.github/workflows/ci.yml'),
  ))
    ? resolve(destination, '.github/workflows/ci.yml')
    : resolve(destination, '.github/workflows/megamono-ci.yml');
  const ciWorkflow = await readFile(ciPath, 'utf8');
  assert(
    ciWorkflow.includes('actions/checkout@v7') &&
      ciWorkflow.includes('fetch-depth: 0') &&
      ciWorkflow.includes('nrwl/nx-set-shas@v5') &&
      ciWorkflow.includes(
        packageManager === 'pnpm'
          ? 'pnpm exec nx affected -t lint test build'
          : 'npm exec nx -- affected -t lint test build',
      ) &&
      !ciWorkflow.includes('contents: write'),
    `${testCase.id}: generated CI workflow does not match the affected contract.`,
  );
  assert(
    ciWorkflow.includes('runs-on: macos-latest') ===
      testCase.apps.some((app) => appInstance(app).type === 'apple'),
    `${testCase.id}: generated CI Apple job does not match the selected platforms.`,
  );
  assert(
    ciWorkflow.includes('dtolnay/rust-toolchain@stable') ===
      testCase.apps.some((app) => appInstance(app).type === 'desktop'),
    `${testCase.id}: generated CI Rust toolchain does not match the selected platforms.`,
  );
  const gitignore = await readFile(resolve(destination, '.gitignore'), 'utf8');
  assert(
    gitignore.includes('.megamono/health.json'),
    `${testCase.id}: generated health report is not ignored.`,
  );
  const eslintConfig = await readFile(
    resolve(destination, 'eslint.config.mjs'),
    'utf8',
  );
  assert(
    eslintConfig.includes("from '@megamono/plugin/eslint'") &&
      eslintConfig.includes('megamonoPlugin.createConfig(megamonoConfig)'),
    `${testCase.id}: generated ESLint config is not wired to Megamono rules.`,
  );

  for (const name of testCase.packages ?? []) {
    const manifest = JSON.parse(
      await readFile(
        resolve(destination, 'packages', name, 'package.json'),
        'utf8',
      ),
    );
    assert(
      manifest.name === `@${scope}/${name}` && manifest.private !== true,
      `${testCase.id}: package identity is incorrect.`,
    );
    assert(
      manifest.publishConfig.access === 'restricted' && manifest.exports['.'],
      `${testCase.id}: package access or exports are missing.`,
    );
    const nx = JSON.parse(
      await readFile(resolve(destination, 'nx.json'), 'utf8'),
    );
    assert(
      nx.release.projects.includes(`${scope}-${name}`),
      `${testCase.id}: package is missing from release selection.`,
    );
    assert(
      await exists(
        resolve(destination, '.github/workflows/megamono-release.yml'),
      ),
      `${testCase.id}: release workflow is missing.`,
    );
    const build = nxInvocation(packageManager, [
      'run',
      `${scope}-${name}:build`,
    ]);
    await run(build.command, build.args, {
      cwd: destination,
      env: caseEnvironment,
    });
    assert(
      await exists(resolve(destination, 'packages', name, 'dist/index.js')),
      `${testCase.id}: built package entry is missing.`,
    );
    assert(
      await exists(resolve(destination, 'packages', name, 'dist/index.d.ts')),
      `${testCase.id}: built declarations are missing.`,
    );
  }

  for (const descriptor of testCase.apps) {
    const { type: app, name } = appInstance(descriptor);
    const projectName = `${scope}-${name}`;
    const showProject = nxInvocation(packageManager, [
      'show',
      'project',
      projectName,
      '--json',
    ]);
    const project = parseJsonRecord(
      (
        await run(showProject.command, showProject.args, {
          cwd: destination,
          env: caseEnvironment,
        })
      ).stdout,
      `${testCase.id}: ${projectName} project query`,
    );
    assert(
      project.root === `apps/${name}`,
      `${testCase.id}: ${projectName} root is ${project.root}.`,
    );
    assert(
      project.tags.includes(`platform:${appPlatforms[app]}`),
      `${testCase.id}: ${projectName} platform tag is missing.`,
    );
    assert(
      project.tags.includes(`scope:${scope}`),
      `${testCase.id}: ${projectName} scope tag is missing.`,
    );
    assert(
      project.projectType === 'application',
      `${testCase.id}: ${projectName} is not an application project.`,
    );
    if (project.targets?.lint) {
      const lintInvocation = nxInvocation(packageManager, [
        'run',
        `${projectName}:lint`,
        '--output-style=static',
      ]);
      await run(lintInvocation.command, lintInvocation.args, {
        cwd: destination,
        env: caseEnvironment,
      });
    }
    if (app === 'site' || app === 'web') {
      assert(
        await exists(
          resolve(destination, `apps/${name}`, 'src/pages/index.tsx'),
        ),
        `${testCase.id}: ${projectName} did not use the required Pages Router.`,
      );
      assert(
        !(await exists(resolve(destination, `apps/${name}`, 'src/app'))),
        `${testCase.id}: ${projectName} unexpectedly emitted App Router files.`,
      );
    }
    if (app === 'worker') {
      for (const target of ['dev', 'deploy', 'typegen', 'tail']) {
        assert(
          project.targets?.[target],
          `${testCase.id}: ${projectName} is missing inferred ${target}.`,
        );
      }
      assert(
        !project.targets?.build,
        `${testCase.id}: ${projectName} unexpectedly inferred build.`,
      );
      assert(
        project.metadata?.['megamono:cloudflare']?.schemaVersion === 1,
        `${testCase.id}: ${projectName} is missing normalized Cloudflare metadata.`,
      );
    }
  }

  const agents = await readFile(resolve(destination, 'AGENTS.md'), 'utf8');
  const claude = await readFile(resolve(destination, 'CLAUDE.md'), 'utf8');
  assert(agents.trim().length > 0, `${testCase.id}: AGENTS.md is empty.`);
  assert(
    claude.trim() === '@AGENTS.md',
    `${testCase.id}: CLAUDE.md is not the canonical pointer.`,
  );
  const managedSkill = resolve(
    destination,
    '.agents/skills/structure-review/SKILL.md',
  );
  const managedProvenance = resolve(destination, '.megamono/artifacts.json');
  assert(
    (await exists(managedSkill)) && (await exists(managedProvenance)),
    `${testCase.id}: managed Megamono skills were not installed.`,
  );
  const provenance = JSON.parse(await readFile(managedProvenance, 'utf8'));
  const skillArtifact = provenance.artifacts.find(
    ({ id }) => id === 'skill.structure-review',
  );
  assert(
    skillArtifact?.state === 'managed' &&
      /^sha256:[a-f0-9]{64}$/.test(skillArtifact.templateHash),
    `${testCase.id}: managed skill provenance is invalid.`,
  );
  await rm(destination, { recursive: true, force: true });
  await rm(npmCache, { recursive: true, force: true });
  process.stdout.write(
    `create-megamono selection matrix passed: ${testCase.id}\n`,
  );
}

const temporaryRoot = await mkdtemp(
  join(tmpdir(), 'megamono-create-selection-matrix-e2e-'),
);
const npmConfig = resolve(temporaryRoot, 'npmrc');
const registryConfig = resolve(temporaryRoot, 'verdaccio.json');
const commandBin = resolve(temporaryRoot, 'bin');
const port = await availablePort();
const registry = `http://127.0.0.1:${port}`;

await writeFile(
  npmConfig,
  `registry=${registry}\n//127.0.0.1:${port}/:_authToken=local-e2e-token\n`,
  'utf8',
);
await mkdir(commandBin);
for (const manager of ['npm', 'pnpm']) {
  await writeFile(
    resolve(commandBin, manager),
    `#!/bin/sh\nexec corepack ${manager}@${compatibility.packageManagers[manager]} "$@"\n`,
    'utf8',
  );
  await chmod(resolve(commandBin, manager), 0o755);
}
await writeFile(
  registryConfig,
  `${JSON.stringify(
    {
      storage: resolve(temporaryRoot, 'registry-storage'),
      uplinks: {
        npmjs: { url: 'https://registry.npmjs.org/' },
      },
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
    NX_DAEMON: 'false',
    npm_config_userconfig: npmConfig,
    PATH: `${commandBin}:${process.env.PATH ?? ''}`,
  };
  const publishCache = resolve(temporaryRoot, 'npm-cache-publish');
  for (const packagePath of [
    './packages/plugin',
    './packages/nx-apple',
    './packages/nx-cargo',
    './packages/nx-cloudflare',
    './packages/nx-extension',
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
      { env: { ...environment, npm_config_cache: publishCache } },
    );
  }
  const launcher = resolve(temporaryRoot, 'launcher');
  await mkdir(launcher);
  await writeFile(
    resolve(launcher, 'package.json'),
    '{"name":"create-megamono-matrix-launcher","private":true}\n',
    'utf8',
  );
  await run(
    'npm',
    [
      'install',
      '--save-exact',
      `create-megamono@${await packageVersion('create-megamono')}`,
      '--registry',
      registry,
    ],
    { cwd: launcher, env: { ...environment, npm_config_cache: publishCache } },
  );
  const createCliPath = resolve(
    launcher,
    'node_modules/create-megamono/dist/cli.js',
  );
  assert(await exists(createCliPath), 'Packed create-megamono CLI is missing.');
  await rm(publishCache, { recursive: true, force: true });

  for (const testCase of cases) {
    await verifyCase(temporaryRoot, testCase, environment, createCliPath);
  }
  succeeded = true;
  process.stdout.write(
    requestedCases.size
      ? `create-megamono selection matrix passed requested cases: ${cases.map(({ id }) => id).join(',')}.\n`
      : 'create-megamono selection matrix passed: every app independently, the all-app combination, named sibling instances, and npm/pnpm generated outputs.\n',
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
      `Retained failed selection-matrix fixture: ${temporaryRoot}\n`,
    );
}
