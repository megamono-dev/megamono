import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { getProjects, readJson, writeJson, workspaceRoot } from '@nx/devkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { libraryGenerator } from './library';
import {
  collectWorkspaceInitHostState,
  isHostedWorkspaceTree,
  parsePorcelainPaths,
} from '../../lib/workspace-init-preflight';
import { DEFAULT_MEGAMONO_CONFIG } from '../../lib/config';
import ts = require('typescript');
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('../../lib/workspace-init-preflight', async (original) => {
  const actual =
    await original<typeof import('../../lib/workspace-init-preflight')>();
  return {
    ...actual,
    collectWorkspaceInitHostState: vi.fn(actual.collectWorkspaceInitHostState),
    isHostedWorkspaceTree: vi.fn(actual.isHostedWorkspaceTree),
  };
});

function workspace() {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'megamono.json', DEFAULT_MEGAMONO_CONFIG);
  return tree;
}

describe('library generator', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('keeps npm package scope independent of architectural scope', async () => {
    const tree = workspace();
    writeJson(tree, 'package.json', {
      ...readJson(tree, 'package.json'),
      name: '@product-int/source',
    });
    await libraryGenerator(tree, {
      name: 'shared',
      packageScope: '@product',
      yes: true,
      skipInstall: true,
    });
    expect(readJson(tree, 'libs/shared/package.json').name).toBe(
      '@product/shared',
    );
    expect(getProjects(tree).get('product-int-shared')?.tags).toContain(
      'scope:product-int',
    );
    const explicit = workspace();
    await libraryGenerator(explicit, {
      name: 'shared',
      scope: 'internal',
      packageScope: 'public',
      yes: true,
      skipInstall: true,
    });
    expect(readJson(explicit, 'libs/shared/package.json').name).toBe(
      '@public/shared',
    );
    expect(getProjects(explicit).get('internal-shared')?.tags).toContain(
      'scope:internal',
    );
  });
  it('configures browser React UI libraries without adding React to plain web helpers', async () => {
    const tree = workspace();
    writeJson(tree, 'package.json', {
      ...readJson(tree, 'package.json'),
      dependencies: { react: '^18.3.1' },
      devDependencies: { '@types/react': '^18.3.0' },
    });
    await libraryGenerator(tree, {
      name: 'ui',
      scope: 'fixture',
      platform: 'web',
      type: 'ui',
      yes: true,
      skipInstall: true,
    });
    expect(readJson(tree, 'libs/ui/tsconfig.lib.json')).toMatchObject({
      compilerOptions: {
        jsx: 'react-jsx',
        moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      },
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    });
    expect(readJson(tree, 'libs/ui/package.json')).toMatchObject({
      peerDependencies: { react: '^18.3.1' },
      devDependencies: { react: '^18.3.1', '@types/react': '^18.3.0' },
    });
    expect(
      readJson(tree, 'libs/ui/package.json').peerDependencies,
    ).not.toHaveProperty('@chakra-ui/react');
    const chakra = workspace();
    writeJson(chakra, 'apps/site/package.json', {
      name: '@fixture/site',
      dependencies: { '@chakra-ui/react': '3.37.0', react: '19.3.1' },
    });
    writeJson(chakra, 'apps/site/project.json', {
      name: 'fixture-site',
      root: 'apps/site',
    });
    await libraryGenerator(chakra, {
      name: 'ui',
      scope: 'fixture',
      platform: 'web',
      type: 'ui',
      yes: true,
      skipInstall: true,
    });
    const singletons = {
      '@chakra-ui/react': '3.37.0',
      '@emotion/react': '11.14.0',
    };
    expect(readJson(chakra, 'libs/ui/package.json')).toMatchObject({
      peerDependencies: singletons,
      devDependencies: singletons,
    });
    const plain = workspace();
    await libraryGenerator(plain, {
      name: 'helper',
      scope: 'fixture',
      platform: 'web',
      type: 'util',
      yes: true,
      skipInstall: true,
    });
    expect(
      readJson(plain, 'libs/helper/package.json').peerDependencies?.react,
    ).toBeUndefined();
  });
  it('generates a runnable Vitest starter while keeping specs out of production typechecking', async () => {
    const tree = workspace();
    await libraryGenerator(tree, {
      name: 'helper',
      scope: 'fixture',
      yes: true,
      skipInstall: true,
    });
    expect(
      getProjects(tree).get('fixture-helper')?.targets?.test,
    ).toMatchObject({
      executor: 'nx:run-commands',
      options: {
        command: 'vitest run --config vitest.config.ts',
        cwd: 'libs/helper',
      },
    });
    expect(tree.read('libs/helper/src/index.spec.ts', 'utf8')).toMatch(
      /toBe\(["']fixture-helper["']\)/,
    );
    expect(readJson(tree, 'libs/helper/tsconfig.lib.json').exclude).toEqual(
      expect.arrayContaining(['src/**/*.spec.*', 'src/**/*.test.*']),
    );
    expect(readJson(tree, 'libs/helper/tsconfig.spec.json')).toMatchObject({
      compilerOptions: { noEmit: true, composite: false },
      exclude: [],
    });
    const root = mkdtempSync(join(tmpdir(), 'megamono-library-types-'));
    try {
      for (const change of tree.listChanges()) {
        if (change.type === 'DELETE' || change.content === null) continue;
        const path = join(root, change.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, change.content);
      }
      symlinkSync(
        join(workspaceRoot, 'node_modules'),
        join(root, 'node_modules'),
        'dir',
      );
      const result = execFileSync(
        process.execPath,
        [
          join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
          'run',
          '--config',
          'vitest.config.ts',
        ],
        {
          cwd: join(root, 'libs/helper'),
          encoding: 'utf8',
          timeout: 20_000,
          env: { ...process.env, CI: 'true' },
          stdio: 'pipe',
        },
      );
      expect(result).toMatch(/1 passed/);
      writeFileSync(
        join(root, 'libs/helper/src/broken.spec.ts'),
        "export const broken: number = 'test error';\n",
      );
      const configPath = join(root, 'libs/helper/tsconfig.lib.json');
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        dirname(configPath),
      );
      expect(
        parsed.fileNames.some((file) => file.endsWith('broken.spec.ts')),
      ).toBe(false);
      const specPath = join(root, 'libs/helper/tsconfig.spec.json');
      const spec = ts.readConfigFile(specPath, ts.sys.readFile);
      const parsedSpec = ts.parseJsonConfigFileContent(
        spec.config,
        ts.sys,
        dirname(specPath),
      );
      expect(
        parsedSpec.fileNames.some((file) => file.endsWith('broken.spec.ts')),
      ).toBe(true);
      const program = ts.createProgram(parsed.fileNames, {
        ...parsed.options,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      });
      expect(
        ts
          .getPreEmitDiagnostics(program)
          .some((diagnostic) =>
            diagnostic.file?.fileName.endsWith('broken.spec.ts'),
          ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(['18.20.8', '20.18.3', '22.11.0'])(
    'requires a supported test runtime before mutation on Node %s and supports an explicit test opt-out',
    async (nodeVersion) => {
      const tree = workspace();
      const before = tree.listChanges();
      vi.stubGlobal('process', {
        ...process,
        versions: { ...process.versions, node: nodeVersion },
      });
      await expect(
        libraryGenerator(tree, {
          name: 'legacy',
          yes: true,
          skipInstall: true,
        }),
      ).rejects.toThrow('testRunner=none');
      expect(tree.listChanges()).toEqual(before);
      const callback = await libraryGenerator(tree, {
        name: 'legacy',
        scope: 'fixture',
        testRunner: 'none',
        yes: true,
        skipInstall: true,
      });
      expect(callback()).toBeUndefined();
      expect(tree.exists('libs/legacy/vitest.config.ts')).toBe(false);
      expect(
        getProjects(tree).get('fixture-legacy')?.targets?.test,
      ).toBeUndefined();
    },
  );
  it('does not change a supplied lockfile during generation or its skipped install callback', async () => {
    const tree = workspace();
    tree.write('pnpm-lock.yaml', 'lockfileVersion: 9\n# caller-owned lock\n');
    const callback = await libraryGenerator(tree, {
      name: 'deferred',
      scope: 'fixture',
      yes: true,
      skipInstall: true,
    });
    const before = tree.listChanges();
    await callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tree.listChanges()).toEqual(before);
    expect(tree.read('pnpm-lock.yaml', 'utf8')).toBe(
      'lockfileVersion: 9\n# caller-owned lock\n',
    );
  });
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
  it('writes .ts relative re-exports only when the base config rewrites them', async () => {
    for (const rewrite of [true, false]) {
      const tree = workspace();
      writeJson(tree, 'package.json', {
        ...readJson(tree, 'package.json'),
        workspaces: ['libs/*'],
      });
      tree.write('pnpm-workspace.yaml', 'packages:\n  - libs/*\n');
      writeJson(tree, 'tsconfig.base.json', {
        compilerOptions: {
          composite: true,
          module: 'nodenext',
          moduleResolution: 'nodenext',
          ...(rewrite ? { rewriteRelativeImportExtensions: true } : {}),
        },
      });
      writeJson(tree, 'tsconfig.json', {
        extends: './tsconfig.base.json',
        files: [],
        references: [],
      });
      await libraryGenerator(tree, {
        name: 'core',
        scope: 'fixture',
        yes: true,
        skipInstall: true,
      });
      expect(tree.read('libs/core/src/index.ts', 'utf8')).toBe(
        `export * from './lib/fixture-core.${rewrite ? 'ts' : 'js'}';\n`,
      );
      expect(tree.read('libs/core/src/index.spec.ts', 'utf8')).toContain(
        'fixtureCore',
      );
    }
  });
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
  it('keeps publishable output flat and emits JavaScript despite inherited composite/noEmit defaults', async () => {
    const tree = workspace();
    writeJson(tree, 'tsconfig.base.json', {
      compilerOptions: {
        composite: true,
        declaration: true,
        noEmit: true,
        emitDeclarationOnly: true,
        module: 'nodenext',
        target: 'es2022',
      },
    });
    await libraryGenerator(tree, {
      name: 'sdk',
      scope: 'fixture',
      publishable: true,
      yes: true,
      skipInstall: true,
    });
    expect(
      readJson(tree, 'packages/sdk/tsconfig.lib.json').compilerOptions,
    ).toMatchObject({
      rootDir: 'src',
      noEmit: false,
      emitDeclarationOnly: false,
    });
    expect(
      getProjects(tree).get('fixture-sdk')?.targets?.build?.options?.rootDir,
    ).toBe('packages/sdk/src');
    const output =
      getProjects(tree).get('fixture-sdk')?.targets?.build?.options?.outputPath;
    const prefix = output === 'packages/sdk/dist' ? './dist' : '.';
    expect(readJson(tree, 'packages/sdk/package.json')).toMatchObject({
      main: `${prefix}/index.js`,
      types: `${prefix}/index.d.ts`,
      exports: {
        '.': { types: `${prefix}/index.d.ts`, default: `${prefix}/index.js` },
      },
    });
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

  it('adds several libraries in one change and only refuses dirty files it would write', async () => {
    const hosted = (dirtyPaths: string[]) => {
      const tree = workspace();
      vi.mocked(isHostedWorkspaceTree).mockReturnValue(true);
      vi.mocked(collectWorkspaceInitHostState).mockResolvedValue({
        platform: process.platform,
        node: process.version,
        git: {
          available: true,
          clean: dirtyPaths.length === 0,
          dirtyPaths,
          branch: 'feat/libraries',
          defaultBranch: 'main',
        },
      });
      return tree;
    };
    const batch = hosted([]);
    await libraryGenerator(batch, {
      name: 'core,ui',
      scope: 'fixture',
      yes: true,
      skipInstall: true,
      testRunner: 'none',
    });
    expect(
      ['fixture-core', 'fixture-ui'].map(
        (name) => getProjects(batch).get(name)?.root,
      ),
    ).toEqual(['libs/core', 'libs/ui']);
    expect(collectWorkspaceInitHostState).toHaveBeenCalledTimes(1);

    const dirty = hosted(['docs/notes.md', 'apps/site/src/page.tsx']);
    await expect(
      libraryGenerator(dirty, {
        name: 'emails',
        scope: 'fixture',
        yes: true,
        skipInstall: true,
        testRunner: 'none',
      }),
    ).rejects.toThrow('clean working tree');
    await libraryGenerator(dirty, {
      name: 'emails',
      scope: 'fixture',
      yes: true,
      skipInstall: true,
      testRunner: 'none',
      allowDirty: true,
    });
    expect(dirty.exists('libs/emails/package.json')).toBe(true);

    const overlapping = hosted(['tsconfig.base.json', 'docs/notes.md']);
    await expect(
      libraryGenerator(overlapping, {
        name: 'emails',
        scope: 'fixture',
        yes: true,
        skipInstall: true,
        testRunner: 'none',
        allowDirty: true,
      }),
    ).rejects.toThrow(/uncommitted work: tsconfig\.base\.json\b/);
    const locked = hosted(['pnpm-lock.yaml']);
    await expect(
      libraryGenerator(locked, {
        name: 'emails',
        scope: 'fixture',
        yes: true,
        testRunner: 'none',
        allowDirty: true,
      }),
    ).rejects.toThrow('pnpm-lock.yaml');
    await expect(
      libraryGenerator(workspace(), { name: 'core,core', yes: true }),
    ).rejects.toThrow('unique');
    expect(
      parsePorcelainPaths(
        'M tsconfig.base.json\n?? "docs/a b.md"\nR  old.ts -> new.ts',
      ),
    ).toEqual(['tsconfig.base.json', 'docs/a b.md', 'old.ts', 'new.ts']);
    vi.mocked(isHostedWorkspaceTree).mockReset();
    vi.mocked(collectWorkspaceInitHostState).mockReset();
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
