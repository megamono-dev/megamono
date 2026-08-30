import { spawn } from 'node:child_process';
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
      const result = { code, signal, stdout, stderr };
      if (options.allowFailure || code === 0) resolvePromise(result);
      else
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function availablePort() {
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

const nxBin = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { resolve } = require('node:path');
appendFileSync(resolve(process.cwd(), '.fixture-nx.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(Number(process.env.FIXTURE_NX_EXIT || 0));
`;

const playstackBin = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(resolve(process.cwd(), '.fixture-playstack.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'add' && args[1]) {
  const manifestPath = resolve(process.cwd(), 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const packageName = '@playstack/' + args[1];
  if (args.includes('--local-packages=yalc')) {
    const localPackage = resolve(process.cwd(), '.yalc', packageName);
    mkdirSync(localPackage, { recursive: true });
    writeFileSync(
      resolve(localPackage, 'package.json'),
      JSON.stringify({ name: packageName, version: '0.1.0' }) + '\\n',
    );
  }
  manifest.dependencies = {
    ...(manifest.dependencies || {}),
    [packageName]: args.includes('--local-packages=yalc')
      ? 'file:' + resolve(process.cwd(), '.yalc', packageName)
      : '^0.1.0',
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n');
}
`;

async function createPackage(root, manifest, executable, source) {
  const directory = resolve(
    root,
    manifest.name.replace('@', '').replace('/', '-'),
  );
  await mkdir(directory, { recursive: true });
  await json(
    resolve(directory, 'package.json'),
    executable ? { ...manifest, bin: { [executable]: 'bin.cjs' } } : manifest,
  );
  if (executable) {
    await writeFile(resolve(directory, 'bin.cjs'), source);
    await chmod(resolve(directory, 'bin.cjs'), 0o755);
  }
  return directory;
}

async function publishPackage(directory, registry, environment) {
  await run(
    'npm',
    [
      'publish',
      directory,
      '--registry',
      registry,
      '--access',
      'public',
      '--provenance=false',
    ],
    { env: environment },
  );
}

async function createWorkspace(root, manager, registry, environment) {
  await mkdir(root, { recursive: true });
  await json(resolve(root, 'package.json'), {
    name: `fixture-${manager}`,
    private: true,
    packageManager: manager === 'pnpm' ? 'pnpm@11.24.0' : 'npm@11.17.0',
    devDependencies: {
      '@megamono/plugin': '0.0.1',
      nx: '23.1.1',
    },
  });
  await json(resolve(root, 'nx.json'), {});
  await writeFile(resolve(root, '.npmrc'), `registry=${registry}\n`);
  await run(manager, ['install'], { cwd: root, env: environment });
}

async function readInvocations(root) {
  return (await readFile(resolve(root, '.fixture-nx.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readPlaystackInvocations(root) {
  return (await readFile(resolve(root, '.fixture-playstack.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function installPackedCli(temporaryRoot, environment) {
  const packDirectory = resolve(temporaryRoot, 'pack');
  const prefix = resolve(temporaryRoot, 'global');
  await mkdir(packDirectory, { recursive: true });
  const packed = JSON.parse(
    (
      await run(
        'npm',
        [
          'pack',
          './packages/cli',
          '--pack-destination',
          packDirectory,
          '--json',
        ],
        { env: environment },
      )
    ).stdout,
  );
  await run(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--ignore-scripts',
      resolve(packDirectory, packed[0].filename),
    ],
    { env: environment },
  );
  const executable = resolve(prefix, 'bin/megamono');
  assert((await run(executable, ['--version'])).stdout.trim() === '0.0.1');
  return executable;
}

async function createYalcShim(root) {
  const path = resolve(root, 'bin/yalc');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `#!/usr/bin/env node
const { cpSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const store = process.env.MEGAMONO_E2E_YALC_STORE;
const args = process.argv.slice(2);
if (args[0] === 'dir') { console.log(store); process.exit(0); }
if (args[0] !== 'add') process.exit(2);
const packages = args.slice(1).filter((value) => !value.startsWith('--'));
const dev = args.includes('--dev');
const manifestPath = resolve(process.cwd(), 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const packageName of packages) {
  const sourceRoot = join(store, 'packages', ...packageName.split('/'));
  const version = readdirSync(sourceRoot).sort().at(-1);
  const source = join(sourceRoot, version);
  const target = resolve(process.cwd(), '.yalc', ...packageName.split('/'));
  cpSync(source, target, { recursive: true });
  const field = dev ? 'devDependencies' : 'dependencies';
  manifest[field] = { ...(manifest[field] || {}), [packageName]: 'file:' + target };
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n');
`,
  );
  await chmod(path, 0o755);
  return dirname(path);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'megamono-cli-e2e-'));
const baseEnvironment = {
  FORCE_COLOR: '0',
  npm_config_audit: 'false',
  npm_config_cache: resolve(temporaryRoot, 'npm-cache'),
  npm_config_fund: 'false',
};
const npmConfig = resolve(temporaryRoot, 'npmrc');
const registryConfig = resolve(temporaryRoot, 'verdaccio.json');
const port = await availablePort();
const registry = `http://127.0.0.1:${port}`;
await writeFile(
  npmConfig,
  `registry=${registry}\n//127.0.0.1:${port}/:_authToken=local-e2e-token\n`,
);
const environment = {
  ...baseEnvironment,
  npm_config_userconfig: npmConfig,
};
await json(registryConfig, {
  storage: resolve(temporaryRoot, 'registry-storage'),
  packages: {
    '**': {
      access: '$all',
      publish: '$all',
      unpublish: '$all',
    },
  },
  log: { type: 'stdout', format: 'pretty', level: 'warn' },
  publish: { allow_offline: true },
});

const verdaccio = spawn(
  process.execPath,
  [
    resolve(workspaceRoot, 'node_modules/verdaccio/bin/verdaccio'),
    '--config',
    registryConfig,
    '--listen',
    `127.0.0.1:${port}`,
  ],
  { cwd: workspaceRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let registryLog = '';
verdaccio.stdout.on('data', (chunk) => (registryLog += chunk));
verdaccio.stderr.on('data', (chunk) => (registryLog += chunk));

let succeeded = false;
try {
  const megamono = await installPackedCli(temporaryRoot, baseEnvironment);
  await waitForRegistry(registry, verdaccio, () => registryLog);
  const packageRoot = resolve(temporaryRoot, 'packages');
  const packageDirectories = new Map([
    [
      'nx',
      await createPackage(
        packageRoot,
        { name: 'nx', version: '23.1.1' },
        'nx',
        nxBin,
      ),
    ],
    [
      '@megamono/plugin',
      await createPackage(packageRoot, {
        name: '@megamono/plugin',
        version: '0.0.1',
      }),
    ],
    [
      '@playstack/cli',
      await createPackage(
        packageRoot,
        { name: '@playstack/cli', version: '0.1.0' },
        'playstack',
        playstackBin,
      ),
    ],
    [
      '@playstack/auth',
      await createPackage(packageRoot, {
        name: '@playstack/auth',
        version: '0.1.0',
      }),
    ],
  ]);
  await json(
    resolve(packageDirectories.get('@megamono/plugin'), 'availability.json'),
    {
      version: 1,
      generators: {
        'docs-spec': { status: 'available' },
        'integration-sentry': {
          status: 'gated',
          gate: 'The Sentry integration fixture contract has not passed.',
        },
      },
    },
  );
  for (const directory of packageDirectories.values())
    await publishPackage(directory, registry, environment);

  const npmWorkspace = resolve(temporaryRoot, 'npm-workspace');
  await createWorkspace(npmWorkspace, 'npm', registry, environment);
  await run(megamono, ['init', '--playstack-packages=auth', '--only=docs'], {
    cwd: npmWorkspace,
    env: environment,
  });
  const registryManifest = JSON.parse(
    await readFile(resolve(npmWorkspace, 'package.json'), 'utf8'),
  );
  assert(
    registryManifest.devDependencies['@playstack/cli']?.includes('0.1.0'),
    'Registry setup did not install @playstack/cli as a dev dependency.',
  );
  assert(
    registryManifest.dependencies['@playstack/auth']?.includes('0.1.0'),
    'Registry setup did not install the requested runtime package.',
  );
  assert(
    JSON.stringify(await readPlaystackInvocations(npmWorkspace)) ===
      JSON.stringify([['add', 'auth', '--yes'], ['init']]),
    'Registry setup did not delegate the capability and init to the local Playstack CLI.',
  );
  const npmNx = await readInvocations(npmWorkspace);
  assert(
    npmNx[0].includes('--only=docs') &&
      !npmNx[0].some((value) => value.startsWith('--playstack')),
    'CLI-only options leaked into the Nx generator invocation.',
  );
  const beforeGatedInvocations = npmNx.length;
  const gated = await run(megamono, ['generate', 'integration-sentry'], {
    cwd: npmWorkspace,
    env: environment,
    allowFailure: true,
  });
  assert(
    gated.code === 3 &&
      gated.stderr.includes(
        'Generator integration-sentry is gated: The Sentry integration fixture contract has not passed.',
      ),
    'The packed CLI did not report the gated generator diagnostic.',
  );
  assert(
    (await readInvocations(npmWorkspace)).length === beforeGatedInvocations,
    'A gated generator reached Nx delegation.',
  );

  const pnpmWorkspace = resolve(temporaryRoot, 'pnpm-workspace');
  await createWorkspace(pnpmWorkspace, 'pnpm', registry, environment);
  const yalcStore = resolve(temporaryRoot, 'yalc-store');
  for (const packageName of ['@playstack/cli', '@playstack/auth']) {
    await cp(
      packageDirectories.get(packageName),
      resolve(yalcStore, 'packages', ...packageName.split('/'), '0.1.0'),
      { recursive: true },
    );
  }
  const shimDirectory = await createYalcShim(resolve(temporaryRoot, 'shims'));
  const yalcEnvironment = {
    ...environment,
    MEGAMONO_E2E_YALC_STORE: yalcStore,
    PATH: `${shimDirectory}:${process.env.PATH}`,
  };
  await run(
    megamono,
    [
      'init',
      '--playstack-packages=auth',
      '--local-packages=yalc',
      '--interactive=false',
    ],
    { cwd: pnpmWorkspace, env: yalcEnvironment },
  );
  const yalcManifest = JSON.parse(
    await readFile(resolve(pnpmWorkspace, 'package.json'), 'utf8'),
  );
  assert(
    yalcManifest.devDependencies['@playstack/cli'].startsWith('file:'),
    'Yalc setup did not retain @playstack/cli as a dev dependency.',
  );
  assert(
    yalcManifest.dependencies['@playstack/auth'].startsWith('file:'),
    'Yalc setup did not retain the requested runtime package.',
  );
  assert(
    JSON.stringify(await readPlaystackInvocations(pnpmWorkspace)) ===
      JSON.stringify([
        ['add', 'auth', '--yes', '--local-packages=yalc'],
        ['init'],
      ]),
    'Yalc setup did not invoke the local Playstack CLI.',
  );
  assert(
    (await readInvocations(pnpmWorkspace))[0].includes('--interactive=false'),
    'pnpm did not forward generator options.',
  );

  const surveyWorkspace = resolve(temporaryRoot, 'survey-workspace');
  await createWorkspace(surveyWorkspace, 'npm', registry, environment);
  await mkdir(resolve(surveyWorkspace, 'apps/nested'), { recursive: true });
  const beforeManifest = await readFile(
    resolve(surveyWorkspace, 'package.json'),
  );
  const beforeLock = await readFile(
    resolve(surveyWorkspace, 'package-lock.json'),
  );
  const survey = await run(megamono, ['init', '--survey', '--playstack'], {
    cwd: resolve(surveyWorkspace, 'apps/nested'),
    env: environment,
  });
  assert(
    survey.stdout.includes('Playstack survey deferred'),
    'Combined survey did not report its deferred Playstack plan.',
  );
  assert(
    beforeManifest.equals(
      await readFile(resolve(surveyWorkspace, 'package.json')),
    ) &&
      beforeLock.equals(
        await readFile(resolve(surveyWorkspace, 'package-lock.json')),
      ),
    'Combined survey changed package state.',
  );

  const missingStore = resolve(temporaryRoot, 'missing-yalc-store');
  await mkdir(missingStore, { recursive: true });
  const beforeMissingInvocations = (await readInvocations(surveyWorkspace))
    .length;
  const missing = await run(
    megamono,
    ['init', '--playstack-packages=auth', '--local-packages=yalc'],
    {
      cwd: surveyWorkspace,
      env: { ...yalcEnvironment, MEGAMONO_E2E_YALC_STORE: missingStore },
      allowFailure: true,
    },
  );
  assert(missing.code === 3, 'Missing yalc artifacts did not exit 3.');
  assert(
    (await readInvocations(surveyWorkspace)).length ===
      beforeMissingInvocations,
    'Missing yalc artifacts spawned workspace-init.',
  );

  const delegatedFailure = await run(
    megamono,
    ['init', '--survey', '--only=ci'],
    {
      cwd: npmWorkspace,
      env: { ...environment, FIXTURE_NX_EXIT: '4' },
      allowFailure: true,
    },
  );
  assert(
    delegatedFailure.code === 4,
    'The packed CLI did not propagate the delegated Nx exit status.',
  );

  await writeFile(
    resolve(surveyWorkspace, 'pnpm-lock.yaml'),
    'lockfileVersion: 9\n',
  );
  const beforeAmbiguousInvocations = (await readInvocations(surveyWorkspace))
    .length;
  const ambiguous = await run(megamono, ['init', '--survey'], {
    cwd: surveyWorkspace,
    env: environment,
    allowFailure: true,
  });
  assert(ambiguous.code === 3, 'Conflicting lockfiles did not exit 3.');
  assert(
    (await readInvocations(surveyWorkspace)).length ===
      beforeAmbiguousInvocations,
    'Conflicting lockfiles spawned workspace-init.',
  );
  await rm(resolve(surveyWorkspace, 'pnpm-lock.yaml'));

  await rm(resolve(surveyWorkspace, 'node_modules/@megamono/plugin'), {
    recursive: true,
    force: true,
  });
  const missingPlugin = await run(megamono, ['init'], {
    cwd: surveyWorkspace,
    env: environment,
    allowFailure: true,
  });
  assert(
    missingPlugin.code === 3 &&
      missingPlugin.stderr.includes('npm install --save-dev @megamono/plugin'),
    'Missing local plugin did not produce its stable installation refusal.',
  );

  process.stdout.write(
    'Megamono packed CLI e2e passed: isolated global install, npm/pnpm delegation, gated generator diagnostics, registry/yalc Playstack setup, survey, exit propagation, and preflight verified.\n',
  );
  succeeded = true;
} finally {
  verdaccio.kill('SIGTERM');
  if (succeeded || process.env.MEGAMONO_E2E_KEEP !== 'true')
    await rm(temporaryRoot, { recursive: true, force: true });
  else process.stderr.write(`Retained failed CLI fixture: ${temporaryRoot}\n`);
}
