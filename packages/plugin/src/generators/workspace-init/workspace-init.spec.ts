import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { prompt } from 'enquirer';
import { vi } from 'vitest';
import {
  addProjectConfiguration,
  formatFiles,
  readJson,
  readProjectConfiguration,
  updateProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import { hashArtifactBytes } from '../../lib/managed-artifacts';

import { workspaceInitGenerator } from './workspace-init';
import { WorkspaceInitGeneratorSchema } from './schema';
import { workspaceEjectGenerator } from '../workspace-eject/workspace-eject';

vi.mock('enquirer', () => ({ prompt: vi.fn() }));

describe('workspace-init generator', () => {
  let tree: Tree;
  const options: WorkspaceInitGeneratorSchema = {
    only: 'docs,agents,ci,lint,skills,health,inference',
    yes: true,
  };

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
    ).toContain('npm exec nx -- run megamono-docs:health');
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
          id: 'agents.instructions',
          mode: 'managed-section',
          startDelimiter: '<!-- megamono instructions start -->',
          endDelimiter: '<!-- megamono instructions end -->',
        }),
        expect.objectContaining({ id: 'ci.affected', mode: 'managed' }),
        expect.objectContaining({ id: 'config.workspace', mode: 'seeded' }),
        expect.objectContaining({
          id: 'core.gitignore',
          mode: 'managed-section',
        }),
        expect.objectContaining({ id: 'docs.index', mode: 'derived' }),
        expect.objectContaining({ id: 'docs.loader', mode: 'managed' }),
        expect.objectContaining({ id: 'docs.project', mode: 'managed' }),
        expect.objectContaining({
          id: 'docs.structure.archives-plans',
          mode: 'derived',
        }),
        expect.objectContaining({ id: 'health.workflow', mode: 'managed' }),
        expect.objectContaining({
          id: 'lint.eslint-imports',
          mode: 'managed-section',
        }),
        expect.objectContaining({
          id: 'lint.eslint-rules',
          mode: 'managed-section',
        }),
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
    expect(tree.read('.gitignore', 'utf8')).toContain(
      '# megamono ignore entries start',
    );
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

  it('requires explicit module input without an interactive terminal', async () => {
    const changes = tree.listChanges();

    await expect(
      workspaceInitGenerator(tree, { interactive: false }),
    ).rejects.toMatchObject({
      diagnosticCode: 'workspace-init-decision-required',
      exitCode: 4,
      message: expect.stringContaining('--only'),
    });
    expect(tree.listChanges()).toEqual(changes);
  });

  it('writes the same completion summary only when a safe report is requested', async () => {
    await workspaceInitGenerator(tree, {
      only: 'health',
      yes: true,
      report: '.megamono/init-report.md',
    });

    const report = tree.read('.megamono/init-report.md', 'utf8') ?? '';
    expect(report).toContain('# Megamono workspace initialization complete');
    expect(report).toContain('`npm exec nx run megamono:health`');

    const invalidTree = createTreeWithEmptyWorkspace();
    const changes = invalidTree.listChanges();
    await expect(
      workspaceInitGenerator(invalidTree, {
        only: 'health',
        yes: true,
        report: '../outside.md',
      }),
    ).rejects.toMatchObject({
      diagnosticCode: 'workspace-init-options',
      exitCode: 2,
    });
    expect(invalidTree.listChanges()).toEqual(changes);
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

  it('preserves modified managed ESLint wiring', async () => {
    await workspaceInitGenerator(tree, { only: 'lint', yes: true });
    const customized = (tree.read('eslint.config.mjs', 'utf8') ?? '').replace(
      'megamonoPlugin.createConfig(megamonoConfig)',
      'megamonoPlugin.createConfig({ ...megamonoConfig })',
    );
    tree.write('eslint.config.mjs', customized);
    await formatFiles(tree);
    const formattedCustomization = tree.read('eslint.config.mjs', 'utf8');

    await workspaceInitGenerator(tree, { only: 'lint', yes: true });

    expect(tree.read('eslint.config.mjs', 'utf8')).toBe(formattedCustomization);
  });

  it('updates pristine managed ESLint wiring from its installed hash', async () => {
    await workspaceInitGenerator(tree, { only: 'lint', yes: true });
    const oldBody = '\n  megamonoPlugin.createConfig({ ...megamonoConfig }),\n';
    const oldHash = hashArtifactBytes(oldBody);
    const source = tree.read('eslint.config.mjs', 'utf8') ?? '';
    tree.write(
      'eslint.config.mjs',
      source.replace(
        /(?<=\/\/ megamono eslint rules start)[\s\S]*?(?= {2}\/\/ megamono eslint rules end)/,
        oldBody,
      ),
    );
    const registry = readJson(tree, '.megamono/artifacts.json');
    registry.artifacts = registry.artifacts.map((artifact: { id: string }) =>
      artifact.id === 'lint.eslint-rules'
        ? {
            ...artifact,
            sourceVersion: '0.0.0-old',
            templateHash: oldHash,
            installedHash: oldHash,
          }
        : artifact,
    );
    tree.write('.megamono/artifacts.json', JSON.stringify(registry));

    await workspaceInitGenerator(tree, { only: 'lint', yes: true });

    expect(tree.read('eslint.config.mjs', 'utf8')).toContain(
      'megamonoPlugin.createConfig(megamonoConfig)',
    );
    const updated = readJson(tree, '.megamono/artifacts.json').artifacts.find(
      ({ id }: { id: string }) => id === 'lint.eslint-rules',
    );
    expect(updated.installedHash).not.toBe(oldHash);
    expect(updated.installedHash).toBe(updated.templateHash);
  });

  it('does not reclaim ejected ESLint wiring', async () => {
    await workspaceInitGenerator(tree, { only: 'lint', yes: true });
    await workspaceEjectGenerator(tree, { artifact: 'lint.eslint-rules' });
    const customized = (tree.read('eslint.config.mjs', 'utf8') ?? '').replace(
      'megamonoPlugin.createConfig(megamonoConfig)',
      'megamonoPlugin.createConfig({ ...megamonoConfig })',
    );
    tree.write('eslint.config.mjs', customized);
    await formatFiles(tree);
    const formattedCustomization = tree.read('eslint.config.mjs', 'utf8');

    await workspaceInitGenerator(tree, { only: 'lint', yes: true });

    expect(tree.read('eslint.config.mjs', 'utf8')).toBe(formattedCustomization);
    expect(
      readJson(tree, '.megamono/artifacts.json').artifacts.find(
        ({ id }: { id: string }) => id === 'lint.eslint-rules',
      ).state,
    ).toBe('ejected');
  });

  it('refuses unregistered ESLint ownership delimiters before mutation', async () => {
    tree.write(
      'eslint.config.mjs',
      `// megamono eslint imports start
import megamonoConfig from './megamono.json' with { type: 'json' };
import megamonoPlugin from '@megamono/plugin/eslint';
// megamono eslint imports end

export default [];
`,
    );
    const changes = tree.listChanges();

    await expect(
      workspaceInitGenerator(tree, { only: 'lint', yes: true }),
    ).rejects.toMatchObject({
      diagnosticCode: 'workspace-init-conflict',
      exitCode: 3,
    });
    expect(tree.listChanges()).toEqual(changes);
  });

  it('migrates legacy ESLint markers into registered managed sections', async () => {
    tree.write(
      'eslint.config.mjs',
      `// megamono eslint imports
import megamonoConfig from './megamono.json' with { type: 'json' };
import megamonoPlugin from '@megamono/plugin/eslint';

export default [
  // megamono eslint rules
  megamonoPlugin.createConfig(megamonoConfig),
];
`,
    );

    await workspaceInitGenerator(tree, { only: 'lint', yes: true });

    const source = tree.read('eslint.config.mjs', 'utf8') ?? '';
    expect(source).toContain('// megamono eslint imports start');
    expect(source).toContain('// megamono eslint rules end');
    expect(readJson(tree, '.megamono/artifacts.json').artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'lint.eslint-imports' }),
        expect.objectContaining({ id: 'lint.eslint-rules' }),
      ]),
    );
  });

  it('is a no-op when rerun with the same options', async () => {
    await workspaceInitGenerator(tree, options);
    const changesAfterFirstRun = tree.listChanges();
    await workspaceInitGenerator(tree, options);
    expect(tree.listChanges()).toEqual(changesAfterFirstRun);
  });

  it('preserves a modified managed project configuration', async () => {
    await workspaceInitGenerator(tree, options);
    const project = readProjectConfiguration(tree, 'megamono');
    const targets = Object.fromEntries(
      Object.entries(project.targets ?? {}).filter(
        ([name]) => name !== 'import',
      ),
    );
    updateProjectConfiguration(tree, 'megamono', { ...project, targets });

    await workspaceInitGenerator(tree, options);

    expect(readProjectConfiguration(tree, 'megamono').targets?.import).toBe(
      undefined,
    );
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
    await workspaceInitGenerator(tree, {
      ...options,
      defaultPlatform: 'node',
    });
    expect(readProjectConfiguration(tree, 'root-app').tags).toEqual([
      'platform:node',
      'scope:shared',
      'type:app',
      'visibility:internal',
    ]);
    expect(readJson(tree, 'megamono.json').conventions.rules).toEqual(
      expect.objectContaining({
        'module-boundaries': { severity: 'warning' },
        'require-tags': { severity: 'warning' },
      }),
    );
    expect(readJson(tree, 'megamono.json').adoption.ratchets).toContainEqual({
      rule: 'require-tags',
      initialCount: 4,
      targetSeverity: 'error',
    });
  });

  it('keeps fresh bootstrap structural rules at their default severity', async () => {
    addProjectConfiguration(tree, 'web', {
      root: 'apps/web',
      projectType: 'application',
      targets: {},
    });

    await workspaceInitGenerator(tree, {
      only: 'lint',
      yes: true,
      bootstrap: true,
      defaultPlatform: 'web',
    });

    expect(readJson(tree, 'megamono.json').conventions.rules).toEqual({});
    expect(readJson(tree, 'megamono.json').adoption.ratchets).toEqual([]);
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

    await workspaceInitGenerator(tree, options);

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

  it('refuses an occupied managed path before mutating the tree', async () => {
    tree.write('.github/workflows/megamono-ci.yml', 'repository workflow\n');
    const changes = tree.listChanges();

    await expect(
      workspaceInitGenerator(tree, { only: 'ci', yes: true }),
    ).rejects.toMatchObject({
      diagnosticCode: 'workspace-init-conflict',
      exitCode: 3,
    });
    expect(tree.listChanges()).toEqual(changes);
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

  it('does not reclaim an ejected managed workflow on rerun', async () => {
    await workspaceInitGenerator(tree, { only: 'ci', yes: true });
    const registry = readJson(tree, '.megamono/artifacts.json');
    registry.artifacts = registry.artifacts.map(
      (artifact: { id: string; state: string }) =>
        artifact.id === 'ci.affected'
          ? { ...artifact, state: 'ejected' }
          : artifact,
    );
    tree.write(
      '.megamono/artifacts.json',
      `${JSON.stringify(registry, null, 2)}\n`,
    );
    tree.write(
      '.github/workflows/megamono-ci.yml',
      'repository-owned workflow\n',
    );

    await workspaceInitGenerator(tree, { only: 'ci', yes: true });

    expect(tree.read('.github/workflows/megamono-ci.yml', 'utf8')).toBe(
      'repository-owned workflow\n',
    );
    expect(
      readJson(tree, '.megamono/artifacts.json').artifacts.find(
        ({ id }: { id: string }) => id === 'ci.affected',
      ).state,
    ).toBe('ejected');
  });

  it('updates a pristine managed workflow from its recorded installed hash', async () => {
    await workspaceInitGenerator(tree, { only: 'ci', yes: true });
    const oldTemplate = 'name: Old Megamono CI\n';
    const oldHash = hashArtifactBytes(oldTemplate);
    const registry = readJson(tree, '.megamono/artifacts.json');
    registry.artifacts = registry.artifacts.map((artifact: { id: string }) =>
      artifact.id === 'ci.affected'
        ? {
            ...artifact,
            templateHash: oldHash,
            installedHash: oldHash,
            sourceVersion: '0.0.0-old',
          }
        : artifact,
    );
    tree.write('.megamono/artifacts.json', JSON.stringify(registry));
    tree.write('.github/workflows/megamono-ci.yml', oldTemplate);

    await workspaceInitGenerator(tree, { only: 'ci', yes: true });

    expect(tree.read('.github/workflows/megamono-ci.yml', 'utf8')).toContain(
      'nrwl/nx-set-shas@v5',
    );
    const updated = readJson(tree, '.megamono/artifacts.json').artifacts.find(
      ({ id }: { id: string }) => id === 'ci.affected',
    );
    expect(updated.installedHash).not.toBe(oldHash);
    expect(updated.installedHash).toBe(updated.templateHash);
  });

  it('preserves a modified managed workflow during an upgrade', async () => {
    await workspaceInitGenerator(tree, { only: 'ci', yes: true });
    const customized = `${tree.read('.github/workflows/megamono-ci.yml', 'utf8')}# repository customization\n`;
    tree.write('.github/workflows/megamono-ci.yml', customized);

    await workspaceInitGenerator(tree, { only: 'ci', yes: true });

    expect(tree.read('.github/workflows/megamono-ci.yml', 'utf8')).toBe(
      customized,
    );
  });

  it('recreates a missing managed artifact after guided confirmation', async () => {
    await workspaceInitGenerator(tree, { only: 'docs', yes: true });
    tree.delete('content-collections.ts');
    const stdinDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      'isTTY',
    );
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      'isTTY',
    );
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    vi.mocked(prompt).mockResolvedValueOnce({ confirmed: true });

    try {
      await workspaceInitGenerator(tree, { only: 'docs' });
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
    }

    expect(tree.exists('content-collections.ts')).toBe(true);
  });

  it('updates only a pristine managed docs project', async () => {
    await workspaceInitGenerator(tree, { only: 'docs', yes: true });
    const oldProject = `${JSON.stringify({
      name: 'megamono-docs',
      root: 'docs',
      projectType: 'library',
      targets: {},
    })}\n`;
    const oldHash = hashArtifactBytes(oldProject);
    const registry = readJson(tree, '.megamono/artifacts.json');
    registry.artifacts = registry.artifacts.map((artifact: { id: string }) =>
      artifact.id === 'docs.project'
        ? {
            ...artifact,
            templateHash: oldHash,
            installedHash: oldHash,
            sourceVersion: '0.0.0-old',
          }
        : artifact,
    );
    tree.write('.megamono/artifacts.json', JSON.stringify(registry));
    tree.write('docs/project.json', oldProject);

    await workspaceInitGenerator(tree, { only: 'docs', yes: true });

    expect(readProjectConfiguration(tree, 'megamono-docs').targets).toEqual(
      expect.objectContaining({
        validate: expect.objectContaining({
          executor: '@megamono/plugin:docs-validate',
        }),
      }),
    );
    const updated = readJson(tree, '.megamono/artifacts.json').artifacts.find(
      ({ id }: { id: string }) => id === 'docs.project',
    );
    expect(updated.installedHash).not.toBe(oldHash);
    expect(updated.installedHash).toBe(updated.templateHash);
  });

  it('preserves a modified managed docs project', async () => {
    await workspaceInitGenerator(tree, { only: 'docs', yes: true });
    const customized = {
      ...readProjectConfiguration(tree, 'megamono-docs'),
      targets: {
        ...readProjectConfiguration(tree, 'megamono-docs').targets,
        custom: { executor: 'nx:noop' },
      },
    };
    updateProjectConfiguration(tree, 'megamono-docs', customized);
    await formatFiles(tree);
    const customizedSource = tree.read('docs/project.json', 'utf8');

    await workspaceInitGenerator(tree, { only: 'docs', yes: true });

    expect(tree.read('docs/project.json', 'utf8')).toBe(customizedSource);
  });

  it('updates only a pristine managed AGENTS section', async () => {
    tree.write('AGENTS.md', '# Repository-owned instructions\n');
    await workspaceInitGenerator(tree, { only: 'agents', yes: true });
    const oldBody = '\n## Old managed instructions\n';
    const oldHash = hashArtifactBytes(oldBody);
    const agents = tree.read('AGENTS.md', 'utf8') ?? '';
    tree.write(
      'AGENTS.md',
      agents.replace(
        /<!-- megamono instructions start -->[\s\S]*<!-- megamono instructions end -->/,
        `<!-- megamono instructions start -->${oldBody}<!-- megamono instructions end -->`,
      ),
    );
    const registry = readJson(tree, '.megamono/artifacts.json');
    registry.artifacts = registry.artifacts.map((artifact: { id: string }) =>
      artifact.id === 'agents.instructions'
        ? {
            ...artifact,
            templateHash: oldHash,
            installedHash: oldHash,
            sourceVersion: '0.0.0-old',
          }
        : artifact,
    );
    tree.write('.megamono/artifacts.json', JSON.stringify(registry));

    await workspaceInitGenerator(tree, { only: 'agents', yes: true });

    const updated = tree.read('AGENTS.md', 'utf8') ?? '';
    expect(updated).toContain('# Repository-owned instructions');
    expect(updated).toContain('## Affected CI');
    expect(updated).not.toContain('## Old managed instructions');
  });

  it('preserves a modified managed AGENTS section', async () => {
    await workspaceInitGenerator(tree, { only: 'agents', yes: true });
    const customized = (tree.read('AGENTS.md', 'utf8') ?? '').replace(
      '## Affected CI',
      '## Repository-customized CI',
    );
    tree.write('AGENTS.md', customized);

    await workspaceInitGenerator(tree, { only: 'agents', yes: true });

    expect(tree.read('AGENTS.md', 'utf8')).toBe(customized);
  });

  it('updates ignore entries without claiming surrounding content', async () => {
    tree.write('.gitignore', 'repository-cache/\n');
    await workspaceInitGenerator(tree, { only: 'ci', yes: true });
    await workspaceInitGenerator(tree, { only: 'health', yes: true });

    const source = tree.read('.gitignore', 'utf8') ?? '';
    expect(source).toContain('repository-cache/');
    expect(source).toContain('.megamono/health.json');
    expect(source.match(/# megamono ignore entries start/g)).toHaveLength(1);
  });

  it('registers only detected supported inference plugins and manifests', async () => {
    tree.write('apps/apple/Package.swift', '// swift-tools-version: 6.2\n');
    tree.write('crates/tool/Cargo.toml', '[package]\nname = "tool"\n');
    tree.write('apps/worker/wrangler.jsonc', '{"name":"worker"}\n');
    tree.write('services/go/go.mod', 'module example.com/service\n');

    await workspaceInitGenerator(tree, { only: 'inference', yes: true });

    expect(readJson(tree, 'nx.json').plugins).toEqual([
      '@megamono/nx-apple',
      '@megamono/nx-cargo',
      '@megamono/nx-cloudflare',
    ]);
    expect(readJson(tree, 'package.json').devDependencies).toMatchObject({
      '@megamono/nx-apple': '0.0.1',
      '@megamono/nx-cargo': '0.0.1',
      '@megamono/nx-cloudflare': '0.0.1',
    });
    expect(readJson(tree, 'megamono.json').adoption.inference).toEqual({
      apple: {
        plugin: '@megamono/nx-apple',
        manifests: ['apps/apple/Package.swift'],
      },
      cargo: {
        plugin: '@megamono/nx-cargo',
        manifests: ['crates/tool/Cargo.toml'],
      },
      cloudflare: {
        plugin: '@megamono/nx-cloudflare',
        manifests: ['apps/worker/wrangler.jsonc'],
      },
    });
    expect(readJson(tree, 'megamono.json').platforms).toEqual([
      'apple',
      'rust',
      'worker',
    ]);
    expect(JSON.stringify(readJson(tree, 'nx.json'))).not.toContain('go.mod');
  });

  it('records calling-scaffolder platform and service decisions', async () => {
    await workspaceInitGenerator(tree, {
      only: 'docs,agents,ci,lint,skills,health,inference',
      yes: true,
      platforms: 'web,node',
      serviceRunner: 'springbar',
      serviceRequirements: '{"postgres":"17"}',
    });

    expect(readJson(tree, 'megamono.json')).toMatchObject({
      platforms: ['node', 'web'],
      services: {
        runner: 'springbar',
        requirements: { postgres: '17' },
      },
    });
  });
});
