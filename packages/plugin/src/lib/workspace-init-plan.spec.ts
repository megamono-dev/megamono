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
    tree.write('render.yaml', 'services: []');
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
        render: ['render.yaml'],
      },
      projects: [{ name: 'web', targets: ['build'] }],
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          module: 'docs',
          detected: true,
          status: 'importable',
        }),
        expect.objectContaining({
          module: 'inference',
          detected: true,
          status: 'importable',
        }),
      ]),
      inventory: {
        schemaVersion: 1,
        projects: [
          {
            name: 'web',
            root: 'apps/web',
            frameworks: [],
            externalPackages: [],
            environmentNames: [],
            serviceKinds: [],
          },
        ],
      },
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
        render: { serviceProjects: {} },
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
    expect(renderWorkspaceInitSurvey(surveyWorkspaceInit(tree))).toContain(
      '## Capability adoption assessment',
    );
    expect(tree.listChanges()).toEqual(changes);
  });

  it('excludes generated directories and repository-ignored files from surveys', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      '.gitignore',
      'vendor/generated/\npackages/tool/generated-docs/\n',
    );
    tree.write('docs/kept.md', '# Kept\n');
    tree.write('vendor/generated/ignored.md', '# Ignored\n');
    tree.write('apps/site/.next/server/generated.md', '# Next output\n');
    tree.write(
      'basemarks-swift/.build/checkouts/dependency/README.md',
      '# Dependency\n',
    );
    tree.write('packages/tool/.gitignore', 'local-output/\n');
    tree.write('packages/tool/local-output/nested.md', '# Nested ignore\n');
    tree.write(
      'packages/tool/generated-docs/also-ignored.md',
      '# Root ignore\n',
    );

    expect(surveyWorkspaceInit(tree).documentation.markdown).toEqual([
      'docs/kept.md',
    ]);
  });

  it('inventories nested frameworks, databases, services, and partial Render deployment evidence', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({
        dependencies: {
          '@nestjs/bullmq': '^11.0.0',
          '@nestjs/core': '^11.0.0',
          bullmq: '^5.0.0',
          next: '^15.0.0',
          redis: '^5.0.0',
        },
      }),
    );
    addProjectConfiguration(tree, 'site', {
      root: 'apps/site',
      projectType: 'application',
      targets: { dev: { executor: '@nx/next:server' } },
    });
    tree.write('apps/site/next.config.mjs', 'export default {};\n');
    tree.write(
      'apps/site/src/pages/index.tsx',
      "import { createClient } from 'redis';\nprocess.env.REDIS_URL;\n",
    );
    addProjectConfiguration(tree, 'worker', {
      root: 'apps/worker',
      projectType: 'application',
      targets: { serve: { executor: '@nx/js:node' } },
    });
    tree.write(
      'apps/worker/src/main.ts',
      "import { Processor } from '@nestjs/bullmq';\nimport { Queue } from 'bullmq';\n",
    );
    addProjectConfiguration(tree, 'database-auth', {
      root: 'libs/prisma/schema-auth',
      projectType: 'library',
      targets: {},
    });
    tree.write(
      'libs/prisma/schema-auth/prisma/schema.prisma',
      'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
    );
    tree.write(
      'libs/prisma/schema-auth/prisma/migrations/init/migration.sql',
      'SELECT 1;\n',
    );
    tree.write('Procfile', 'web: nx run api:serve:production\n');
    tree.write('apps/worker/Dockerfile', 'RUN pnpm exec nx build worker\n');

    const survey = surveyWorkspaceInit(tree);

    expect(survey.inventory).toMatchObject({
      schemaVersion: 1,
      projects: expect.arrayContaining([
        expect.objectContaining({
          name: 'site',
          nextRouter: 'pages',
          externalPackages: ['redis'],
          environmentNames: ['REDIS_URL'],
          serviceKinds: ['cache'],
        }),
        expect.objectContaining({
          name: 'worker',
          externalPackages: ['@nestjs/bullmq', 'bullmq'],
          serviceKinds: ['queue'],
        }),
      ]),
      databases: [
        expect.objectContaining({
          name: null,
          provider: 'postgresql',
          project: 'database-auth',
          migrations: 'libs/prisma/schema-auth/prisma/migrations',
        }),
      ],
      services: expect.arrayContaining([
        expect.objectContaining({ provider: 'redis', projects: ['site'] }),
        expect.objectContaining({ provider: 'bullmq', projects: ['worker'] }),
      ]),
      deployments: expect.arrayContaining([
        expect.objectContaining({
          provider: 'render',
          authority: 'partial-marker',
          paths: ['Procfile'],
          services: ['web'],
        }),
        expect.objectContaining({
          provider: 'docker',
          paths: ['apps/worker/Dockerfile'],
          services: ['worker'],
          containers: [
            {
              dockerfile: 'apps/worker/Dockerfile',
              project: 'worker',
              projectCandidates: ['worker'],
            },
          ],
        }),
      ]),
    });
    expect(survey.inventory.ambiguities).toContain(
      'Render has only a Procfile marker (Procfile); dashboard-owned services cannot be inventoried without an explicit adoption map or render.yaml.',
    );
    expect(renderWorkspaceInitSurvey(survey)).toContain(
      'Integration inventory (schema v1)',
    );
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

  it('requires a reviewed mapping for root-level Render services', () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'api', {
      root: 'apps/api',
      projectType: 'application',
      targets: { build: { executor: 'nx:noop' } },
    });
    tree.write(
      'render.yaml',
      [
        'services:',
        '  - type: web',
        '    name: fontstack-api',
        '    buildCommand: pnpm exec nx build api',
        '    startCommand: pnpm exec nx run api:serve:production',
        '',
      ].join('\n'),
    );

    const survey = surveyWorkspaceInit(tree);
    expect(survey.inventory.deployments).toContainEqual(
      expect.objectContaining({
        provider: 'render',
        services: ['fontstack-api'],
        renderServices: [
          {
            name: 'fontstack-api',
            rootDir: null,
            projectCandidates: ['api'],
          },
        ],
      }),
    );
    expect(survey.adoptionTemplates.render).toEqual({
      serviceProjects: {
        'fontstack-api': { project: 'api', root: 'apps/api' },
      },
    });
    expect(
      createWorkspaceInitPlan(tree, { only: 'inference' }).decisions,
    ).toEqual([expect.stringContaining('fontstack-api')]);
    expect(
      createWorkspaceInitPlan(tree, {
        only: 'inference',
        renderServiceProjects:
          '{"fontstack-api":{"project":"api","root":"apps/api"}}',
      }).decisions,
    ).toEqual([]);
    expect(
      createWorkspaceInitPlan(tree, {
        only: 'inference',
        renderServiceProjects:
          '{"fontstack-api":{"project":"api","root":"apps/wrong"}}',
      }).conflicts,
    ).toEqual([expect.stringContaining('its Nx root is apps/api')]);
  });

  it('expands named adoption profiles and rejects a conflicting explicit selection', () => {
    const tree = createTreeWithEmptyWorkspace();
    expect(
      createWorkspaceInitPlan(tree, { profile: 'minimal' }).modules,
    ).toEqual(['lint', 'health']);
    expect(createWorkspaceInitPlan(tree, { profile: 'pilot' }).modules).toEqual(
      ['lint', 'health', 'inference'],
    );
    expect(
      createWorkspaceInitPlan(tree, { profile: 'platform' }).modules,
    ).toEqual(['ci', 'release', 'lint', 'health', 'inference']);
    expect(createWorkspaceInitPlan(tree, { profile: 'full' }).modules).toEqual([
      'docs',
      'agents',
      'ci',
      'release',
      'lint',
      'skills',
      'health',
      'inference',
    ]);
    expect(() =>
      createWorkspaceInitPlan(tree, { only: 'health', profile: 'minimal' }),
    ).toThrow(/either --only or --profile/);
  });

  it('groups selected modules into deterministic suggested commit boundaries', () => {
    const tree = createTreeWithEmptyWorkspace();
    const plan = createWorkspaceInitPlan(tree, { only: 'lint,health' });

    expect(plan.suggestedCommitBatches).toEqual([
      expect.objectContaining({
        id: 'baseline-lint',
        modules: ['baseline', 'lint'],
        suggestedCommit: 'chore: adopt Megamono project boundaries',
      }),
      expect.objectContaining({
        id: 'health',
        modules: ['health'],
        suggestedCommit: 'chore: add Megamono workspace health checks',
      }),
    ]);
    expect(plan.suggestedCommitBatches[0]?.targets).toContain('megamono.json');
    expect(renderWorkspaceInitPlan(plan)).toContain(
      '## Suggested commit batches',
    );
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

  it('classifies Expo applications as mobile without an adoption override', () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'mobile-app', {
      root: 'apps/mobile-app',
      projectType: 'application',
      targets: {
        build: {
          executor: 'nx:run-commands',
          options: { command: 'expo export -p ios' },
        },
      },
    });
    tree.write(
      'apps/mobile-app/package.json',
      JSON.stringify({
        dependencies: { expo: '57.0.10', 'react-native': '0.86.2' },
      }),
    );
    tree.write('apps/mobile-app/app.json', JSON.stringify({ expo: {} }));

    expect(surveyWorkspaceInit(tree).projects).toContainEqual(
      expect.objectContaining({
        name: 'mobile-app',
        type: 'application',
        platform: 'mobile',
      }),
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
    tree.write('apps/site/content-collections.ts', 'export default {};\n');
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

    const survey = surveyWorkspaceInit(tree);
    expect(survey.recommendations).toEqual([]);
    expect(survey.existing.contentCollections).toEqual(
      expect.arrayContaining([
        '.megamono/content-collections.ts',
        'apps/site/content-collections.ts',
      ]),
    );
    tree.delete('.megamono/content-collections.ts');
    expect(surveyWorkspaceInit(tree).recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: 'docs', action: 'configure' }),
      ]),
    );
  });

  it('recognizes the managed docs loader in an older artifact-only workspace', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('apps/site/content-collections.ts', 'export default {};\n');
    tree.write('megamono.json', JSON.stringify({ docs: { root: 'docs' } }));
    tree.write(
      '.megamono/artifacts.json',
      JSON.stringify({
        schemaVersion: 1,
        artifacts: [
          {
            id: 'docs.loader',
            module: 'docs',
            mode: 'managed',
            target: 'content-collections.ts',
            sourceVersion: '0.0.1',
            templateHash: `sha256:${'a'.repeat(64)}`,
            installedHash: `sha256:${'a'.repeat(64)}`,
            state: 'managed',
            ejectable: true,
          },
        ],
      }),
    );
    tree.write(
      'content-collections.ts',
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
