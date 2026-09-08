import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkEmittedTypeScript } from './emitted-typescript.mjs';

const workspace = resolve(import.meta.dirname, '../../..');
const root = await mkdtemp(join(tmpdir(), 'megamono-billing-templates-'));
const reportRoot = join(workspace, 'tmp/billing-template-consumer');
const exec = promisify(execFile);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const env = {
  ...Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  ),
  CI: 'true',
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  npm_config_cache: join(root, '.npm-cache'),
  npm_config_userconfig: join(root, '.npmrc'),
};
const run = async (command, args, cwd = root) =>
  (
    await exec(command, args, {
      cwd,
      env,
      timeout: 300_000,
      maxBuffer: 8_000_000,
    })
  ).stdout;
const put = async (file, content) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
};
const report = {
  schemaVersion: 1,
  scope:
    'Packed emitted billing controller/test composition; not production billing qualification',
  node: process.version,
  status: 'running',
  artifacts: [],
  checks: [],
  notRun: [
    'HTTP authorization with real account guard',
    'database transactions',
    'Stripe provider behavior',
  ],
};
async function check(id, action) {
  console.log(`Billing templates: ${id}`);
  try {
    const output = String((await action()) ?? 'passed');
    await put(join(reportRoot, `${id}.log`), output);
    report.checks.push({ id, status: 'passed', sha256: digest(output) });
  } catch (error) {
    const output = `${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    await put(join(reportRoot, `${id}.log`), output);
    report.checks.push({ id, status: 'failed', sha256: digest(output) });
    throw error;
  }
}
try {
  await mkdir(reportRoot, { recursive: true });
  report.revision = (await run('git', ['rev-parse', 'HEAD'], workspace)).trim();
  report.dirty = Boolean(
    (await run('git', ['status', '--porcelain'], workspace)).trim(),
  );
  await put(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  const store = (await run('yalc', ['dir'])).trim();
  const dependencies = {};
  async function pack(directory) {
    const [packed] = JSON.parse(
      await run('npm', [
        'pack',
        directory,
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        root,
      ]),
    );
    report.artifacts.push({
      name: packed.name,
      version: packed.version,
      sha256: digest(await readFile(join(root, packed.filename))),
    });
    dependencies[packed.name] = `file:./${packed.filename}`;
  }
  async function stage(name, version = '0.1.0-beta.1') {
    if (dependencies[name]) return;
    const directory = join(store, 'packages', name, version);
    const manifest = JSON.parse(
      await readFile(join(directory, 'package.json'), 'utf8'),
    );
    await pack(directory);
    for (const [dependency, range] of Object.entries({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    })) {
      if (
        dependency.startsWith('@playstack/') &&
        !manifest.peerDependenciesMeta?.[dependency]?.optional
      ) {
        assert.match(
          range,
          /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/,
          `Expected exact internal artifact version: ${dependency}`,
        );
        await stage(dependency, range);
      }
    }
  }
  await check('packed-artifacts', async () => {
    await pack(join(workspace, 'packages/plugin'));
    await stage('@playstack/nest-billing');
  });
  await put(join(root, 'package.json'), {
    name: 'billing-template-consumer',
    private: true,
    type: 'commonjs',
    dependencies: {
      ...dependencies,
      nx: '23.1.1',
      '@nx/devkit': '23.1.1',
      '@nestjs/common': '11.1.17',
      '@nestjs/core': '11.1.17',
      '@nestjs/testing': '11.1.17',
      'reflect-metadata': '0.2.2',
      rxjs: '7.8.2',
      typescript: '6.0.3',
      '@types/node': '24.10.1',
      '@types/jest': '30.0.0',
      jest: '30.2.0',
    },
  });
  await check('install', () =>
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']),
  );
  await check('clean-install', () =>
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']),
  );
  const lock = await readFile(join(root, 'package-lock.json'));
  report.lockfileSha256 = digest(lock);
  await writeFile(join(reportRoot, 'package-lock.json'), lock);
  await put(join(root, 'nx.json'), {});
  await put(join(root, 'apps/api/project.json'), {
    name: 'api',
    projectType: 'application',
  });
  const consumerRequire = createRequire(join(root, 'package.json'));
  const nxManifest = consumerRequire.resolve('nx/package.json');
  const nxBinary = join(
    dirname(nxManifest),
    consumerRequire(nxManifest).bin.nx,
  );
  await check('emit', () =>
    run(process.execPath, [
      nxBinary,
      'generate',
      '@megamono/plugin:playstack-integrate',
      '--packages=@playstack/nest-billing',
      '--api=apps/api',
      '--persistence=application',
      '--adoptionMode=compare',
      '--conditions={"Stripe is selected":false}',
      '--decisions={"billing.priceCatalog":"fixture-plan-registry"}',
      '--yes',
      '--interactive=false',
    ]),
  );
  const plan = JSON.parse(
    await readFile(
      join(root, '.megamono/playstack-integration-plan.json'),
      'utf8',
    ),
  );
  const emitted = plan.files
    .map((file) => file.target)
    .filter((file) => /\.tsx?$/.test(file));
  assert(
    emitted.some((file) => file.endsWith('.spec.ts')),
    'Generated test must participate in compilation',
  );
  assert(
    emitted.some((file) => file.endsWith('.controller.ts')),
    'Generated controller missing',
  );
  report.emitted = await Promise.all(
    emitted.map(async (file) => ({
      file,
      sha256: digest(await readFile(join(root, file))),
    })),
  );
  await check('emitted-typecheck', async () => {
    const result = checkEmittedTypeScript(root, emitted);
    await put(join(reportRoot, 'diagnostics.json'), result);
    assert(result.passed, JSON.stringify(result.diagnostics, null, 2));
  });
  await put(join(root, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      skipLibCheck: true,
      types: ['node', 'jest'],
      outDir: 'compiled',
    },
    files: emitted,
  });
  await check('compile', () =>
    run(process.execPath, [
      join(root, 'node_modules/typescript/bin/tsc'),
      '-p',
      'tsconfig.json',
    ]),
  );
  await check('direct-controller-tests', () =>
    run(process.execPath, [
      join(root, 'node_modules/jest/bin/jest.js'),
      '--runInBand',
      '--config',
      JSON.stringify({
        rootDir: root,
        testMatch: ['<rootDir>/compiled/**/*.spec.js'],
        testEnvironment: 'node',
      }),
    ]),
  );
  report.status = 'passed-portable-checks';
} catch (error) {
  report.status = 'failed';
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const id of [
    'packed-artifacts',
    'install',
    'clean-install',
    'emit',
    'emitted-typecheck',
    'compile',
    'direct-controller-tests',
  ]) {
    if (!report.checks.some((check) => check.id === id))
      report.checks.push({ id, status: 'not-run' });
  }
  await put(join(reportRoot, 'report.json'), report);
  await rm(root, { recursive: true, force: true });
}
