import { addProjectConfiguration } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  WorkspaceInitError,
  createWorkspaceInitPlan,
  parseWorkspaceInitModules,
  renderWorkspaceInitPlan,
  renderWorkspaceInitCompletion,
  renderWorkspaceInitSurvey,
  surveyWorkspaceInit,
} from './workspace-init-plan';

describe('workspace init survey and plan', () => {
  it('produces byte-stable JSON without mutating the tree', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({
        packageManager: 'npm@11.5.2',
        engines: { node: '>=24 <25' },
        devDependencies: { nx: '23.1.2', typescript: '6.0.2' },
      }),
    );
    tree.write('package-lock.json', '{}');
    tree.write('apps/apple/Package.swift', '// swift-tools-version: 6.0');
    tree.write('crates/tool/Cargo.toml', '[package]');
    tree.write('apps/worker/wrangler.jsonc', '{"name":"worker"}');
    tree.write('docs/legacy.md', '# Legacy');
    tree.write(
      'architecture/decisions/decision.md',
      '---\nid: decision-platform-20260825-runtime\ntype: decision\n---\n',
    );
    tree.write('rfcs/cache.md', '# Cache RFC');
    tree.write('.agents/skills/review/SKILL.md', '# Agent skill');
    tree.write('AGENTS.md', '# Agent instructions');
    addProjectConfiguration(tree, 'web', {
      root: 'apps/web',
      projectType: 'application',
      targets: { build: { executor: 'nx:noop' } },
      tags: ['type:app'],
    });
    const changes = tree.listChanges();
    const first = renderWorkspaceInitSurvey(surveyWorkspaceInit(tree), 'json');
    const second = renderWorkspaceInitSurvey(surveyWorkspaceInit(tree), 'json');

    expect(first).toBe(second);
    expect(JSON.parse(first)).toMatchObject({
      manifests: {
        apple: ['apps/apple/Package.swift'],
        cargo: ['crates/tool/Cargo.toml'],
        cloudflare: ['apps/worker/wrangler.jsonc'],
      },
      projects: [{ name: 'web', targets: ['build'] }],
      documentation: {
        corpusDirectories: ['architecture/decisions', 'rfcs'],
        classifications: [
          {
            path: 'architecture/decisions/decision.md',
            type: 'decision',
            proposedId: 'decision-platform-20260825-runtime',
            basis: 'lifecycle-metadata',
          },
          {
            path: 'rfcs/cache.md',
            type: 'research',
            proposedId: null,
            basis: 'research-directory',
          },
        ],
        unclassified: ['docs/legacy.md'],
      },
    });
    expect(JSON.parse(first).documentation.markdown).not.toContain(
      '.agents/skills/review/SKILL.md',
    );
    expect(JSON.parse(first).documentation.markdown).not.toContain('AGENTS.md');
    expect(renderWorkspaceInitSurvey(surveyWorkspaceInit(tree))).toContain(
      'stable ID: requires reviewed migration',
    );
    expect(tree.listChanges()).toEqual(changes);
  });

  it('orders module selection canonically and reports reductions', () => {
    const tree = createTreeWithEmptyWorkspace();
    const plan = createWorkspaceInitPlan(tree, {
      only: 'health,agents',
    });

    expect(parseWorkspaceInitModules('skills,docs,skills')).toEqual([
      'docs',
      'skills',
    ]);
    expect(plan.modules).toEqual(['agents', 'health']);
    expect(plan.reductions.map(({ capability }) => capability)).toEqual([
      'spec-drift',
      'stale-plans',
    ]);
    expect(plan.operations.map(({ order }) => order)).toEqual(
      plan.operations.map((_, index) => index + 1),
    );
    expect(renderWorkspaceInitPlan(plan)).toContain('health.spec-drift');
  });

  it('plans explicit repository-owned Node pin files without overwriting conflicts', () => {
    const tree = createTreeWithEmptyWorkspace();
    const plan = createWorkspaceInitPlan(tree, {
      only: 'agents',
      toolchainPin: 'both',
      toolchainNode: '22.23.1',
    });
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: '.nvmrc', action: 'add' }),
        expect.objectContaining({ target: '.node-version', action: 'add' }),
      ]),
    );
    tree.write('.nvmrc', '20.19.0\n');
    expect(
      createWorkspaceInitPlan(tree, {
        only: 'agents',
        toolchainPin: 'nvmrc',
        toolchainNode: '22.23.1',
      }).conflicts,
    ).toEqual([
      '.nvmrc already pins repository-owned Node 20.19.0; requested 22.23.1.',
    ]);
  });

  it('recommends retaining equivalent repository-owned affected CI', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      '.github/workflows/repository-ci.yml',
      `jobs:\n  verify:\n    steps:\n      - uses: nrwl/nx-set-shas@v5\n      - run: npm exec nx -- affected -t lint test build\n`,
    );

    const survey = surveyWorkspaceInit(tree);

    expect(survey.recommendations).toEqual([
      {
        module: 'ci',
        action: 'skip',
        paths: ['.github/workflows/repository-ci.yml'],
        reason:
          'Existing workflows establish an affected base/head and run lint, test, and build through Nx affected.',
      },
    ]);
    expect(renderWorkspaceInitSurvey(survey)).toContain(
      'ci: skip; retain .github/workflows/repository-ci.yml',
    );

    tree.write('.github/workflows/plain.yml', 'jobs: {}\n');
    expect(surveyWorkspaceInit(tree).recommendations).toHaveLength(1);
  });

  it('uses the stable decision-required classification for missing input', () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'app', {
      root: 'apps/app',
      projectType: 'application',
      targets: {},
    });

    expect(() => createWorkspaceInitPlan(tree, { yes: true })).toThrowError(
      expect.objectContaining<Partial<WorkspaceInitError>>({
        diagnosticCode: 'workspace-init-decision-required',
        exitCode: 4,
      }),
    );
    expect(() =>
      createWorkspaceInitPlan(tree, {
        yes: true,
        only: 'lint',
      }),
    ).toThrow(/defaultPlatform is required/);
  });

  it('classifies inferred Nx libraries and applications from repository evidence', () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'data', {
      root: 'libs/data',
      targets: { build: { executor: 'nx:run-commands' } },
    });
    tree.write('libs/data/tsconfig.lib.json', '{}');
    addProjectConfiguration(tree, 'site', {
      root: 'apps/site',
      targets: {
        dev: {
          executor: 'nx:run-commands',
          options: { command: 'next dev' },
        },
      },
    });
    tree.write('apps/site/next.config.js', 'module.exports = {};\n');

    const survey = surveyWorkspaceInit(tree);

    expect(survey.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'data', type: 'library' }),
        expect.objectContaining({
          name: 'site',
          type: 'application',
          platform: 'web',
        }),
      ]),
    );
    expect(createWorkspaceInitPlan(tree, { only: 'lint' }).decisions).toEqual(
      [],
    );
  });

  it('requires and consumes an adoption map for conflicting project evidence', () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'mixed', {
      root: 'packages/mixed',
      targets: { serve: { executor: 'nx:run-commands' } },
    });
    tree.write('packages/mixed/tsconfig.lib.json', '{}');
    expect(createWorkspaceInitPlan(tree, { only: 'lint' }).decisions).toEqual([
      'adoptionMap project type is required for: mixed.',
    ]);

    tree.write(
      '.megamono/adoption-map.json',
      JSON.stringify({
        projects: { mixed: { type: 'data', platform: 'node' } },
      }),
    );
    const resolved = createWorkspaceInitPlan(tree, {
      only: 'lint',
      adoptionMap: '.megamono/adoption-map.json',
    });
    expect(resolved.decisions).toEqual([]);
    expect(
      resolved.operations.find(
        ({ target }) => target === 'nx-project:mixed#tags',
      )?.detail,
    ).toContain('type:data');
  });

  it('previews every config-key and docs-structure mutation', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('apps/apple/Package.swift', '// swift-tools-version: 6.0');
    addProjectConfiguration(tree, 'web', {
      root: 'apps/web',
      projectType: 'application',
      targets: {},
    });

    const plan = createWorkspaceInitPlan(tree, {
      only: 'docs,agents,lint,inference',
      defaultPlatform: 'web',
    });
    const targets = plan.operations.map(({ target }) => target);

    expect(targets).toEqual(
      expect.arrayContaining([
        'docs/archives/INDEX.md',
        'docs/archives/research/.gitkeep',
        'docs/DESIGN.md',
        'tsconfig.base.json#compilerOptions.paths.content-collections',
        'package.json#devDependencies',
        'nx-project:web#tags',
        'nx.json#plugins',
      ]),
    );
    expect(
      plan.operations.find(({ target }) => target === 'nx-project:web#tags')
        ?.detail,
    ).toContain('platform:web');
  });

  it('classifies invalid module options separately from unresolved input', () => {
    expect(() => parseWorkspaceInitModules('docs,unknown')).toThrowError(
      expect.objectContaining<Partial<WorkspaceInitError>>({
        diagnosticCode: 'workspace-init-options',
        exitCode: 2,
      }),
    );
  });

  it('reports occupied managed paths before application', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('.github/workflows/megamono-ci.yml', 'repository workflow');
    tree.write('content-collections.ts', 'repository config');
    const plan = createWorkspaceInitPlan(tree, { only: 'ci,docs' });

    expect(plan.conflicts).toEqual([
      'content-collections.ts is occupied by a repository-owned configuration. Select it with --docsLoaderMode=adopt when compatible, or choose a separate --docsLoader, --docsModule, and --docsOutput.',
      '.github/workflows/megamono-ci.yml is occupied without Megamono ownership metadata.',
    ]);
  });

  it('detects nested Content Collections and plans a collision-free separate loader', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'apps/site/content-collections.ts',
      `export default { existing: true };\n`,
    );
    tree.write(
      'tsconfig.base.json',
      JSON.stringify({
        compilerOptions: {
          paths: {
            'content-collections': ['apps/site/.content-collections/generated'],
          },
        },
      }),
    );
    expect(surveyWorkspaceInit(tree).existing.contentCollections).toEqual([
      'apps/site/content-collections.ts',
    ]);

    const plan = createWorkspaceInitPlan(tree, {
      only: 'docs',
      docsLoader: '.megamono/content-collections.ts',
      docsModule: 'megamono-docs',
      docsOutput: '.megamono/content-collections',
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: '.megamono/content-collections.ts',
          action: 'add',
        }),
        expect.objectContaining({
          target: 'tsconfig.base.json#compilerOptions.paths.megamono-docs',
        }),
      ]),
    );
  });

  it('adopts only an explicitly compatible repository docs loader', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'apps/site/content-collections.ts',
      `const repoDocs = { name: 'repoDocs' };\nconst archivedDocs = { name: 'archivedDocs' };\nexport default { repoDocs, archivedDocs };\n`,
    );
    expect(
      createWorkspaceInitPlan(tree, {
        only: 'docs',
        docsLoader: 'apps/site/content-collections.ts',
        docsLoaderMode: 'adopt',
      }).conflicts,
    ).toEqual([]);
  });

  it('does not report current or ejected registered artifacts as conflicts', () => {
    const tree = createTreeWithEmptyWorkspace();
    const hash = `sha256:${'0'.repeat(64)}`;
    tree.write('content-collections.ts', 'managed');
    tree.write('.github/workflows/megamono-ci.yml', 'repository-owned');
    tree.write(
      '.megamono/artifacts.json',
      JSON.stringify({
        schemaVersion: 1,
        artifacts: [
          {
            id: 'ci.affected',
            module: 'ci',
            mode: 'managed',
            target: '.github/workflows/megamono-ci.yml',
            sourceVersion: '1.0.0',
            templateHash: hash,
            installedHash: hash,
            state: 'ejected',
            ejectable: true,
          },
          {
            id: 'docs.loader',
            module: 'docs',
            mode: 'managed',
            target: 'content-collections.ts',
            sourceVersion: '1.0.0',
            templateHash: hash,
            installedHash: hash,
            state: 'managed',
            ejectable: true,
          },
        ],
      }),
    );

    expect(
      createWorkspaceInitPlan(tree, { only: 'ci,docs' }).conflicts,
    ).toEqual([]);
  });

  it('renders a stable completion summary with capability gaps and follow-ups', () => {
    const tree = createTreeWithEmptyWorkspace();
    const plan = createWorkspaceInitPlan(tree, { only: 'health' });
    const summary = renderWorkspaceInitCompletion(plan);

    expect(summary).toContain('## Modules adopted\n\n- health');
    expect(summary).toContain('- docs');
    expect(summary).toContain('health.spec-drift');
    expect(summary).toContain('`pnpm exec nx run megamono:check`');
    expect(summary).toContain('`pnpm exec nx run megamono:health`');
    expect(summary).not.toContain('megamono-docs:validate');
  });
});
