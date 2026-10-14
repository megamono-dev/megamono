import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('..', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'megamono-release-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tools'));
  copyFileSync(
    join(workspace, 'tools/check-release-policy.mjs'),
    join(root, 'tools/check-release-policy.mjs'),
  );
  copyFileSync(join(workspace, 'nx.json'), join(root, 'nx.json'));
  for (const name of readdirSync(join(workspace, 'packages'))) {
    const directory = join('packages', name);
    const manifest = JSON.parse(
      readFileSync(join(workspace, directory, 'package.json'), 'utf8'),
    );
    if (manifest.publishConfig?.access !== 'public') continue;
    mkdirSync(join(root, directory), { recursive: true });
    for (const file of ['package.json', 'LICENSE', 'README.md']) {
      copyFileSync(
        join(workspace, directory, file),
        join(root, directory, file),
      );
    }
  }
  return root;
}

function check(root) {
  return spawnSync(
    process.execPath,
    [join(root, 'tools/check-release-policy.mjs')],
    {
      encoding: 'utf8',
    },
  );
}

test('accepts the current ten-package release inventory and listing metadata', (t) => {
  const result = check(fixture(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /all 10 Megamono packages/);
});

test('rejects invalid listing metadata on packages added after the original PR', (t) => {
  const root = fixture(t);
  const path = join(root, 'packages/nx-extension/package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(manifest, {
    license: 'UNLICENSED',
    description: ' ',
    homepage: null,
    author: '',
    bugs: {},
    keywords: ['nx', ' '],
  });
  writeFileSync(path, JSON.stringify(manifest));
  const result = check(root);
  assert.equal(result.status, 1);
  for (const field of [
    'license',
    'description',
    'homepage',
    'author',
    'bugs.url',
    'keywords',
  ]) {
    assert.ok(
      result.stderr.includes(`@megamono/nx-extension: ${field}`),
      result.stderr,
    );
  }
});

test('rejects missing package documentation and license files together', (t) => {
  const root = fixture(t);
  rmSync(join(root, 'packages/create-megamono/README.md'));
  rmSync(join(root, 'packages/nx-phpnative/LICENSE'));
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /create-megamono: README.md is missing/);
  assert.match(result.stderr, /@megamono\/nx-phpnative: LICENSE is missing/);
});

test('rejects empty package documentation even when the file exists', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'packages/nx-render/README.md'), '\n');
  const result = check(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /@megamono\/nx-render: README.md must not be empty/,
  );
});
