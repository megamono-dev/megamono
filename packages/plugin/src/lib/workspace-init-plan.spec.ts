import { addProjectConfiguration } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  WorkspaceInitError,
  createWorkspaceInitPlan,
  parseWorkspaceInitModules,
  renderWorkspaceInitPlan,
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
    });
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
});
