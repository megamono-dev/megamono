import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const workspace = resolve(import.meta.dirname, '../../..');
const root = await mkdtemp(join(tmpdir(), 'megamono-prismark-consumer-'));
const reportRoot = join(workspace, 'tmp/prismark-consumer');
const env = {
  ...Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  ),
  CI: 'true',
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  NX_INTERACTIVE: 'false',
  npm_config_cache: join(root, '.npm-cache'),
  npm_config_userconfig: join(root, '.npmrc'),
};
const report = {
  schemaVersion: 1,
  fixture: 'prismark-shaped-megamono-consumer',
  scope:
    'Megamono packing, wiring, Nest/Prisma compilation and client import boundaries; synthetic Playstack contract, not Playstack runtime certification.',
  runtime: { node: process.version, platform: process.platform },
  checks: [],
};
const run = async (command, args, cwd = root) =>
  (
    await exec(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 8_000_000,
    })
  ).stdout;
const put = async (path, content) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(
    join(root, path),
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
};
const digest = (content) => createHash('sha256').update(content).digest('hex');
const check = async (id, environment, action) => {
  console.log(`Prismark consumer: ${id}`);
  try {
    const output = String((await action()) ?? '');
    await writeFile(join(reportRoot, `${id}.log`), output);
    report.checks.push({
      id,
      environment,
      status: 'passed',
      evidence: { path: `${id}.log`, sha256: digest(output) },
    });
  } catch (error) {
    const output = `${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    await writeFile(join(reportRoot, `${id}.log`), output);
    report.checks.push({
      id,
      environment,
      status: 'failed',
      evidence: { path: `${id}.log`, sha256: digest(output) },
    });
    throw error;
  }
};
try {
  await mkdir(reportRoot, { recursive: true });
  report.sourceRevision = (
    await run('git', ['rev-parse', 'HEAD'], workspace)
  ).trim();
  report.dirty = Boolean(
    (await run('git', ['status', '--porcelain'], workspace)).trim(),
  );
  await put('.npmrc', 'registry=https://registry.npmjs.org/\n');
  const packed = JSON.parse(
    await run('npm', [
      'pack',
      join(workspace, 'packages/plugin'),
      '--pack-destination',
      root,
      '--ignore-scripts',
      '--json',
    ]),
  )[0];
  report.pluginTarballSha256 = digest(
    await readFile(join(root, packed.filename)),
  );
  const fixture = 'contract-package';
  // This deliberately has separate server and browser entry points. It is not
  // an implementation of Playstack auth, native credential storage, or sync.
  await put(`${fixture}/package.json`, {
    name: '@playstack/prismark-fixture',
    version: '1.0.0',
    exports: {
      './package.json': './package.json',
      './client': { types: './client.d.ts', default: './client.js' },
      './server': './server.cjs',
    },
    peerDependencies: { '@nestjs/common': '^11.0.0' },
  });
  await put(
    `${fixture}/client.js`,
    "exports.contractVersion = 'fixture-v1';\n",
  );
  await put(
    `${fixture}/client.d.ts`,
    'export declare const contractVersion: string;\n',
  );
  await put(
    `${fixture}/server.cjs`,
    "exports.nonce = () => require('node:crypto').randomUUID();\n",
  );
  const template = `import { Module } from '@nestjs/common';
import { contractVersion } from '@playstack/prismark-fixture/client';
@Module({ providers: [{ provide: 'FIXTURE_CONTRACT', useValue: contractVersion }], exports: ['FIXTURE_CONTRACT'] })
export class PlatformModule {}
`;
  await put(`${fixture}/templates/platform.ts`, template);
  await put(`${fixture}/playstack.integration.json`, {
    version: 1,
    package: '@playstack/prismark-fixture',
    packageVersion: '1.0.0',
    integrations: [
      {
        id: 'platform',
        surface: 'api',
        framework: 'nest',
        requirements: {
          requiredTests: [{ id: 'composition', kind: 'integration' }],
        },
        templates: [
          {
            id: 'platform',
            kind: 'module',
            source: 'templates/platform.ts',
            target: 'src/platform.module.ts',
            ejectable: true,
            sha256: digest(template),
          },
        ],
      },
    ],
  });
  const contract = JSON.parse(
    await run('npm', [
      'pack',
      join(root, fixture),
      '--pack-destination',
      root,
      '--ignore-scripts',
      '--json',
    ]),
  )[0];
  await put('package.json', {
    name: 'prismark-shaped-consumer',
    private: true,
    dependencies: {
      '@playstack/prismark-fixture': `file:./${contract.filename}`,
      '@nestjs/common': '11.1.28',
      '@nestjs/core': '11.1.28',
      'reflect-metadata': '0.2.2',
      rxjs: '7.8.2',
      '@prisma/client': '7.9.1',
    },
    devDependencies: {
      '@megamono/plugin': `file:./${packed.filename}`,
      nx: '23.1.1',
      '@nx/devkit': '23.1.1',
      typescript: '5.9.3',
      '@types/node': '24.13.3',
      prisma: '7.9.1',
      esbuild: '0.25.12',
    },
  });
  await check('clean-install', 'clean-install', async () => {
    await run('npm', [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    const lock = await readFile(join(root, 'package-lock.json'));
    const output = await run('npm', [
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    assert.equal(
      digest(await readFile(join(root, 'package-lock.json'))),
      digest(lock),
    );
    await writeFile(join(reportRoot, 'package-lock.json'), lock);
    report.lockfileSha256 = digest(lock);
    report.runtime.versions = {};
    for (const name of [
      'nx',
      '@nestjs/common',
      '@nestjs/core',
      '@prisma/client',
      'prisma',
      'typescript',
      'esbuild',
    ]) {
      report.runtime.versions[name] = JSON.parse(
        await readFile(
          join(root, 'node_modules', name, 'package.json'),
          'utf8',
        ),
      ).version;
    }
    return output;
  });
  const bin = async (name, executable) => {
    const manifest = JSON.parse(
      await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'),
    );
    return join(
      root,
      'node_modules',
      name,
      typeof manifest.bin === 'string'
        ? manifest.bin
        : manifest.bin[executable],
    );
  };
  const nx = await bin('nx', 'nx');
  await put('nx.json', {});
  for (const name of ['api', 'desktop', 'mobile'])
    await put(`apps/${name}/project.json`, {
      name,
      projectType: 'application',
      targets: {},
    });
  await put(
    'apps/desktop/src-tauri/Cargo.toml',
    '[package]\nname = "prismark-fixture"\nversion = "0.0.0"\nedition = "2021"\n',
  );
  await put('apps/desktop/src-tauri/tauri.conf.json', {
    productName: 'Prismark Fixture',
    identifier: 'test.megamono.prismark-fixture',
    version: '0.0.0',
  });
  await put('apps/mobile/app.json', {
    expo: { name: 'Prismark Fixture', slug: 'prismark-fixture' },
  });
  const args = [
    nx,
    'generate',
    '@megamono/plugin:playstack-integrate',
    '--packages=@playstack/prismark-fixture',
    '--api=apps/api',
    '--yes',
    '--interactive=false',
  ];
  await check('packed-generation', 'unit', async () => {
    const before = await readFile(join(root, 'package-lock.json'));
    await run(process.execPath, [...args, '--dryRun']);
    await assert.rejects(
      readFile(join(root, 'apps/api/src/platform.module.ts')),
      { code: 'ENOENT' },
    );
    await run(process.execPath, args);
    const content = await readFile(
      join(root, 'apps/api/src/platform.module.ts'),
    );
    await run(process.execPath, args);
    assert.equal(
      digest(await readFile(join(root, 'apps/api/src/platform.module.ts'))),
      digest(content),
    );
    assert.equal(
      digest(await readFile(join(root, 'package-lock.json'))),
      digest(before),
    );
    const plan = JSON.parse(
      await readFile(
        join(root, '.megamono/playstack-integration-plan.json'),
        'utf8',
      ),
    );
    assert.deepEqual(
      plan.artifactProvenance['@playstack/prismark-fixture'].findings.filter(
        (finding) => finding.severity === 'error',
      ),
      [],
    );
    report.artifactProvenance = plan.artifactProvenance;
    return 'Dry-run was read-only; generated wiring reruns without installation or drift.';
  });
  await put(
    'libs/prisma/primary/prisma/schema.prisma',
    `generator client {
  provider = "prisma-client"
  output = "../src/generated"
  moduleFormat = "cjs"
}
datasource db {
  provider = "postgresql"
}
model Document {
  id String @id
  revision Int
}
`,
  );
  await put(
    'prisma.config.ts',
    "import { defineConfig } from 'prisma/config'; export default defineConfig({ schema: 'libs/prisma/primary/prisma', datasource: { url: 'postgresql://fixture:fixture@127.0.0.1:1/disposable' } });\n",
  );
  await check('prisma-schema-client', 'typecheck', async () => {
    const prisma = await bin('prisma', 'prisma');
    return (
      (await run(process.execPath, [prisma, 'validate'])) +
      (await run(process.execPath, [prisma, 'generate']))
    );
  });
  await put(
    'apps/api/src/main.ts',
    `import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PlatformModule } from './platform.module';
import type { PrismaClient } from '../../../libs/prisma/primary/src/generated/client';
export type Database = PrismaClient;
export async function verify() { const app = await NestFactory.createApplicationContext(PlatformModule, { logger: false }); try { if (app.get('FIXTURE_CONTRACT') !== 'fixture-v1') throw new Error('composition failed'); } finally { await app.close(); } }
`,
  );
  await put('tsconfig.json', {
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      outDir: 'build',
      rootDir: '.',
      strict: true,
      skipLibCheck: false,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
    include: ['apps/api/src/**/*.ts', 'libs/prisma/**/*.ts'],
  });
  // Relative source root deliberately spans application and independent Prisma context.
  await check('nest-prisma-types', 'typecheck', () =>
    run(process.execPath, [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--project',
      'tsconfig.json',
      '--extendedDiagnostics',
    ]),
  );
  await check('nest-composition', 'in-memory', () =>
    run(process.execPath, [
      '-e',
      "require('./build/apps/api/src/main.js').verify().catch(e => { console.error(e); process.exitCode = 1; });",
    ]),
  );
  for (const name of ['desktop', 'mobile'])
    await put(
      `apps/${name}/src/session.ts`,
      "import { contractVersion } from '@playstack/prismark-fixture/client'; export const sessionContract = contractVersion;\n",
    );
  await check('client-import-boundaries', 'browser-bundle', async () => {
    const esbuild = await bin('esbuild', 'esbuild');
    for (const name of ['desktop', 'mobile']) {
      await run(process.execPath, [
        esbuild,
        `apps/${name}/src/session.ts`,
        '--bundle',
        '--platform=browser',
        '--format=esm',
        `--metafile=${name}.meta.json`,
        `--outfile=build/${name}.mjs`,
      ]);
      const metadata = JSON.parse(
        await readFile(join(root, `${name}.meta.json`), 'utf8'),
      );
      assert.ok(
        Object.keys(metadata.inputs).every(
          (file) =>
            !file.includes('@nestjs/') &&
            !file.includes('@prisma/') &&
            !file.endsWith('server.cjs'),
        ),
      );
      await run(process.execPath, [
        '--input-type=module',
        '-e',
        `import { sessionContract } from './build/${name}.mjs'; if (sessionContract !== 'fixture-v1') throw new Error('client failed');`,
      ]);
    }
    await put(
      'apps/mobile/src/leak.ts',
      "import { nonce } from '@playstack/prismark-fixture/server'; console.log(nonce());\n",
    );
    await assert.rejects(
      run(process.execPath, [
        esbuild,
        'apps/mobile/src/leak.ts',
        '--bundle',
        '--platform=browser',
        '--outfile=build/leak.js',
      ]),
    );
    return 'Both client bundles pass; a deliberately imported Node-only server entry fails.';
  });
  await check('production-prune', 'clean-install', async () => {
    const output = await run('npm', [
      'prune',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]);
    await run(process.execPath, [
      '-e',
      "require('./build/apps/api/src/main.js').verify().catch(e => { console.error(e); process.exitCode = 1; });",
    ]);
    return output;
  });
} finally {
  for (const environment of [
    'real-database',
    'tauri-build',
    'expo-build',
    'native-device',
    'live-provider',
    'container',
  ])
    report.checks.push({
      id: environment,
      environment,
      status: 'not-run',
      reason:
        'Outside this portable Megamono fixture; requires a separately provisioned, reviewed qualification runner.',
    });
  report.result = report.checks.some((entry) => entry.status === 'failed')
    ? 'failed'
    : report.checks.some((entry) => entry.status === 'passed')
      ? 'partial'
      : 'not-run';
  await mkdir(reportRoot, { recursive: true });
  await writeFile(
    join(reportRoot, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `Qualification report: ${join(reportRoot, 'report.json')} (${report.result}; not production certification)`,
  );
  await rm(root, { recursive: true, force: true });
}
