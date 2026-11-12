import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const workspace = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(workspace, 'package.json'));
const { createTreeWithEmptyWorkspace } = require('@nx/devkit/testing');
const { readJson, writeJson } = require('@nx/devkit');
const nxCli = resolve(
  dirname(require.resolve('nx/package.json')),
  require('nx/package.json').bin.nx,
);
const { libraryGenerator, DEFAULT_MEGAMONO_CONFIG } = require(
  join(workspace, 'packages/plugin/dist/index.js'),
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('NX_')),
);
Object.assign(env, { NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false' });

for (const mode of ['path-alias', 'solution', 'composite-path-alias']) {
  const solution = mode === 'solution';
  const root = mkdtempSync(join(tmpdir(), 'megamono-library-'));
  let failed = false;
  env.npm_config_cache = join(root, '.npm-cache');
  try {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'megamono.json', DEFAULT_MEGAMONO_CONFIG);
    if (solution) {
      writeJson(tree, 'package.json', {
        ...readJson(tree, 'package.json'),
        workspaces: ['packages/*'],
      });
      tree.write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    }
    if (solution || mode === 'composite-path-alias') {
      writeJson(tree, 'tsconfig.base.json', {
        compilerOptions: {
          composite: true,
          declaration: true,
          module: 'nodenext',
          target: 'es2022',
          skipLibCheck: true,
        },
      });
      writeJson(tree, 'tsconfig.json', {
        extends: './tsconfig.base.json',
        files: [],
        references: [],
      });
    }
    await libraryGenerator(tree, {
      name: 'sdk',
      scope: 'fixture',
      publishable: true,
      yes: true,
      skipInstall: true,
    });
    for (const change of tree.listChanges()) {
      if (change.type === 'DELETE') continue;
      const file = join(root, change.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, change.content);
    }
    symlinkSync(
      join(workspace, 'node_modules'),
      join(root, 'node_modules'),
      'dir',
    );
    execFileSync(process.execPath, [nxCli, 'run', 'fixture-sdk:build'], {
      cwd: root,
      env,
      stdio: 'pipe',
      timeout: 120000,
    });
    const packageRoot = solution ? 'packages/sdk' : 'dist/packages/sdk';
    const manifest = JSON.parse(
      readFileSync(join(root, packageRoot, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.private, false);
    assert.equal(manifest.publishConfig.access, 'restricted');
    const packed = JSON.parse(
      execFileSync(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', root],
        {
          cwd: join(root, packageRoot),
          env,
          encoding: 'utf8',
          timeout: 30000,
        },
      ),
    )[0];
    assert(packed.files.some((file) => file.path.endsWith('index.js')));
    assert(packed.files.some((file) => file.path.endsWith('index.d.ts')));
    const packedPaths = new Set(packed.files.map((file) => file.path));
    const entrypoints = (value) =>
      typeof value === 'string'
        ? [value]
        : value && typeof value === 'object'
          ? Object.values(value).flatMap(entrypoints)
          : [];
    for (const target of [
      manifest.main,
      manifest.module,
      manifest.types,
      ...entrypoints(manifest.exports),
    ].filter(Boolean)) {
      assert(
        packedPaths.has(target.replace(/^\.\//, '')),
        `Missing declared package entrypoint ${target} in ${mode} archive`,
      );
    }
    const extracted = join(root, 'packed');
    mkdirSync(extracted);
    execFileSync(
      'tar',
      ['-xzf', join(root, packed.filename), '-C', extracted],
      { env, stdio: 'pipe', timeout: 30000 },
    );
    const consumer = join(root, 'consumer');
    mkdirSync(join(consumer, 'node_modules/@fixture'), { recursive: true });
    symlinkSync(
      join(extracted, 'package'),
      join(consumer, 'node_modules/@fixture/sdk'),
      'dir',
    );
    if (manifest.type === 'module') {
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          "import { fixtureSdk } from '@fixture/sdk'; if (fixtureSdk() !== 'fixture-sdk') throw new Error('Packed SDK returned the wrong identifier');",
        ],
        { cwd: consumer, env, stdio: 'pipe', timeout: 30000 },
      );
    } else {
      const installed = createRequire(join(consumer, 'probe.cjs'))(
        '@fixture/sdk',
      );
      assert.equal(installed.fixtureSdk(), 'fixture-sdk');
    }
    console.log(`Library build and pack passed: ${mode}`);
  } catch (error) {
    failed = true;
    console.error(`Library fixture: ${root}`);
    console.error(error.stdout?.toString(), error.stderr?.toString());
    throw error;
  } finally {
    if (!failed || process.env.MEGAMONO_KEEP_LIBRARY_FIXTURE !== 'true')
      rmSync(root, { recursive: true, force: true });
  }
}
