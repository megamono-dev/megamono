import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const workspace = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(workspace, 'package.json'));
const root = mkdtempSync(join(tmpdir(), 'megamono-inferred-target-'));
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('NX_')),
);
Object.assign(env, { NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false' });
const put = (path, content) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(
    join(root, path),
    typeof content === 'string' ? content : JSON.stringify(content),
  );
};
try {
  put('package.json', {
    name: 'inferred-target-fixture',
    private: true,
    devDependencies: {
      jest: require('jest/package.json').version,
      '@nx/jest': require('@nx/jest/package.json').version,
      nx: require('nx/package.json').version,
    },
  });
  put('nx.json', {
    plugins: [{ plugin: '@nx/jest/plugin', options: { targetName: 'test' } }],
  });
  put('package-lock.json', {
    name: 'inferred-target-fixture',
    lockfileVersion: 3,
    requires: true,
    packages: Object.fromEntries(
      ['jest', '@nx/jest', 'nx'].map((name) => [
        `node_modules/${name}`,
        { version: require(`${name}/package.json`).version, dev: true },
      ]),
    ),
  });
  put('libs/mail/project.json', { name: 'mail', projectType: 'library' });
  put(
    'libs/mail/jest.config.cjs',
    "module.exports = { displayName: 'mail', testEnvironment: 'node', watchman: false, maxWorkers: 1, testMatch: ['<rootDir>/*.spec.js'] };\n",
  );
  put(
    'libs/mail/mail.spec.js',
    "test('synthetic contract', () => expect(1).toBe(1));\n",
  );
  symlinkSync(
    join(workspace, 'node_modules'),
    join(root, 'node_modules'),
    'dir',
  );
  const nxCli = resolve(
    dirname(require.resolve('nx/package.json')),
    require('nx/package.json').bin.nx,
  );
  execFileSync(process.execPath, [nxCli, 'run', 'mail:test'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60000,
    stdio: 'pipe',
  });
  const result = execFileSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const { FsTree } = require('nx/src/generators/tree');
    const { getProjects, updateProjectConfiguration } = require('@nx/devkit');
    const { resolvedProjects } = require(${JSON.stringify(join(workspace, 'packages/plugin/dist/lib/resolved-projects.js'))});
    (async () => {
      const tree = new FsTree(process.cwd(), false);
      assert.equal(getProjects(tree).get('mail').targets?.test, undefined);
      const inferred = (await resolvedProjects(tree)).get('mail');
      assert(inferred.targets.test);
      assert.equal(inferred.targets.test.cache, true);
      const original = getProjects(tree).get('mail');
      updateProjectConfiguration(tree, 'mail', { ...original, targets: { test: { cache: false } } });
      const overridden = (await resolvedProjects(tree)).get('mail');
      assert.equal(overridden.targets.test.cache, false);
      assert(overridden.targets.test.command || overridden.targets.test.executor);
      assert.deepEqual(getProjects(tree).get('mail').targets.test, { cache: false });
      console.log('Inferred Jest target executes and resolves; explicit cache policy wins without persisting inference.');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    { cwd: root, env, encoding: 'utf8', timeout: 60000 },
  );
  assert(result.includes('Inferred Jest target executes'));
  console.log(result);
} catch (error) {
  console.error(error.stdout?.toString(), error.stderr?.toString());
  throw error;
} finally {
  rmSync(root, { recursive: true, force: true });
}
