import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson, type Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { DEFAULT_MEGAMONO_CONFIG } from '../../lib/config';
import {
  createPlaystackSkillsPostFlushCallback,
  playstackSkillsGenerator,
  type PlaystackSkillsCommand,
} from './playstack-skills';

function fixture(packageManager: 'npm' | 'pnpm' = 'pnpm'): Tree {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    name: '@acme/workspace',
    private: true,
    dependencies: { '@playstack/content': '0.1.0-beta.1' },
  });
  writeJson(tree, 'megamono.json', {
    ...DEFAULT_MEGAMONO_CONFIG,
    conventions: {
      ...DEFAULT_MEGAMONO_CONFIG.conventions,
      packageManager,
    },
  });
  writeJson(tree, '.megamono/artifacts.json', {
    schemaVersion: 1,
    artifacts: [],
  });
  return tree;
}

function snapshot(tree: Tree): string[] {
  return tree
    .listChanges()
    .map(
      (change) =>
        `${change.type}:${change.path}:${change.content?.toString('utf8') ?? ''}`,
    );
}

describe('playstack-skills generator', () => {
  it('plans without mutation and configures only package-owned synchronization', async () => {
    const tree = fixture();
    const before = snapshot(tree);
    await playstackSkillsGenerator(tree, {
      dryRun: true,
      interactive: false,
    });
    expect(snapshot(tree)).toEqual(before);

    const callback = await playstackSkillsGenerator(tree, {
      interactive: false,
    });
    expect(callback).toBeTypeOf('function');
    expect(readJson(tree, 'playstack.json')).toEqual({
      $schema: './node_modules/@playstack/cli/playstack.schema.json',
      skills: { targets: ['.agents/skills'] },
    });
    expect(readJson(tree, 'package.json')).toMatchObject({
      devDependencies: {
        '@playstack/cli': '0.1.0-beta.1',
        '@playstack/skills': '0.1.0-beta.1',
      },
    });
    expect(tree.children('.agents/skills')).toEqual([]);
    expect(readJson(tree, '.megamono/artifacts.json')).toEqual({
      schemaVersion: 1,
      artifacts: [],
    });
  });

  it('preserves explicit targets, unrelated config, and local package addresses', async () => {
    const tree = fixture('npm');
    writeJson(tree, 'playstack.json', {
      prisma: { target: 'prisma/schema' },
      skills: { targets: ['tools/agent-skills'] },
    });
    writeJson(tree, 'package.json', {
      name: '@acme/workspace',
      dependencies: { '@playstack/content': '0.1.0-beta.1' },
      devDependencies: {
        '@playstack/cli': 'file:.yalc/@playstack/cli',
        '@playstack/skills': 'file:.yalc/@playstack/skills',
      },
    });

    await playstackSkillsGenerator(tree, {});

    expect(readJson(tree, 'playstack.json')).toEqual({
      prisma: { target: 'prisma/schema' },
      skills: { targets: ['tools/agent-skills'] },
    });
    expect(readJson(tree, 'package.json')).toMatchObject({
      devDependencies: {
        '@playstack/cli': 'file:.yalc/@playstack/cli',
        '@playstack/skills': 'file:.yalc/@playstack/skills',
      },
    });
  });

  it('delegates package-manager-aware sync and writes actionable recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-skills-callback-'));
    try {
      const calls: PlaystackSkillsCommand[] = [];
      const callback = createPlaystackSkillsPostFlushCallback(
        root,
        'npm',
        async () => undefined,
        async (command) => {
          calls.push(command);
          throw new Error('fixture sync failure');
        },
      );
      await expect(callback()).rejects.toThrow('fixture sync failure');
      expect(calls).toEqual([
        {
          command: 'npm',
          args: ['exec', 'playstack', '--', 'skills', 'sync'],
        },
      ]);
      const recovery = await readFile(
        join(root, 'MEGAMONO-RECOVERY.md'),
        'utf8',
      );
      expect(recovery).toContain('`skills-sync` phase');
      expect(recovery).toContain('`npm exec playstack -- skills sync`');
      expect(recovery).toContain('did not copy, overwrite, register, or eject');

      await writeFile(
        join(root, 'MEGAMONO-RECOVERY.md'),
        '# Unrelated recovery\n',
      );
      const pnpm = createPlaystackSkillsPostFlushCallback(
        root,
        'pnpm',
        async () => undefined,
        async (command) => {
          calls.push(command);
        },
      );
      await pnpm();
      expect(calls.at(-1)).toEqual({
        command: 'pnpm',
        args: ['exec', 'playstack', 'skills', 'sync'],
      });
      expect(await readFile(join(root, 'MEGAMONO-RECOVERY.md'), 'utf8')).toBe(
        '# Unrelated recovery\n',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses absent products and unsafe configured targets before mutation', async () => {
    const noProduct = fixture();
    writeJson(noProduct, 'package.json', { name: '@acme/workspace' });
    await expect(playstackSkillsGenerator(noProduct, {})).rejects.toMatchObject(
      { exitCode: 3 },
    );

    const unsafe = fixture();
    writeJson(unsafe, 'playstack.json', {
      skills: { targets: ['../outside'] },
    });
    const before = snapshot(unsafe);
    await expect(playstackSkillsGenerator(unsafe, {})).rejects.toThrow(
      /safe workspace-relative paths/,
    );
    expect(snapshot(unsafe)).toEqual(before);
  });
});
