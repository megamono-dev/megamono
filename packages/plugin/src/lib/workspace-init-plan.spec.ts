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
    tree.write('docs/legacy.md', '# Legacy');
    tree.write(
      'architecture/decisions/decision.md',
      '---\nid: decision-platform-20260825-runtime\ntype: decision\n---\n',
    );
    tree.write('rfcs/cache.md', '# Cache RFC');
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
      'content-collections.ts is occupied by a repository-owned configuration.',
      '.github/workflows/megamono-ci.yml is occupied without Megamono ownership metadata.',
    ]);
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
    expect(summary).toContain('`npm exec nx run megamono:check`');
    expect(summary).toContain('`npm exec nx run megamono:health`');
    expect(summary).not.toContain('megamono-docs:validate');
  });
});
