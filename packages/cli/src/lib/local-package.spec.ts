import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localPackageManifest } from './local-package.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'megamono-local-package-'));
  roots.push(root);
  return root;
}
function manifest(directory: string, name: string, extra = {}) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'package.json');
  writeFileSync(path, JSON.stringify({ name, version: '1.0.0', ...extra }));
  return realpathSync(path);
}

describe('workspace-local package metadata', () => {
  it('reads an unexported manifest without executing the package entry point', () => {
    const root = fixture();
    const directory = join(root, 'node_modules/@fixture/local');
    const path = manifest(directory, '@fixture/local', {
      exports: './index.js',
    });
    writeFileSync(
      join(directory, 'index.js'),
      'throw new Error("never load");',
    );
    expect(localPackageManifest(root, '@fixture/local')).toBe(path);
  });

  it('preserves the nearest installation and normal ancestor hoisting', () => {
    const root = fixture();
    const consumer = join(root, 'apps/consumer');
    mkdirSync(consumer, { recursive: true });
    const hoisted = manifest(
      join(root, 'node_modules/@fixture/local'),
      '@fixture/local',
    );
    expect(localPackageManifest(consumer, '@fixture/local')).toBe(hoisted);
    const nearer = manifest(
      join(consumer, 'node_modules/@fixture/local'),
      '@fixture/local',
    );
    expect(localPackageManifest(consumer, '@fixture/local')).toBe(nearer);
  });

  it('follows an explicitly installed pnpm-style package symlink', () => {
    const root = fixture();
    const directory = join(
      root,
      'node_modules/.pnpm/fixture@1/node_modules/@fixture/local',
    );
    const path = manifest(directory, '@fixture/local');
    const link = join(root, 'node_modules/@fixture/local');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(directory, link, 'junction');
    expect(localPackageManifest(root, '@fixture/local')).toBe(path);
  });

  it('rejects inherited NODE_PATH packages that ordinary require would accept', () => {
    const root = fixture();
    const consumer = join(root, 'consumer');
    mkdirSync(consumer);
    const ambient = join(root, 'ambient/node_modules');
    const ambientManifest = manifest(
      join(ambient, '@fixture/ambient'),
      '@fixture/ambient',
    );
    const script = `
      import { createRequire } from 'node:module';
      import { localPackageManifest } from ${JSON.stringify(new URL('./local-package.ts', import.meta.url).href)};
      const root = process.argv[1];
      const ordinary = createRequire(root + '/package.json').resolve('@fixture/ambient/package.json');
      let local;
      try { local = localPackageManifest(root, '@fixture/ambient'); }
      catch (error) { local = error.code; }
      console.log(JSON.stringify({ ordinary, local }));
    `;
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ['--input-type=module', '--eval', script, consumer],
        {
          encoding: 'utf8',
          env: { ...process.env, NODE_PATH: ambient },
        },
      ),
    );
    expect(result).toEqual({
      ordinary: ambientManifest,
      local: 'MODULE_NOT_FOUND',
    });
  });
});
