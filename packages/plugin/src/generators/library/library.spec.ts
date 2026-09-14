import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { getProjects, readJson, writeJson } from '@nx/devkit';
import { describe, expect, it } from 'vitest';
import { libraryGenerator } from './library';
import { DEFAULT_MEGAMONO_CONFIG } from '../../lib/config';

function workspace() {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'megamono.json', DEFAULT_MEGAMONO_CONFIG);
  return tree;
}

describe('library generator', () => {
  it.each(['neutral', 'web', 'node', 'mobile', 'worker'] as const)(
    'generates a private %s library without release setup',
    async (platform) => {
      const tree = workspace();
      await libraryGenerator(tree, {
        name: 'shared',
        scope: 'fixture',
        platform,
        yes: true,
        skipInstall: true,
      });
      const project = getProjects(tree).get('fixture-shared');
      expect(project?.root).toBe('libs/shared');
      expect(project?.tags).toEqual([
        'scope:fixture',
        'type:util',
        ...(platform === 'neutral' ? [] : [`platform:${platform}`]),
      ]);
      expect(readJson(tree, 'libs/shared/package.json')).toMatchObject({
        name: '@fixture/shared',
        private: true,
        exports: { '.': { types: './src/index.ts' } },
      });
      expect(readJson(tree, 'nx.json').release).toBeUndefined();
      expect(tree.exists('.verdaccio/config.yml')).toBe(false);
    },
  );
  it.each(['restricted', 'public'] as const)(
    'generates a buildable %s package preserving release policy',
    async (access) => {
      const tree = workspace();
      const release = {
        projects: ['existing'],
        version: { preVersionCommand: 'reviewed-build' },
      };
      writeJson(tree, 'nx.json', { release });
      await libraryGenerator(tree, {
        name: 'client',
        scope: 'fixture',
        publishable: true,
        access,
        yes: true,
        skipInstall: true,
      });
      expect(
        getProjects(tree).get('fixture-client')?.targets?.build,
      ).toMatchObject({ executor: '@nx/js:tsc' });
      expect(readJson(tree, 'packages/client/package.json')).toMatchObject({
        name: '@fixture/client',
        private: false,
        publishConfig: { access },
      });
      expect(readJson(tree, 'nx.json').release).toEqual(release);
      expect(tree.exists('.verdaccio/config.yml')).toBe(false);
    },
  );
  it('uses built exports in a TypeScript solution workspace', async () => {
    const tree = workspace();
    writeJson(tree, 'package.json', {
      ...readJson(tree, 'package.json'),
      workspaces: ['libs/*', 'packages/*'],
    });
    tree.write(
      'pnpm-workspace.yaml',
      'packages:\n  - libs/*\n  - packages/*\n',
    );
    writeJson(tree, 'tsconfig.base.json', {
      compilerOptions: {
        composite: true,
        declaration: true,
        module: 'nodenext',
        target: 'es2022',
      },
    });
    writeJson(tree, 'tsconfig.json', {
      extends: './tsconfig.base.json',
      files: [],
      references: [],
    });
    await libraryGenerator(tree, {
      name: 'sdk',
      scope: 'fixture',
      publishable: true,
      yes: true,
      skipInstall: true,
    });
    const manifest = readJson(tree, 'packages/sdk/package.json');
    expect(manifest.private).toBe(false);
    expect(manifest.files).toEqual(['dist', '!**/*.tsbuildinfo']);
    expect(JSON.stringify(manifest.exports)).toContain('./dist/index.js');
    expect(JSON.stringify(manifest.exports)).toContain('./dist/index.d.ts');
    expect(readJson(tree, 'nx.json').release).toBeUndefined();
  });

  it('preserves pnpm policy comments and permits caller-owned installation', async () => {
    const tree = workspace();
    tree.write(
      'pnpm-workspace.yaml',
      "# Reviewed workspace\npackages:\n  - 'apps/*' # app roots\nallowBuilds:\n  prisma: true # reviewed engine\n",
    );
    tree.write('.npmrc', 'store-dir=/existing/store\n');
    const callback = await libraryGenerator(tree, {
      name: 'shared',
      scope: 'fixture',
      yes: true,
      skipInstall: true,
    });
    expect(callback()).toBeUndefined();
    expect(tree.read('.npmrc', 'utf8')).toBe('store-dir=/existing/store\n');
    expect(tree.read('pnpm-workspace.yaml', 'utf8')).toContain(
      '# Reviewed workspace',
    );
    expect(tree.read('pnpm-workspace.yaml', 'utf8')).toContain(
      '# reviewed engine',
    );
    expect(tree.exists('libs/shared/package.json')).toBe(true);
  });

  it('plans without mutation, and rejects unsafe names and occupied paths', async () => {
    const tree = workspace();
    const before = tree.listChanges();
    await libraryGenerator(tree, { name: 'shared', scope: 'fixture' });
    await libraryGenerator(tree, {
      name: 'shared',
      scope: 'fixture',
      yes: true,
      planOnly: true,
    });
    expect(tree.listChanges()).toEqual(before);
    await expect(libraryGenerator(tree, { name: '../bad' })).rejects.toThrow(
      'kebab-case',
    );
    await expect(
      libraryGenerator(tree, { name: 'shared', access: 'public' }),
    ).rejects.toThrow('Registry access');
    tree.write('libs/shared/README.md', 'existing');
    await expect(
      libraryGenerator(tree, { name: 'shared', scope: 'fixture', yes: true }),
    ).rejects.toThrow('already exists');
    expect(tree.read('libs/shared/README.md', 'utf8')).toBe('existing');
  });
});
