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
    expect(docs.targets?.health?.executor).toBe('@megamono/plugin:health');
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
    const ci = tree.read('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('actions/checkout@v7');
    expect(ci).toContain('fetch-depth: 0');
    expect(ci).toContain('nrwl/nx-set-shas@v5');
    expect(ci).toContain('merge_group:');
    expect(ci).toContain('npm exec nx -- affected -t lint test build');
    expect(ci).not.toContain('contents: write');
    expect(tree.read('AGENTS.md', 'utf8')).toContain('Affected CI');
    expect(tree.exists('megamono.json')).toBe(true);
    expect(tree.read('eslint.config.mjs', 'utf8')).toContain(
      "from '@megamono/plugin/eslint'",
    );
    expect(tree.read('eslint.config.mjs', 'utf8')).toContain(
      'megamonoPlugin.createConfig(megamonoConfig)',
    );
    expect(tree.exists('content-collections.ts')).toBe(true);
    expect(tree.exists('docs/DESIGN.md')).toBe(true);
    expect(tree.exists('.agents/skills/structure-review/SKILL.md')).toBe(true);
    expect(
      tree.exists('.agents/skills/structure-review/.megamono-skill.json'),
    ).toBe(true);
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

    const ci = tree.read('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('runs-on: ubuntu-latest');
    expect(ci).toContain('uses: dtolnay/rust-toolchain@stable');
    expect(ci).toContain('runs-on: macos-latest');
    expect(ci).toContain('xcodebuild -downloadComponent MetalToolchain');
    expect(ci).toContain("--exclude='*,!tag:platform:apple'");
    expect(ci).not.toContain('shivammathur/setup-php');
  });
});
