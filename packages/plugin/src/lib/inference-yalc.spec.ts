import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect, vi } from 'vitest';
import { planInferenceYalc } from './inference-yalc';

it('preflights required inference closure without side effects and locally binds runtime edges post-flush', async () => {
  const root = mkdtempSync(join(tmpdir(), 'megamono-inference-yalc-'));
  const store = join(root, 'store');
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  const artifact = (name: string, extra = {}) => {
    const path = join(store, 'packages', name, '0.0.1');
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, 'package.json'),
      JSON.stringify({ name, version: '0.0.1', ...extra }),
    );
  };
  try {
    artifact('@megamono/nx-cloudflare', {
      dependencies: { '@megamono/helper': '^0.0.1' },
      peerDependencies: { '@megamono/optional': '^0.0.1' },
      peerDependenciesMeta: { '@megamono/optional': { optional: true } },
    });
    artifact('@megamono/helper');
    artifact('@megamono/nx-extension', {
      peerDependencies: { '@megamono/helper': '^0.0.1' },
    });
    const add = vi.fn((args: string[], cwd: string) => {
      expect(cwd).toBe(consumer);
      expect(args).toContain('--no-pure');
      for (const name of [
        '@megamono/nx-cloudflare',
        '@megamono/helper',
        '@megamono/nx-extension',
      ])
        cpSync(
          join(store, 'packages', name, '0.0.1'),
          join(consumer, '.yalc', name),
          { recursive: true },
        );
    });
    const plan = planInferenceYalc(
      ['@megamono/nx-cloudflare', '@megamono/nx-extension'],
      '0.0.1',
      consumer,
      store,
      add,
    );
    expect(add).not.toHaveBeenCalled();
    expect(plan.packages).toEqual([
      '@megamono/helper@0.0.1',
      '@megamono/nx-cloudflare@0.0.1',
      '@megamono/nx-extension@0.0.1',
    ]);
    expect(plan.dependencies['@megamono/nx-extension']).toBe(
      'file:.yalc/@megamono/nx-extension',
    );
    await plan.install();
    expect(
      JSON.parse(
        readFileSync(
          join(consumer, '.yalc/@megamono/nx-cloudflare/package.json'),
          'utf8',
        ),
      ).dependencies['@megamono/helper'],
    ).toBe('file:../helper');
    expect(
      JSON.parse(
        readFileSync(
          join(store, 'packages/@megamono/nx-cloudflare/0.0.1/package.json'),
          'utf8',
        ),
      ).dependencies['@megamono/helper'],
    ).toBe('^0.0.1');
    expect(() =>
      planInferenceYalc(['@megamono/nx-render'], '0.0.1', consumer, store, add),
    ).toThrow('Cannot read Yalc artifacts');
    expect(() =>
      planInferenceYalc(['@megamono/helper'], '^2.0.0', consumer, store, add),
    ).toThrow('No published Yalc artifact');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
