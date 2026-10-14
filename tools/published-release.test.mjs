import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePublishedPackage } from './check-published-release.mjs';

const fixture = (overrides = {}) => ({
  manifest: {
    name: '@megamono/cli',
    version: '0.1.0-next.0',
    exports: {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    },
    bin: { megamono: './dist/cli.js' },
    generators: './generators.json',
  },
  published: {
    name: '@megamono/cli',
    version: '0.1.0-next.0',
    gitHead: 'a'.repeat(40),
  },
  distTags: { next: '0.1.0-next.0' },
  channel: 'next',
  revision: 'a'.repeat(40),
  files: new Set([
    'dist/index.js',
    'dist/index.d.ts',
    'dist/cli.js',
    'generators.json',
  ]),
  ...overrides,
});

test('accepts the exact published release and its packaged exports', () => {
  assert.doesNotThrow(() => validatePublishedPackage(fixture()));
});

test('rejects missing or stale registry versions and source revisions', () => {
  for (const published of [
    undefined,
    {},
    { ...fixture().published, version: '0.1.0-next.1' },
    { ...fixture().published, gitHead: 'b'.repeat(40) },
  ])
    assert.throws(() => validatePublishedPackage(fixture({ published })));
});

test('rejects a stale next tag or a prerelease exposed through latest', () => {
  assert.throws(
    () =>
      validatePublishedPackage(fixture({ distTags: { next: '0.1.0-next.1' } })),
    /next does not point/,
  );
  assert.throws(
    () =>
      validatePublishedPackage(
        fixture({ distTags: { next: '0.1.0-next.0', latest: '0.1.0-next.0' } }),
      ),
    /must not be assigned to latest/,
  );
});

test('requires conditional exports, declarations, CLI bins, and collections in the registry tarball', () => {
  for (const path of fixture().files) {
    const files = new Set(fixture().files);
    files.delete(path);
    assert.throws(
      () => validatePublishedPackage(fixture({ files })),
      /tarball is missing/,
    );
  }
});

test('supports independently versioned create-megamono releases', () => {
  assert.doesNotThrow(() =>
    validatePublishedPackage(
      fixture({
        manifest: {
          name: 'create-megamono',
          version: '0.2.0-next.3',
          bin: './dist/cli.js',
        },
        published: {
          name: 'create-megamono',
          version: '0.2.0-next.3',
          gitHead: 'a'.repeat(40),
        },
        distTags: { next: '0.2.0-next.3' },
      }),
    ),
  );
});

test('also validates registry entry points with npm-normalized relative paths', () => {
  assert.doesNotThrow(() =>
    validatePublishedPackage(
      fixture({
        published: { ...fixture().published, bin: { megamono: 'dist/cli.js' } },
      }),
    ),
  );
  assert.throws(
    () =>
      validatePublishedPackage(
        fixture({
          published: {
            ...fixture().published,
            bin: { megamono: 'dist/missing-cli.js' },
          },
        }),
      ),
    /tarball is missing/,
  );
});

test('checks the latest tag for stable publications', () => {
  assert.doesNotThrow(() =>
    validatePublishedPackage(
      fixture({
        manifest: { ...fixture().manifest, version: '0.1.0' },
        published: { ...fixture().published, version: '0.1.0' },
        distTags: { next: '0.1.0-next.0', latest: '0.1.0' },
        channel: 'latest',
      }),
    ),
  );
});
