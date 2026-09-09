import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { webSurfaceEvidence } from './web-surface.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(files: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), 'megamono-web-surface-'));
  roots.push(root);
  await mkdir(join(root, 'apps/app'), { recursive: true });
  for (const file of files) {
    await mkdir(join(root, 'apps/app', file, '..'), { recursive: true });
    await writeFile(
      join(root, 'apps/app', file),
      'throw new Error("Discovery must not execute configuration");',
    );
  }
  return root;
}
describe('project-local web framework evidence', () => {
  it.each(['next.config.js', 'next.config.mjs', 'next.config.ts'])(
    'recognizes %s without loading it',
    async (config) => {
      expect(
        await webSurfaceEvidence(await fixture([config]), 'apps/app', {}),
      ).toEqual([`apps/app/${config}`]);
    },
  );
  it.each(['@nx/next:build', '@nx/next:server'])(
    'recognizes exact executor %s',
    async (executor) => {
      expect(
        await webSurfaceEvidence(await fixture([]), 'apps/app', {
          build: { executor },
        }),
      ).toEqual([`Nx target build: ${executor}`]);
    },
  );
  it('requires a Vite HTML entry and ignores command prose', async () => {
    const root = await fixture(['vite.config.ts']);
    expect(
      await webSurfaceEvidence(root, 'apps/app', {
        test: {
          executor: 'nx:run-commands',
          options: { command: 'echo "next build"' },
        },
        build: { executor: '@nx/vite:build' },
      }),
    ).toEqual([]);
    await writeFile(join(root, 'apps/app/index.html'), '<main></main>');
    expect(await webSurfaceEvidence(root, 'apps/app', {})).toEqual([
      'apps/app/vite.config.ts + index.html',
    ]);
  });
  it.each([
    'wxt.config.ts',
    'electron.vite.config.ts',
    'src-tauri/Cargo.toml',
    'manifest.chrome.json',
  ])('does not mistake %s for a browser app', async (marker) => {
    const root = await fixture(['vite.config.ts', 'index.html', marker]);
    expect(await webSurfaceEvidence(root, 'apps/app', {})).toEqual([]);
  });
  it('does not inherit parent or child evidence, or root dependencies', async () => {
    const root = await fixture(['fixtures/next.config.js']);
    await writeFile(
      join(root, 'next.config.js'),
      'throw new Error("not application evidence")',
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { next: '*', react: '*' } }),
    );
    expect(await webSurfaceEvidence(root, 'apps/app', {})).toEqual([]);
    expect(await webSurfaceEvidence(root, 'apps/absent', {})).toEqual([]);
  });
  it('distinguishes browser extension manifests from web-app manifests', async () => {
    const root = await fixture(['vite.config.ts', 'index.html']);
    const manifest = join(root, 'apps/app/manifest.json');
    await writeFile(
      manifest,
      JSON.stringify({ manifest_version: 3, name: 'Extension' }),
    );
    expect(await webSurfaceEvidence(root, 'apps/app', {})).toEqual([]);
    await writeFile(manifest, JSON.stringify({ name: 'PWA', start_url: '/' }));
    expect(await webSurfaceEvidence(root, 'apps/app', {})).toEqual([
      'apps/app/vite.config.ts + index.html',
    ]);
    await writeFile(manifest, '{ broken');
    expect(await webSurfaceEvidence(root, 'apps/app', {})).toEqual([]);
  });
});
