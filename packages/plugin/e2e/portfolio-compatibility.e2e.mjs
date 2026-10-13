import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(
  fileURLToPath(new URL('../../..', import.meta.url)),
);
const temporaryRoot = mkdtempSync(join(tmpdir(), 'megamono-portfolio-'));
const fixtureRoot = join(temporaryRoot, 'quickzones-shaped');
const toolRoot = join(temporaryRoot, 'tools');
mkdirSync(fixtureRoot, { recursive: true });
mkdirSync(toolRoot, { recursive: true });
const pnpmWrapper = join(toolRoot, 'pnpm');
writeFileSync(pnpmWrapper, '#!/bin/sh\nexec corepack pnpm "$@"\n');
chmodSync(pnpmWrapper, 0o755);
// This fixture verifies graph/adoption behavior on Linux, not native execution.
const xcodeFixture = join(toolRoot, 'xcodebuild');
writeFileSync(
  xcodeFixture,
  '#!/usr/bin/env node\nthrow new Error("Native Xcode execution is outside the portfolio compatibility fixture.");\n',
);
chmodSync(xcodeFixture, 0o755);

function run(command, args, cwd = fixtureRoot, environment = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: 'true',
      NX_DAEMON: 'false',
      NX_INTERACTIVE: 'false',
      npm_config_cache:
        process.env.MEGAMONO_NPM_CACHE ?? join(temporaryRoot, 'npm-cache'),
      PNPM_HOME: process.env.PNPM_HOME ?? join(temporaryRoot, 'pnpm-home'),
      PATH: `${toolRoot}:${process.env.PATH ?? ''}`,
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(path, source) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, source);
}

function writeJson(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function unchanged(path, source, label = path) {
  assert(
    readFileSync(path, 'utf8') === source,
    `${label} was changed during adoption.`,
  );
}

try {
  console.error('Packing Megamono packages for the portfolio fixture...');
  const packages = Object.fromEntries(
    [
      ['@megamono/plugin', 'packages/plugin'],
      ['@megamono/nx-apple', 'packages/nx-apple'],
      ['@megamono/nx-cargo', 'packages/nx-cargo'],
      ['@megamono/nx-cloudflare', 'packages/nx-cloudflare'],
      ['@megamono/nx-extension', 'packages/nx-extension'],
      ['@megamono/nx-render', 'packages/nx-render'],
    ].map(([name, directory]) => {
      const packed = JSON.parse(
        run(
          'npm',
          [
            'pack',
            resolve(workspaceRoot, directory),
            '--pack-destination',
            fixtureRoot,
            '--json',
          ],
          workspaceRoot,
        ),
      )[0]?.filename;
      assert(packed, `npm pack did not report the ${name} archive.`);
      return [name, `file:./${basename(packed)}`];
    }),
  );

  writeJson(join(fixtureRoot, 'package.json'), {
    name: '@portfolio/workspace',
    version: '0.0.0',
    private: true,
    packageManager: 'pnpm@11.24.0',
    engines: { node: '>=22 <25' },
    scripts: {
      'prisma:generate': 'prisma generate --schema prisma/schema.prisma',
    },
    dependencies: { '@prisma/client': '6.19.1' },
    devDependencies: {
      ...packages,
      '@nx/devkit': '22.2.3',
      nx: '22.2.3',
      prisma: '6.19.1',
      typescript: '5.9.3',
    },
  });
  write(
    join(fixtureRoot, '.gitignore'),
    'node_modules/\n.nx/\n*.tgz\n.content-collections/\nbasemarks-swift/.build/\n',
  );
  write(
    join(fixtureRoot, 'pnpm-workspace.yaml'),
    "packages:\n  - 'apps/*'\n  - 'libs/*'\n  - 'prisma'\n",
  );
  writeJson(join(fixtureRoot, 'nx.json'), {
    plugins: [
      {
        plugin: '@megamono/nx-apple',
        options: {
          scope: 'portfolio',
          targets: {
            'archive-direct': {
              action: 'archive',
              scheme: 'Quickzones Mac Direct',
            },
            'archive-app-store': {
              action: 'archive',
              scheme: 'Quickzones Mac App Store',
            },
            'test-performance': {
              action: 'test',
              scheme: 'Quickzones Performance',
            },
            'build-ios': { action: 'build', scheme: 'Quickzones' },
          },
        },
      },
      '@megamono/nx-cargo',
      '@megamono/nx-cloudflare',
      '@megamono/nx-extension',
      '@megamono/nx-render',
    ],
  });
  writeJson(join(fixtureRoot, 'tsconfig.base.json'), {
    compilerOptions: {
      paths: {
        'content-collections': ['apps/site/.content-collections/generated'],
      },
    },
  });

  writeJson(join(fixtureRoot, 'apps/site/project.json'), {
    name: '@portfolio/site',
    root: 'apps/site',
    targets: {
      dev: {
        executor: 'nx:run-commands',
        options: { command: 'next dev -p 4200' },
      },
    },
  });
  write(
    join(fixtureRoot, 'apps/site/next.config.js'),
    'module.exports = {};\n',
  );
  write(
    join(fixtureRoot, 'apps/site/content-collections.ts'),
    'export default {};\n',
  );
  writeJson(join(fixtureRoot, 'apps/extension/package.json'), {
    name: '@portfolio/extension',
    private: true,
  });
  write(
    join(fixtureRoot, 'apps/extension/wxt.config.ts'),
    'export default {};\n',
  );
  writeJson(join(fixtureRoot, 'apps/api/project.json'), {
    name: '@portfolio/api',
    root: 'apps/api',
    projectType: 'application',
    targets: {
      serve: {
        executor: 'nx:run-commands',
        options: { command: 'node dist/main.js' },
      },
    },
  });
  write(join(fixtureRoot, 'apps/api/tsconfig.app.json'), '{}\n');
  writeJson(join(fixtureRoot, 'apps/mobile-app/project.json'), {
    name: '@portfolio/mobile-app',
    root: 'apps/mobile-app',
    projectType: 'application',
    targets: {
      build: {
        executor: 'nx:run-commands',
        options: { command: 'pnpm exec expo export -p ios' },
      },
    },
  });
  writeJson(join(fixtureRoot, 'apps/mobile-app/package.json'), {
    name: '@portfolio/mobile-app',
    private: true,
  });
  writeJson(join(fixtureRoot, 'apps/mobile-app/app.json'), { expo: {} });
  writeJson(join(fixtureRoot, '.megamono-adoption.json'), {
    projects: {
      '@portfolio/extension': { type: 'app', platform: 'extension' },
    },
  });
  writeJson(join(fixtureRoot, 'libs/nest-data/project.json'), {
    name: '@portfolio/nest-data',
    root: 'libs/nest-data',
    targets: { build: { executor: 'nx:noop' } },
  });
  write(join(fixtureRoot, 'libs/nest-data/tsconfig.lib.json'), '{}\n');

  const prismaSchema = [
    'generator client {',
    '  provider = "prisma-client-js"',
    '}',
    '',
    'datasource db {',
    '  provider = "postgresql"',
    '  url      = env("DATABASE_URL")',
    '}',
    '',
    'model User {',
    '  id String @id',
    '}',
    '',
  ].join('\n');
  const migration = '-- repository-owned migration\nSELECT 1;\n';
  const dockerfile = 'RUN pnpm prisma:generate\nCMD ["node", "main.js"]\n';
  write(join(fixtureRoot, 'prisma/schema.prisma'), prismaSchema);
  write(
    join(fixtureRoot, 'prisma/migrations/20260830_init/migration.sql'),
    migration,
  );
  write(join(fixtureRoot, 'apps/api/Dockerfile'), dockerfile);

  write(
    join(fixtureRoot, 'apps/apple/QuickzonesKit/Package.swift'),
    [
      '// swift-tools-version: 6.0',
      'import PackageDescription',
      '',
      'let package = Package(name: "QuickzonesKit")',
      '',
    ].join('\n'),
  );
  write(
    join(fixtureRoot, 'apps/apple/Quickzones.xcodeproj/project.pbxproj'),
    'isa = PBXProject;\n',
  );
  for (const scheme of [
    'Quickzones Mac Direct',
    'Quickzones Mac App Store',
    'Quickzones Performance',
    'Quickzones',
  ]) {
    write(
      join(
        fixtureRoot,
        `apps/apple/Quickzones.xcodeproj/xcshareddata/xcschemes/${scheme}.xcscheme`,
      ),
      '<Scheme />\n',
    );
  }
  const ci =
    'jobs:\n  verify:\n    steps:\n      - run: pnpm exec nx run-many -t lint test build\n';
  const release =
    'jobs:\n  release:\n    steps:\n      - run: xcodebuild -scheme "Quickzones Mac App Store"\n';
  write(join(fixtureRoot, '.github/workflows/ci.yml'), ci);
  write(join(fixtureRoot, '.github/workflows/release-apple.yml'), release);
  for (const name of ['00-overview', '01-mac-app', '02-zones-model'])
    write(join(fixtureRoot, `docs/specs/${name}.md`), `# ${name}\n`);
  write(
    join(fixtureRoot, 'basemarks-swift/.build/checkouts/dependency/README.md'),
    '# Generated dependency documentation\n',
  );

  console.error('Installing the packed Nx 22 / pnpm 11 consumer...');
  run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile']);

  const init = [
    'exec',
    'nx',
    'generate',
    '@megamono/plugin:workspace-init',
    '--only=docs,lint,inference',
    '--docsLoader=.megamono/content-collections.ts',
    '--docsModule=megamono-docs',
    '--docsOutput=.megamono/content-collections',
    '--adoptionMap=.megamono-adoption.json',
    '--packageManager=pnpm',
    '--interactive=false',
    '--yes',
    '--bootstrap',
  ];
  console.error('Surveying and adopting the mixed-platform workspace...');
  const survey = run('pnpm', [
    'exec',
    'nx',
    'generate',
    '@megamono/plugin:workspace-init',
    '--survey',
    '--format=json',
  ]);
  assert(
    survey.includes('"ready": true'),
    'Survey did not report a ready active host.',
  );
  assert(
    survey.includes('"@portfolio/nest-data"') &&
      survey.includes('"type": "library"'),
    'Survey did not classify the inferred library.',
  );
  assert(
    survey.includes('"@portfolio/mobile-app"') &&
      survey.includes('"platform": "mobile"'),
    'Survey did not classify the Expo application as mobile.',
  );
  assert(
    !survey.includes('basemarks-swift/.build'),
    'Survey included ignored Swift build output.',
  );
  assert(
    survey.includes('"adoptionTemplates"') &&
      survey.includes('spec-portfolio-0001'),
    'Survey did not emit copy-ready adoption templates.',
  );

  console.error('Verifying partial agents and skills adoption...');
  run('pnpm', [
    'exec',
    'nx',
    'generate',
    '@megamono/plugin:workspace-init',
    '--only=agents,skills',
    '--packageManager=pnpm',
    '--interactive=false',
    '--yes',
    '--bootstrap',
  ]);
  const agentInstructions = readFileSync(
    join(fixtureRoot, 'AGENTS.md'),
    'utf8',
  );
  assert(
    agentInstructions.includes('docs/DESIGN.md') &&
      !agentInstructions.includes('docs/INDEX.md'),
    'Agents-only adoption referenced documentation that was not adopted.',
  );
  run(
    'pnpm',
    ['exec', 'nx', 'run', 'megamono:check', '--output-style=static'],
    fixtureRoot,
    { CI: 'false' },
  );

  run('pnpm', init);
  const firstConfig = readFileSync(join(fixtureRoot, 'megamono.json'), 'utf8');
  run('pnpm', init);
  unchanged(join(fixtureRoot, 'megamono.json'), firstConfig, 'megamono.json');

  run('git', ['init', '--initial-branch=main']);
  run('git', ['config', 'user.email', 'portfolio-fixture@megamono.invalid']);
  run('git', ['config', 'user.name', 'Megamono Portfolio Fixture']);
  run('git', ['add', '.']);
  run('git', [
    'commit',
    '--quiet',
    '-m',
    'fixture: establish mature workspace',
  ]);
  run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  run('git', [
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  ]);
  run('git', ['checkout', '-b', 'test/megamono-adoption']);

  console.error('Adopting the repository-owned root Prisma layout...');
  run('pnpm', [
    'exec',
    'nx',
    'generate',
    '@megamono/plugin:database',
    '--name=primary',
    '--adapter=prisma',
    '--interactive=false',
    '--yes',
  ]);

  unchanged(
    join(fixtureRoot, 'prisma/schema.prisma'),
    prismaSchema,
    'Prisma schema',
  );
  unchanged(
    join(fixtureRoot, 'prisma/migrations/20260830_init/migration.sql'),
    migration,
    'Prisma migration history',
  );
  unchanged(
    join(fixtureRoot, 'apps/api/Dockerfile'),
    dockerfile,
    'API Dockerfile',
  );
  unchanged(
    join(fixtureRoot, '.github/workflows/ci.yml'),
    ci,
    'mature CI workflow',
  );
  unchanged(
    join(fixtureRoot, '.github/workflows/release-apple.yml'),
    release,
    'Apple release workflow',
  );
  assert(
    !readFileSync(join(fixtureRoot, 'tsconfig.base.json'), 'utf8').includes(
      '"content-collections": [\n        ".megamono',
    ),
    'Repository docs replaced the application Content Collections alias.',
  );
  const megamono = JSON.parse(
    readFileSync(join(fixtureRoot, 'megamono.json'), 'utf8'),
  );
  assert(
    megamono.databases?.primary?.schema === 'prisma/schema.prisma',
    `Root Prisma adoption was not recorded: ${JSON.stringify(megamono.databases)}.`,
  );
  assert(
    existsSync(join(fixtureRoot, 'prisma/project.json')) &&
      !existsSync(join(fixtureRoot, 'libs/prisma/primary')),
    'Root Prisma adoption introduced a replacement database project.',
  );
  assert(
    !readFileSync(join(fixtureRoot, 'pnpm-lock.yaml'), 'utf8').includes(
      '@prisma/client@7',
    ),
    'Root Prisma adoption changed the installed Prisma major.',
  );
  let playstackExists = true;
  try {
    readFileSync(join(fixtureRoot, 'playstack.json'));
  } catch {
    playstackExists = false;
  }
  assert(
    !playstackExists,
    'Root Prisma adoption enabled Playstack artifacts implicitly.',
  );

  console.error(
    'Verifying named Apple targets and preserved repository surfaces...',
  );
  const apple = JSON.parse(
    run('pnpm', ['exec', 'nx', 'show', 'project', 'Quickzones', '--json']),
  );
  for (const target of [
    'archive-direct',
    'archive-app-store',
    'test-performance',
    'build-ios',
  ]) {
    assert(
      apple.targets[target],
      `Apple named target ${target} was not inferred.`,
    );
  }
  const extension = JSON.parse(
    run('pnpm', [
      'exec',
      'nx',
      'show',
      'project',
      '@portfolio/extension',
      '--json',
    ]),
  );
  assert(
    extension.targets['build-chrome'] &&
      extension.targets['build-firefox'] &&
      extension.targets['package-firefox-source'],
    'WXT browser-specific build and package targets were not inferred.',
  );
  assert(
    !extension.targets.deploy,
    'WXT deploy target was inferred without repository-owned store commands.',
  );

  console.log(
    `Verified the packed mixed-platform adoption portfolio with Node ${process.versions.node}, Nx 22.2.3, TypeScript 5.9.3, and pnpm 11.24.0.`,
  );
} catch (error) {
  const stdout = error?.stdout?.toString().trim();
  const stderr = error?.stderr?.toString().trim();
  if (stdout) console.error(stdout);
  if (stderr) console.error(stderr);
  throw error;
} finally {
  const expectedPrefix = join(tmpdir(), 'megamono-portfolio-');
  if (!temporaryRoot.startsWith(expectedPrefix)) {
    console.error(
      `Refusing to remove unexpected fixture path ${temporaryRoot}.`,
    );
    process.exitCode = 1;
  } else if (process.env.MEGAMONO_KEEP_FIXTURE === 'true') {
    console.error(`Retained portfolio fixture at ${fixtureRoot}`);
    process.exitCode = 1;
  } else {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
