import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import {
  createToolingLayout,
  readToolingLock,
  verifyToolingLock,
} from './tooling-lock.mjs';

function put(root, path, value) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

test('pnpm inventory retains peer snapshots and checks exact package integrity', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'megamono-tooling-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const expected = {
    name: 'consumer',
    version: '1.0.0',
    tarballIntegrity: 'sha512-reviewed',
  };
  put(
    root,
    'pnpm-lock.yaml',
    stringify({
      lockfileVersion: '9.0',
      packages: {
        'consumer@1.0.0': {
          resolution: { integrity: expected.tarballIntegrity },
        },
      },
      snapshots: { 'consumer@1.0.0(peer@1)': {}, 'consumer@1.0.0(peer@2)': {} },
    }),
  );
  for (const peer of ['1', '2'])
    put(
      root,
      `node_modules/.pnpm/consumer@1.0.0_peer@${peer}/node_modules/consumer/package.json`,
      { name: 'consumer', version: '1.0.0' },
    );
  symlinkSync(
    '.pnpm/consumer@1.0.0_peer@1/node_modules/consumer',
    join(root, 'node_modules/consumer'),
    'dir',
  );
  const lock = readToolingLock(root);
  const layout = createToolingLayout(root, lock);
  assert.equal(lock.entries.length, 2);
  assert.equal(layout.packageRoots('consumer').length, 2);
  for (const path of layout.packageRoots('consumer'))
    assert.equal(
      verifyToolingLock(
        lock,
        layout.artifact(join(path, 'package.json')),
        expected,
      ).length,
      2,
    );
  assert.throws(
    () =>
      verifyToolingLock(
        lock,
        join(layout.packageRoots('consumer')[0], 'package.json'),
        { ...expected, tarballIntegrity: 'sha512-changed' },
      ),
    /Unreviewed locked/,
  );
});

test('lock escapes, external managed links and symlinked files fail closed', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'megamono-tooling-escape-'));
  const outside = mkdtempSync(join(tmpdir(), 'megamono-tooling-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  put(root, 'package-lock.json', {
    packages: { '../outside': { version: '1' } },
  });
  assert.throws(() => readToolingLock(root), /escaped tooling lock path/);
  rmSync(join(root, 'package-lock.json'));
  put(
    root,
    'pnpm-lock.yaml',
    stringify({
      packages: { 'consumer@1.0.0': {} },
      snapshots: { 'consumer@1.0.0': {} },
    }),
  );
  mkdirSync(join(root, 'node_modules/.pnpm'), { recursive: true });
  put(outside, 'package.json', { name: 'consumer', version: '1.0.0' });
  symlinkSync(outside, join(root, 'node_modules/consumer'), 'dir');
  const layout = createToolingLayout(root);
  assert.throws(
    () => layout.packageRoots('consumer'),
    /external or symlinked tooling path/,
  );
  rmSync(join(root, 'node_modules/consumer'));
  symlinkSync(
    join(outside, 'missing-package'),
    join(root, 'node_modules/consumer'),
    'dir',
  );
  assert.throws(() => layout.packageRoots('consumer'), { code: 'ENOENT' });
  rmSync(join(root, 'node_modules/consumer'));
  const manifest =
    'node_modules/.pnpm/consumer@1.0.0/node_modules/consumer/package.json';
  put(root, manifest, '{}');
  rmSync(join(root, manifest));
  symlinkSync(join(outside, 'package.json'), join(root, manifest));
  assert.throws(
    () => layout.artifact(join(root, manifest)),
    /external or symlinked tooling path/,
  );
  assert.equal(
    JSON.parse(readFileSync(join(outside, 'package.json'))).name,
    'consumer',
  );
});
