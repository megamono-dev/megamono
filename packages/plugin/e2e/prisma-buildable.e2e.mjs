import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const workspace = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(workspace, 'package.json'));
const { createTreeWithEmptyWorkspace } = require('@nx/devkit/testing');
const { writeJson } = require('@nx/devkit');
const { databaseGenerator, DEFAULT_MEGAMONO_CONFIG } = require(
  join(workspace, 'packages/plugin/dist/index.js'),
);
const root = mkdtempSync(join(tmpdir(), 'megamono-prisma-build-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('NX_') && !key.includes('DATABASE_URL'),
  ),
);
Object.assign(env, {
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  npm_config_cache: join(root, '.npm-cache'),
});
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
try {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'megamono.json', DEFAULT_MEGAMONO_CONFIG);
  writeJson(tree, 'package.json', {
    name: 'fixture',
    private: true,
    packageManager: 'npm@11.11.0',
    workspaces: ['libs/prisma/*'],
    devDependencies: { nx: require('nx/package.json').version },
  });
  for (const [name, clientOutput] of [
    ['primary', 'src/generated'],
    ['custom', 'src/db/client'],
  ]) {
    await databaseGenerator(tree, {
      name,
      adapter: 'prisma',
      buildable: true,
      clientOutput,
      yes: true,
      interactive: false,
    });
    const schema = `libs/prisma/${name}/prisma/schema.prisma`;
    tree.write(
      schema,
      tree.read(schema, 'utf8') + '\nmodel Example {\n id Int @id\n}\n',
    );
  }
  for (const change of tree.listChanges()) {
    if (change.type === 'DELETE') continue;
    mkdirSync(dirname(join(root, change.path)), { recursive: true });
    writeFileSync(join(root, change.path), change.content);
  }
  console.log('Installing isolated Prisma build fixture dependencies...');
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  for (const [name, output] of [
    ['primary', 'src/generated'],
    ['custom', 'src/db/client'],
  ]) {
    const dbRoot = join(root, 'libs/prisma', name);
    run('npm', ['exec', 'nx', '--', 'run', `fixture-prisma-${name}:build`]);
    assert(existsSync(join(dbRoot, 'dist/index.d.ts')));
    const manifest = JSON.parse(
      readFileSync(join(dbRoot, 'package.json'), 'utf8'),
    );
    assert(
      run(process.execPath, [
        '--input-type=module',
        '-e',
        `import { PrismaClient } from '${manifest.name}'; if (typeof PrismaClient !== 'function') throw Error('missing client'); console.log('imported');`,
      ]).includes('imported'),
    );
    const [packed] = JSON.parse(
      run(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', root],
        dbRoot,
      ),
    );
    assert(packed.files.some((file) => file.path.endsWith('/client.js')));
    assert(packed.files.some((file) => file.path.endsWith('/client.d.ts')));
    const consumer = join(root, `consumer-${name}`);
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, 'package.json'),
      '{"private":true,"type":"module"}',
    );
    run(
      'npm',
      [
        'install',
        join(root, packed.filename),
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      consumer,
    );
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { PrismaClient } from '${manifest.name}'; if(typeof PrismaClient !== 'function') throw Error('bad packed export');`,
      ],
      consumer,
    );
    rmSync(join(dbRoot, output), { recursive: true });
    rmSync(join(dbRoot, 'dist'), { recursive: true });
    run('npm', ['exec', 'nx', '--', 'run', `fixture-prisma-${name}:build`]);
    assert(existsSync(join(dbRoot, output, 'client.ts')));
    assert(existsSync(join(dbRoot, 'dist/index.js')));
    console.log(
      `Prisma ${name}: generation, compilation, packed import, and cold-output rebuild passed.`,
    );
  }
} catch (error) {
  console.error(error.stdout?.toString(), error.stderr?.toString());
  throw error;
} finally {
  rmSync(root, { recursive: true, force: true });
}
