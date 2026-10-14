import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(workspace, 'package.json'));
const root = await mkdtemp(join(tmpdir(), 'megamono-integration-consumer-'));
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('NX_')),
  ),
  CI: 'true',
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  NX_INTERACTIVE: 'false',
  npm_config_cache: join(root, 'npm-cache'),
};
const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const put = async (path, content) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(
    join(root, path),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
};
try {
  const packed = JSON.parse(
    run('npm', [
      'pack',
      join(workspace, 'packages/plugin'),
      '--pack-destination',
      root,
      '--ignore-scripts',
      '--json',
    ]),
  )[0];
  const plugin = join(root, 'node_modules/@megamono/plugin');
  await mkdir(plugin, { recursive: true });
  run('tar', [
    '-xzf',
    join(root, packed.filename),
    '-C',
    plugin,
    '--strip-components=1',
  ]);
  // Share installed toolchain dependencies, but load Megamono from its tarball.
  await symlink(
    join(workspace, 'node_modules'),
    join(plugin, 'node_modules'),
    'dir',
  );
  await symlink(
    dirname(require.resolve('nx/package.json')),
    join(root, 'node_modules/nx'),
    'dir',
  );
  await put('package.json', {
    name: 'integration-consumer',
    private: true,
    devDependencies: {
      nx: require('nx/package.json').version,
      '@megamono/plugin': 'file:./' + packed.filename,
    },
  });
  await put('nx.json', { analytics: false });
  await put('.prettierrc', { singleQuote: false });
  await put('apps/api/project.json', {
    name: 'api',
    projectType: 'application',
    targets: {
      contract: {
        executor: 'nx:run-commands',
        options: { command: 'node verify.cjs' },
      },
    },
  });
  await put(
    '.github/workflows/ci.yml',
    'name: CI\non: [push]\njobs:\n  quality:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n',
  );
  await put(
    'verify.cjs',
    "require('node:assert/strict').equal(require('./build/main.js').bootstrap(), 'ready');\n",
  );
  await put('tsconfig.json', {
    compilerOptions: {
      target: 'ES2022',
      module: 'CommonJS',
      outDir: 'build',
      rootDir: 'apps/api/src',
      types: [],
      skipLibCheck: true,
    },
    include: ['apps/api/src/**/*.ts'],
  });
  const content = "export function ready(){return 'ready'}\n";
  await put('node_modules/@playstack/integration-fixture/package.json', {
    name: '@playstack/integration-fixture',
    version: '1.0.0',
  });
  await put(
    'node_modules/@playstack/integration-fixture/templates/provider.ts',
    content,
  );
  await put(
    'node_modules/@playstack/integration-fixture/playstack.integration.json',
    {
      version: 1,
      package: '@playstack/integration-fixture',
      packageVersion: '1.0.0',
      integrations: [
        {
          id: 'fixture',
          surface: 'api',
          framework: 'node',
          requirements: {
            requiredTests: [{ id: 'runtime-ready', kind: 'integration' }],
          },
          templates: [
            {
              id: 'provider',
              kind: 'provider',
              source: 'templates/provider.ts',
              target: 'src/playstack/provider.ts',
              ejectable: true,
              sha256: createHash('sha256').update(content).digest('hex'),
            },
          ],
        },
      ],
    },
  );
  const nx = join(
    dirname(require.resolve('nx/package.json')),
    require('nx/package.json').bin.nx,
  );
  const args = [
    nx,
    'generate',
    `${join(plugin, 'generators.json')}:playstack-integrate`,
    '--packages=@playstack/integration-fixture',
    '--api=apps/api',
    '--verificationProject=api',
    '--verification={"@playstack/integration-fixture:fixture:runtime-ready":"api:contract"}',
    '--ciWorkflow=.github/workflows/ci.yml',
    '--ciJob=quality',
    '--yes',
    '--interactive=false',
  ];
  run(process.execPath, [...args, '--dryRun']);
  const target = join(root, 'apps/api/src/playstack/provider.ts');
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  const profileArgs = args.filter(
    (arg) =>
      !['--verification', '--ciWorkflow', '--ciJob'].some((prefix) =>
        arg.startsWith(prefix),
      ),
  );
  profileArgs.push(
    '--migrationContracts={"@playstack/integration-fixture:fixture":["queue-jobs"]}',
  );
  run(process.execPath, [...profileArgs, '--dryRun']);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  run(process.execPath, profileArgs);
  const profilePlan = JSON.parse(
    await readFile(
      join(root, '.megamono/playstack-integration-plan.json'),
      'utf8',
    ),
  );
  assert.deepEqual(
    profilePlan.qualification[
      '@playstack/integration-fixture:fixture:migration.queue-payload-compatibility'
    ],
    ['real-queue'],
  );
  const generatedWithProfile = await readFile(target, 'utf8');
  assert.throws(() =>
    run(process.execPath, [...profileArgs, '--adoptionMode=cutover']),
  );
  assert.equal(await readFile(target, 'utf8'), generatedWithProfile);
  run(process.execPath, args);
  const first = await readFile(target, 'utf8');
  run(process.execPath, args);
  assert.equal(await readFile(target, 'utf8'), first);
  await put(
    'apps/api/src/main.ts',
    "import { ready } from './playstack/provider'; export const bootstrap = ready;\n",
  );
  run(process.execPath, [
    require.resolve('typescript/bin/tsc'),
    '--project',
    join(root, 'tsconfig.json'),
  ]);
  run(process.execPath, [
    '-e',
    `require('node:assert/strict').equal(require(${JSON.stringify(join(root, 'build/main.js'))}).bootstrap(), 'ready')`,
  ]);
  run(process.execPath, [nx, 'run', 'api:playstack-verify']);
  const workflow = require('yaml').parse(
    await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'),
  );
  run('/bin/sh', ['-c', workflow.jobs.quality.steps.at(-1).run]);
  const integration = '@playstack/integration-fixture:fixture';
  const instance = `${integration}@${encodeURIComponent('apps/api')}`;
  run(process.execPath, [
    ...args,
    `--migrationStages=${JSON.stringify({ [integration]: { stage: 'compare' } })}`,
  ]);
  const ledgerPath = join(root, '.megamono/playstack-integrations.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  assert.equal(ledger.integrations[instance].stage, 'compare');
  await put('verification.json', {
    schemaVersion: 1,
    integration,
    fingerprint: ledger.integrations[instance].fingerprint,
    stage: 'shadow',
    result: 'passed',
    checks: ['runtime-ready'],
  });
  await put(
    'rollback.md',
    'Restore the previous provider and run the runtime contract.',
  );
  run(process.execPath, [
    ...args,
    `--migrationStages=${JSON.stringify({ [integration]: { stage: 'shadow', verificationReport: 'verification.json', rollbackPlan: 'rollback.md' } })}`,
  ]);
  assert.equal(
    JSON.parse(await readFile(ledgerPath, 'utf8')).integrations[instance]
      .stage,
    'shadow',
  );
  await put('verify.cjs', "throw new Error('contract failure');\n");
  assert.throws(() =>
    run(process.execPath, [nx, 'run', 'api:playstack-verify']),
  );
  await writeFile(target, 'export const applicationOwned = true;\n');
  assert.throws(() => run(process.execPath, args));
  assert.equal(
    await readFile(target, 'utf8'),
    'export const applicationOwned = true;\n',
  );
  const { verifyRuntimeDependencies } = require(
    join(plugin, 'dist/lib/runtime-verification.js'),
  );
  await put(
    'runtime-fixture/main.cjs',
    'const example = `import "@mui/material"; require("expo-font")`;\n// require("comment-only")\nconst real = require("tslib");\n',
  );
  const runtimeOptions = {
    workspaceRoot: root,
    project: 'api',
    projectRoot: 'apps/api',
    outputPath: 'runtime-fixture',
  };
  const runtime = await verifyRuntimeDependencies(runtimeOptions);
  assert.deepEqual(runtime.externalPackages, ['tslib']);
  assert.equal(runtime.findings.length, 1);
  assert.equal(runtime.findings[0].code, 'runtime-dependency-missing');
  await put(
    'runtime-fixture/esm.mjs',
    'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("esm-runtime");',
  );
  assert.deepEqual(
    (await verifyRuntimeDependencies(runtimeOptions)).externalPackages,
    ['esm-runtime', 'tslib'],
  );
  await put('runtime-fixture/dynamic.mjs', 'import(packageName);');
  assert.ok(
    (await verifyRuntimeDependencies(runtimeOptions)).findings.some(
      ({ code }) => code === 'runtime-analysis-incomplete',
    ),
  );
  console.log(
    'Packed Nx integration consumer: dry-run, rerun, compiled runtime, Nx/CI verification, migration ledger, contract-profile cutover gate, syntax-aware runtime reports, failure propagation, and edit protection passed. Real queue/database policy qualification is not part of this fixture.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
