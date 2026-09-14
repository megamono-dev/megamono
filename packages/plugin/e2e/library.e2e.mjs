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

for (const solution of [false, true]) {
  const root = mkdtempSync(join(tmpdir(), 'megamono-library-'));
  env.npm_config_cache = join(root, '.npm-cache');
  try {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'megamono.json', DEFAULT_MEGAMONO_CONFIG);
    if (solution) {
      writeJson(tree, 'package.json', {
        ...readJson(tree, 'package.json'),
        workspaces: ['packages/*'],
      });
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
      execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
        cwd: join(root, packageRoot),
        env,
        encoding: 'utf8',
        timeout: 30000,
      }),
    )[0];
    assert(packed.files.some((file) => file.path.endsWith('index.js')));
    assert(packed.files.some((file) => file.path.endsWith('index.d.ts')));
    console.log(
      `Library build and pack passed: ${solution ? 'TypeScript solution' : 'path-alias workspace'}`,
    );
  } catch (error) {
    console.error(error.stdout?.toString(), error.stderr?.toString());
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
