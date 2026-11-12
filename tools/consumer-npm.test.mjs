import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { resolveConsumerNpmCli } from './consumer-npm.mjs';

function fixture(t) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'megamono npm & space-')),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '/* fixture CLI: never executed */');
    return file;
  };
  return { root, put };
}

test('an inherited pnpm CLI cannot become the npm consumer command', (t) => {
  const { root, put } = fixture(t);
  const pnpm = put('pnpm/bin/pnpm.mjs');
  const npm = put('bin/node_modules/npm/bin/npm-cli.js');
  assert.equal(
    resolveConsumerNpmCli({
      env: { npm_execpath: pnpm, PATH: join(root, 'bin') },
      execPath: join(root, 'missing/node'),
    }),
    npm,
  );
});

test('npm parents retain their exact CLI rather than another installation', (t) => {
  const { root, put } = fixture(t);
  const inherited = put('qualified/npm-cli.js');
  put('bin/node_modules/npm/bin/npm-cli.js');
  assert.equal(
    resolveConsumerNpmCli({
      env: { npm_execpath: inherited, PATH: join(root, 'bin') },
    }),
    inherited,
  );
});

test('a POSIX npm symlink resolves without invoking a shell', (t) => {
  const { root, put } = fixture(t);
  const npm = put('npm/bin/npm-cli.js');
  mkdirSync(join(root, 'bin'));
  symlinkSync(npm, join(root, 'bin/npm'));
  assert.equal(
    resolveConsumerNpmCli({ env: { PATH: join(root, 'bin') } }),
    npm,
  );
});

test('Windows PATH and Node-adjacent npm layouts work with spaces', (t) => {
  const { root, put } = fixture(t);
  const npm = put('Node tools/node_modules/npm/bin/npm-cli.js');
  assert.equal(
    resolveConsumerNpmCli({
      env: { Path: `${join(root, 'missing')};${join(root, 'Node tools')}` },
      platform: 'win32',
    }),
    npm,
  );
  assert.equal(
    resolveConsumerNpmCli({
      env: {},
      execPath: join(root, 'Node tools/node.exe'),
      platform: 'win32',
    }),
    npm,
  );
});

test('missing npm fails explicitly instead of falling back to pnpm', (t) => {
  const { root, put } = fixture(t);
  assert.throws(
    () =>
      resolveConsumerNpmCli({
        env: { npm_execpath: put('pnpm/pnpm.mjs'), PATH: '' },
        execPath: join(root, 'missing/node'),
      }),
    /requires an installed npm CLI/,
  );
});
