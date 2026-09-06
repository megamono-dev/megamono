import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectGraph } from '@nx/devkit';
import { checkWorkspaceStructure } from './structural-check';
import { DEFAULT_MEGAMONO_CONFIG } from './config';

describe('local Megamono plugin composition', () => {
  it.each([
    ['@megamono/nx-phpnative', 'lib', true, true, false],
    ['@consumer/app', 'app', false, true, true],
    ['@megamono/app', 'app', true, true, true],
    ['@megamono/library', 'lib', false, true, true],
    ['@playstack/binding', 'lib', true, true, true],
    ['@megamono/nx-phpnative', 'lib', true, false, true],
  ] as const)(
    'checks %s %s tooling=%s local-target=%s',
    async (name, type, tooling, local, rejected) => {
      const root = await mkdtemp(join(tmpdir(), 'megamono-plugin-policy-'));
      try {
        await writeFile(join(root, 'package.json'), '{}');
        for (const path of ['source', 'target']) await mkdir(join(root, path));
        await writeFile(
          join(root, 'source/package.json'),
          JSON.stringify({
            name,
            ...(tooling ? { generators: './generators.json' } : {}),
            dependencies: { '@megamono/nx-laravel': '0.0.1' },
          }),
        );
        await writeFile(
          join(root, 'target/package.json'),
          JSON.stringify({
            name: local ? '@megamono/nx-laravel' : '@consumer/unrelated',
            generators: './generators.json',
          }),
        );
        const graph: ProjectGraph = {
          nodes: {
            source: { name: 'source', type, data: { root: 'source' } },
            target: { name: 'target', type: 'lib', data: { root: 'target' } },
          },
          dependencies: { source: [], target: [] },
        };
        const result = await checkWorkspaceStructure(
          root,
          graph,
          DEFAULT_MEGAMONO_CONFIG,
          new Set(),
          new Set(['megamono-dev-only', 'playstack-direction']),
        );
        expect(result.some((entry) => entry.code === 'megamono-dev-only')).toBe(
          rejected,
        );
        if (name.startsWith('@playstack/'))
          expect(
            result.some((entry) => entry.code === 'playstack-direction'),
          ).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
