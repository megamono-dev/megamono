import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  addProjectConfiguration,
  readJson,
  readProjectConfiguration,
  updateProjectConfiguration,
  type Tree,
} from '@nx/devkit';

import { workspaceInitGenerator } from './workspace-init';
import { WorkspaceInitGeneratorSchema } from './schema';

describe('workspace-init generator', () => {
  let tree: Tree;
  const options: WorkspaceInitGeneratorSchema = {};

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
  });

  it('should run successfully', async () => {
    await workspaceInitGenerator(tree, options);
    const config = readProjectConfiguration(tree, 'megamono');
    const docs = readProjectConfiguration(tree, 'megamono-docs');
    expect(config.targets?.check?.executor).toBe('@megamono/plugin:check');
    expect(config.targets?.import).toMatchObject({
      executor: '@megamono/plugin:import',
      cache: false,
      parallelism: false,
    });
    expect(docs.targets?.validate?.executor).toBe(
      '@megamono/plugin:docs-validate',
    );
    expect(config.targets?.health?.executor).toBe('@megamono/plugin:health');
    expect(
      tree.read('.github/workflows/megamono-health.yml', 'utf8'),
    ).toContain("cron: '17 9 * * 1'");
    expect(
      tree.read('.github/workflows/megamono-health.yml', 'utf8'),
    ).toContain('issues: write');
    expect(
      tree.read('.github/workflows/megamono-health.yml', 'utf8'),
    ).toContain("require('@megamono/plugin')");
    expect(
      tree.read('.github/workflows/megamono-health.yml', 'utf8'),
    ).not.toMatch(/^\s{2}pull_request:/m);
    const ci = tree.read('.github/workflows/megamono-ci.yml', 'utf8');
    expect(ci).toContain('actions/checkout@v7');
    expect(ci).toContain('fetch-depth: 0');
    expect(ci).toContain('nrwl/nx-set-shas@v5');
    expect(ci).toContain('merge_group:');
    expect(ci).toContain('npm exec nx -- affected -t lint test build');
    expect(ci).not.toContain('contents: write');
    expect(tree.read('AGENTS.md', 'utf8')).toContain('Affected CI');
    expect(tree.exists('megamono.json')).toBe(true);
    expect(tree.exists('.megamono/artifacts.json')).toBe(true);
    expect(tree.read('eslint.config.mjs', 'utf8')).toContain(
      "from '@megamono/plugin/eslint'",
    );
    expect(tree.read('eslint.config.mjs', 'utf8')).toContain(
      'megamonoPlugin.createConfig(megamonoConfig)',
    );
    expect(tree.exists('content-collections.ts')).toBe(true);
    expect(tree.exists('docs/DESIGN.md')).toBe(true);
    expect(tree.exists('.agents/skills/structure-review/SKILL.md')).toBe(true);
    expect(tree.exists('.megamono/artifacts.json')).toBe(true);
    expect(readJson(tree, '.megamono/artifacts.json').artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'skill.structure-review',
          mode: 'managed',
        }),
      ]),
    );
    expect(
      tree.read('.agents/skills/structure-review/SKILL.md', 'utf8'),
    ).toContain('name: structure-review');
    expect(tree.read('.gitignore', 'utf8')).toContain('.content-collections/');
    expect(tree.read('.gitignore', 'utf8')).toContain('.megamono/graph.json');
    expect(tree.read('.gitignore', 'utf8')).toContain('.megamono/health.json');
    expect(tree.read('.prettierignore', 'utf8')).toContain(
      '.megamono/graph.json',
    );
    expect(tree.read('.prettierignore', 'utf8')).toContain(
      '.megamono/health.json',
    );
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toEqual({
      'content-collections': ['./.content-collections/index.js'],
      'content-collections/*': ['./.content-collections/*.js'],
    });
  });

  it('refuses a malformed partial initialization', async () => {
    tree.write('megamono.json', '{}');
    await expect(workspaceInitGenerator(tree, options)).rejects.toThrow(
      'is invalid',
    );
  });

  it('routes unknown configuration versions to migration guidance', async () => {
    tree.write('megamono.json', JSON.stringify({ version: 2 }));
    await expect(workspaceInitGenerator(tree, options)).rejects.toThrow(
      /Unsupported Megamono configuration version 2.*configuration migration/s,
    );
  });

  it('adds a separator to an existing flat config without a trailing comma', async () => {
    tree.write(
      'eslint.config.mjs',
      `export default [
  {
    files: ['**/*.ts'],
    rules: {},
  }
];
`,
    );

    await workspaceInitGenerator(tree, options);

    expect(tree.read('eslint.config.mjs', 'utf8')).toContain(
      '    rules: {},\n  },\n  // megamono eslint rules',
    );
  });

  it('is a no-op when rerun with the same options', async () => {
    await workspaceInitGenerator(tree, options);
    const changesAfterFirstRun = tree.listChanges();
    await workspaceInitGenerator(tree, options);
    expect(tree.listChanges()).toEqual(changesAfterFirstRun);
  });

  it('upgrades an initialized workspace with the import target', async () => {
    await workspaceInitGenerator(tree, options);
    const project = readProjectConfiguration(tree, 'megamono');
    const targets = Object.fromEntries(
      Object.entries(project.targets ?? {}).filter(
        ([name]) => name !== 'import',
      ),
    );
    updateProjectConfiguration(tree, 'megamono', { ...project, targets });

    await workspaceInitGenerator(tree, options);

    expect(readProjectConfiguration(tree, 'megamono').targets?.import).toEqual({
      executor: '@megamono/plugin:import',
      cache: false,
      parallelism: false,
    });
  });

  it('preserves an edited managed skill on rerun', async () => {
    await workspaceInitGenerator(tree, options);
    const path = '.agents/skills/structure-review/SKILL.md';
    tree.write(path, `${tree.read(path, 'utf8')}Repository customization.\n`);
    const source = tree.read(path, 'utf8');

    await workspaceInitGenerator(tree, options);

    expect(tree.read(path, 'utf8')).toBe(source);
  });

  it('treats an inferred project without projectType as an application', async () => {
    addProjectConfiguration(tree, 'root-app', {
      root: '.',
      targets: {},
    });
    await workspaceInitGenerator(tree, { defaultPlatform: 'node' });
    expect(readProjectConfiguration(tree, 'root-app').tags).toEqual([
      'platform:node',
      'scope:shared',
      'type:app',
      'visibility:internal',
    ]);
  });

  it('emits only the configured platform jobs and toolchains', async () => {
    addProjectConfiguration(tree, 'apple-app', {
      root: 'apps/apple',
      projectType: 'application',
      tags: [
        'platform:apple',
        'scope:product',
        'type:app',
        'visibility:internal',
      ],
      targets: {},
    });
    addProjectConfiguration(tree, 'rust-app', {
      root: 'apps/desktop',
      projectType: 'application',
      tags: [
        'platform:rust',
        'scope:product',
        'type:app',
        'visibility:internal',
      ],
      targets: {},
    });

    await workspaceInitGenerator(tree, {});

    const ci = tree.read('.github/workflows/megamono-ci.yml', 'utf8');
    expect(ci).toContain('runs-on: ubuntu-latest');
    expect(ci).toContain('uses: dtolnay/rust-toolchain@stable');
    expect(ci).toContain('runs-on: macos-latest');
    expect(ci).toContain('xcodebuild -downloadComponent MetalToolchain');
    expect(ci).toContain("--exclude='*,!tag:platform:apple'");
    expect(ci).not.toContain('shivammathur/setup-php');
  });

  it('adopts independent module subsets without emitting unselected surfaces', async () => {
    await workspaceInitGenerator(tree, {
      only: 'agents,skills',
      yes: true,
    });

    expect(tree.exists('megamono.json')).toBe(true);
    expect(
      readProjectConfiguration(tree, 'megamono').targets?.check,
    ).toBeDefined();
    expect(tree.exists('AGENTS.md')).toBe(true);
    expect(tree.exists('CLAUDE.md')).toBe(true);
    expect(tree.exists('docs/DESIGN.md')).toBe(true);
    expect(tree.exists('.agents/skills/structure-review/SKILL.md')).toBe(true);
    expect(tree.exists('content-collections.ts')).toBe(false);
    expect(tree.exists('docs/project.json')).toBe(false);
    expect(tree.exists('eslint.config.mjs')).toBe(false);
    expect(tree.exists('.github/workflows/megamono-ci.yml')).toBe(false);
    expect(tree.exists('.github/workflows/megamono-health.yml')).toBe(false);
    expect(readJson(tree, 'megamono.json').adoption.modules).toEqual([
      'agents',
      'skills',
    ]);
  });

  it('keeps health useful without docs and records its reductions', async () => {
    await workspaceInitGenerator(tree, { only: 'health', yes: true });

    expect(
      readProjectConfiguration(tree, 'megamono').targets?.health?.executor,
    ).toBe('@megamono/plugin:health');
    expect(
      tree.read('.github/workflows/megamono-health.yml', 'utf8'),
    ).toContain('npm exec nx -- run megamono:health');
    expect(tree.exists('content-collections.ts')).toBe(false);
    expect(readJson(tree, 'megamono.json').adoption.reductions).toEqual([
      {
        module: 'health',
        capability: 'spec-drift',
        reason: 'The docs module is not selected.',
      },
      {
        module: 'health',
        capability: 'stale-plans',
        reason: 'The docs module is not selected.',
      },
    ]);
  });

  it('always preserves an existing general-purpose CI workflow', async () => {
    const repositoryCi = 'name: Repository CI\njobs: {}\n';
    tree.write('.github/workflows/ci.yml', repositoryCi);

    await workspaceInitGenerator(tree, { only: 'ci', yes: true });

    expect(tree.read('.github/workflows/ci.yml', 'utf8')).toBe(repositoryCi);
    expect(tree.read('.github/workflows/megamono-ci.yml', 'utf8')).toContain(
      'nrwl/nx-set-shas@v5',
    );
  });

  it('adds modules on a later run without requiring prior unselected modules', async () => {
    await workspaceInitGenerator(tree, { only: 'agents', yes: true });
    await workspaceInitGenerator(tree, { only: 'docs', yes: true });

    expect(tree.exists('AGENTS.md')).toBe(true);
    expect(tree.exists('content-collections.ts')).toBe(true);
    expect(readJson(tree, 'megamono.json').adoption.modules).toEqual([
      'docs',
      'agents',
    ]);
  });
});
