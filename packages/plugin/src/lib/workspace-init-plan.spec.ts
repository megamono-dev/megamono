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
      adoptionTemplates: {
        projects: {
          projects: {
            web: { type: 'app', platform: '<review-platform>' },
          },
        },
        documentation: {
          documents: {
            'architecture/decisions/decision.md': {
              id: 'decision-platform-20260825-runtime',
              type: 'decision',
              date: '<review-date>',
            },
            'rfcs/cache.md': {
              id: '<review-research-id>',
              type: 'research',
              summary: 'Cache RFC',
            },
          },
        },
      },
    });
    expect(JSON.parse(first).documentation.markdown).not.toContain(
      '.agents/skills/review/SKILL.md',
    );
    expect(JSON.parse(first).documentation.markdown).not.toContain('AGENTS.md');
    expect(renderWorkspaceInitSurvey(surveyWorkspaceInit(tree))).toContain(
      'stable ID: requires reviewed migration',
    );
    expect(renderWorkspaceInitSurvey(surveyWorkspaceInit(tree))).toContain(
      '## Copy-ready adoption maps',
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

  it('classifies numbered specification corpora with stable path-preserving IDs', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({ name: '@quickzones/workspace' }),
    );
    tree.write('docs/specs/0012-routing.md', '# Routing\n');

    expect(surveyWorkspaceInit(tree).documentation).toMatchObject({
      corpusDirectories: ['docs/specs'],
      classifications: [
        {
          path: 'docs/specs/0012-routing.md',
          type: 'spec',
          proposedId: 'spec-quickzones-0012',
          basis: 'numbered-corpus',
        },
      ],
      unclassified: [],
    });
  });

  it('preflights module dependency and peer compatibility before mutation', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({
        devDependencies: {
          nx: '22.2.3',
          typescript: '5.9.3',
          eslint: '^7.32.0',
          '@content-collections/core': '^0.15.0',
          zod: '^3.25.0',
        },
      }),
    );

    const plan = createWorkspaceInitPlan(tree, { only: 'docs,lint' });
    expect(plan.conflicts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('eslint@^7.32.0'),
        expect.stringContaining('zod@^3.25.0'),
      ]),
    );
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'retain',
          target: 'package.json#devDependencies.@content-collections/core',
        }),
      ]),
    );
  });

  it('carries active host readiness failures into dry-run planning', () => {
    const tree = createTreeWithEmptyWorkspace();
    const host = {
      platform: 'darwin' as const,
      active: { node: 'v26.5.0', pnpm: '6.35.1' },
      selectedPackageManager: 'pnpm' as const,
      ready: false,
      issues: ['Node.js v26.5.0 is unsupported for adoption.'],
      activation: ['Run `nvm use` from the workspace root.'],
    };
    const survey = surveyWorkspaceInit(tree, { host });
    const plan = createWorkspaceInitPlan(tree, {
      only: 'agents',
      packageManager: 'pnpm',
      host,
    });

    expect(plan.conflicts).toContain(
      'Node.js v26.5.0 is unsupported for adoption.',
    );
    expect(renderWorkspaceInitSurvey(survey)).toContain(
      '- Active package-manager version: 6.35.1',
    );
    expect(renderWorkspaceInitSurvey(survey)).toContain(
      'Run `nvm use` from the workspace root.',
    );
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
          'Existing repository-owned CI runs lint, test, and build through Nx affected or full-workspace run-many.',
      },
    ]);
    expect(renderWorkspaceInitSurvey(survey)).toContain(
      'ci: skip; retain .github/workflows/repository-ci.yml',
    );

    tree.write('.github/workflows/plain.yml', 'jobs: {}\n');
    expect(surveyWorkspaceInit(tree).recommendations).toHaveLength(1);
  });

  it('recognizes mature full-workspace CI and plans a bounded reusable alternative', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      '.github/workflows/repository-ci.yml',
      'jobs:\n  verify:\n    steps:\n      - run: pnpm exec nx run-many -t lint test build\n',
    );

    const automatic = createWorkspaceInitPlan(tree, { only: 'ci' });
    expect(automatic.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'retain',
          target: '.github/workflows/repository-ci.yml',
        }),
      ]),
    );
    expect(automatic.conflicts).toEqual([]);

    const reusable = createWorkspaceInitPlan(tree, {
      only: 'ci',
      ciMode: 'reusable',
    });
    expect(reusable.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'add',
          target: '.github/workflows/megamono-ci-reusable.yml',
        }),
      ]),
    );
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
    const survey = surveyWorkspaceInit(tree);
    expect(survey.existing.contentCollections).toEqual([
      'apps/site/content-collections.ts',
    ]);
    expect(survey.recommendations).toContainEqual({
      module: 'docs',
      action: 'configure',
      paths: ['apps/site/content-collections.ts'],
      reason:
        'Keep the existing Content Collections setup separate by passing --docsLoader=.megamono/content-collections.ts --docsModule=megamono-docs --docsOutput=.megamono/content-collections, or explicitly adopt a compatible loader with --docsLoaderMode=adopt.',
    });
    expect(renderWorkspaceInitSurvey(survey)).toContain(
      '--docsLoader=.megamono/content-collections.ts --docsModule=megamono-docs --docsOutput=.megamono/content-collections',
    );

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

  it('does not recommend configuring around the recorded Megamono docs loader', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'megamono.json',
      JSON.stringify({
        docs: {
          loader: '.megamono/content-collections.ts',
          module: 'megamono-docs',
          output: '.megamono/content-collections',
        },
      }),
    );
    tree.write(
      '.megamono/content-collections.ts',
      'export default { collections: [] };\n',
    );

    expect(surveyWorkspaceInit(tree).recommendations).toEqual([]);
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
    expect(summary).toContain('`npm exec nx -- run megamono:check`');
    expect(summary).toContain('`npm exec nx -- run megamono:health`');
    expect(summary).not.toContain('megamono-docs:validate');
  });

  it.each([
    ['npm', 'package-lock.json', 'npm exec nx --'],
    ['pnpm', 'pnpm-lock.yaml', 'pnpm exec nx'],
    ['yarn', 'yarn.lock', 'yarn nx'],
    ['bun', 'bun.lock', 'bunx nx'],
  ] as const)(
    'renders %s planning and completion commands without manager leakage',
    (manager, lockfile, nx) => {
      const tree = createTreeWithEmptyWorkspace();
      tree.write(lockfile, '');
      const plan = createWorkspaceInitPlan(tree, { only: 'health' });

      expect(plan.packageManager).toBe(manager);
      expect(renderWorkspaceInitPlan(plan)).toContain(
        `Package manager: ${manager}`,
      );
      expect(renderWorkspaceInitCompletion(plan)).toContain(
        `\`${nx} run megamono:check\``,
      );
    },
  );
});
