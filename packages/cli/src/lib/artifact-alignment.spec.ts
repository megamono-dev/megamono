import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it, expect } from 'vitest';
import { archiveFiles, verifyArtifactAlignment } from './artifact-alignment.js';
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const put = (root: string, file: string, bytes: string | Buffer) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), bytes);
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'alignment-'));
  roots.push(root);
  put(root, 'package.json', '{}');
  for (const dir of [
    '.yalc/@megamono/plugin',
    'node_modules/@megamono/plugin',
  ]) {
    put(
      root,
      `${dir}/package.json`,
      JSON.stringify({
        name: '@megamono/plugin',
        version: '0.0.1',
        main: './dist/index.js',
      }),
    );
    put(root, `${dir}/dist/index.js`, 'throw Error("must not execute");');
  }
  select(root, '.yalc/@megamono/plugin');
  return root;
}
function select(root: string, from: string, extra = {}) {
  put(
    root,
    '.megamono/qualification-artifacts.json',
    JSON.stringify({
      version: 1,
      artifacts: [{ package: '@megamono/plugin', from, ...extra }],
    }),
  );
}
function archive(entries: [string, Buffer, string?][]) {
  return gzipSync(
    Buffer.concat([
      ...entries.flatMap(([path, bytes, type]) => {
        const header = Buffer.alloc(512);
        header.write(path);
        header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
        header.fill(32, 148, 156);
        header.write(type ?? '0', 156);
        const checksum = [...header].reduce((a, b) => a + b, 0);
        header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
        return [
          header,
          bytes,
          Buffer.alloc((512 - (bytes.length % 512)) % 512),
        ];
      }),
      Buffer.alloc(1024),
    ]),
  );
}
describe('selected artifact alignment', () => {
  it('reads real npm pack output with package.json hidden by exports', () => {
    const root = fixture();
    const manifest = {
      name: '@megamono/plugin',
      version: '0.0.1',
      exports: { '.': './dist/index.js' },
    };
    for (const dir of [
      '.yalc/@megamono/plugin',
      'node_modules/@megamono/plugin',
    ])
      put(root, `${dir}/package.json`, JSON.stringify(manifest));
    const packed = JSON.parse(
      execFileSync(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', root],
        {
          cwd: join(root, '.yalc/@megamono/plugin'),
          encoding: 'utf8',
          env: { ...process.env, npm_config_cache: join(root, 'npm-cache') },
        },
      ),
    );
    select(root, packed[0].filename);
    expect(verifyArtifactAlignment(root).aligned).toBe(true);
  });
  it('matches the selected payload, ignoring unrelated newer store artifacts', () => {
    const root = fixture();
    put(root, 'store/packages/@megamono/plugin/0.0.1/dist/index.js', 'newer');
    expect(verifyArtifactAlignment(root).aligned).toBe(true);
    put(root, 'node_modules/@megamono/plugin/dist/index.js', 'older');
    expect(verifyArtifactAlignment(root).artifacts[0].status).toBe('mismatch');
  });
  it('resolves the explicitly selected consumer instead of a root installation', () => {
    const root = fixture();
    put(root, 'apps/api/package.json', '{}');
    put(
      root,
      'apps/api/node_modules/@megamono/plugin/package.json',
      readFileSync(join(root, '.yalc/@megamono/plugin/package.json')),
    );
    put(
      root,
      'apps/api/node_modules/@megamono/plugin/dist/index.js',
      'stale nested dependency',
    );
    select(root, '.yalc/@megamono/plugin', { consumer: 'apps/api' });
    expect(verifyArtifactAlignment(root).aligned).toBe(false);
  });
  it('compares pinned archives without a Yalc store or extraction and rejects checksum drift', () => {
    const root = fixture();
    put(
      root,
      'vendor/plugin.tgz',
      archive(
        ['package.json', 'dist/index.js'].map((file) => [
          `package/${file}`,
          readFileSync(join(root, '.yalc/@megamono/plugin', file)),
        ]),
      ),
    );
    rmSync(join(root, '.yalc'), { recursive: true });
    select(root, 'vendor/plugin.tgz');
    expect(verifyArtifactAlignment(root).aligned).toBe(true);
    select(root, 'vendor/plugin.tgz', { sha256: '0'.repeat(64) });
    expect(verifyArtifactAlignment(root).artifacts[0].status).toBe(
      'unverifiable',
    );
  });
  it('fails closed for missing selections and unsafe archive entries', () => {
    const root = fixture();
    select(root, 'missing.tgz');
    expect(verifyArtifactAlignment(root).aligned).toBe(false);
    for (const [path, type] of [
      ['package/../escape', '0'],
      ['package/link', '2'],
    ]) {
      expect(() =>
        archiveFiles(archive([[path, Buffer.from('x'), type]])),
      ).toThrow();
    }
    expect(() => archiveFiles(Buffer.from('not gzip'))).toThrow();
  });
});
