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
const appRoots = {
  api: 'apps/api',
  apple: 'apps/apple',
  desktop: 'apps/desktop',
  mobile: 'apps/mobile',
  site: 'apps/site',
  web: 'apps/web',
  worker: 'apps/worker',
};
const appPlatforms = {
  api: 'node',
  apple: 'apple',
  desktop: 'rust',
  mobile: 'web',
  site: 'web',
  web: 'web',
  worker: 'worker',
};
const allApps = Object.keys(appRoots).sort();
const matrixCases = [
  ...allApps.map((app) => ({ id: app, apps: [app], packageManager: 'pnpm' })),
  { id: 'all', apps: allApps, packageManager: 'pnpm' },
  { id: 'web-npm', apps: ['web'], packageManager: 'npm' },
  {
    id: 'web-no-install',
    apps: ['web'],
    packageManager: 'npm',
    install: false,
  },
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

async function verifyCase(root, testCase, environment, createCliPath) {
  const scope = `matrix-${testCase.id}`;
  const destination = resolve(root, scope);
  const staging = resolve(root, `megamono-${scope}-staging`);
  const npmCache = resolve(root, `npm-cache-${testCase.id}`);
  const caseEnvironment = { ...environment, npm_config_cache: npmCache };
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
      `--apps=${testCase.apps.join(',')}`,
      `--package-manager=${packageManager}`,
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
    ...new Set(testCase.apps.map((app) => appPlatforms[app])),
  ].sort();
  assert(
    JSON.stringify(megamono.platforms) === JSON.stringify(expectedPlatforms),
    `${testCase.id}: expected platforms ${expectedPlatforms.join(',')}, received ${JSON.stringify(megamono.platforms)}.`,
  );

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
      testCase.apps.includes('apple'),
    `${testCase.id}: generated CI Apple job does not match the selected platforms.`,
  );
  assert(
    ciWorkflow.includes('dtolnay/rust-toolchain@stable') ===
      testCase.apps.includes('desktop'),
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

  for (const app of testCase.apps) {
    const projectName = `${scope}-${app}`;
    const showProject = nxInvocation(packageManager, [
      'show',
      'project',
      projectName,
      '--json',
    ]);
    const project = JSON.parse(
      (
        await run(showProject.command, showProject.args, {
          cwd: destination,
          env: caseEnvironment,
        })
      ).stdout,
    );
    assert(
      project.root === appRoots[app],
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
          resolve(destination, appRoots[app], 'src/pages/index.tsx'),
        ),
        `${testCase.id}: ${projectName} did not use the required Pages Router.`,
      );
      assert(
        !(await exists(resolve(destination, appRoots[app], 'src/app'))),
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
await writeFile(
  resolve(commandBin, 'pnpm'),
  '#!/bin/sh\nexec corepack pnpm@11.24.0 "$@"\n',
  'utf8',
);
await chmod(resolve(commandBin, 'pnpm'), 0o755);
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
      'create-megamono@0.0.1',
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
      : 'create-megamono selection matrix passed: every app independently, the all-app combination, and npm/pnpm generated outputs.\n',
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
