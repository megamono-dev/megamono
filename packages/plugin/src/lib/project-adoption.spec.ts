import { addProjectConfiguration, getProjects } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { classifyProjectForAdoption } from './project-adoption';

describe('project adoption classification', () => {
  it('classifies a non-executable root project as workspace tooling', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({ dependencies: { next: '15.0.0', '@nestjs/core': '11.0.0' } }),
    );
    const project = {
      root: '.',
      targets: { registry: { executor: 'nx:run-commands' } },
    };

    expect(classifyProjectForAdoption(tree, 'workspace', project)).toEqual({
      kind: 'library',
      type: 'util',
      evidence: [
        'workspace-root tooling project',
        'workspace-root dependencies are not project evidence',
      ],
    });
  });

  it('inherits an E2E platform from its implicit application dependency', () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'site', {
      root: 'apps/site',
      projectType: 'application',
      tags: ['type:app', 'platform:web'],
    });
    addProjectConfiguration(tree, 'site-e2e', {
      root: 'apps/site-e2e',
      projectType: 'application',
      implicitDependencies: ['site'],
      targets: { e2e: { executor: '@nx/playwright:playwright' } },
    });
    const projects = getProjects(tree);

    expect(
      classifyProjectForAdoption(
        tree,
        'site-e2e',
        projects.get('site-e2e')!,
        {},
        undefined,
        projects,
      ),
    ).toMatchObject({
      kind: 'application',
      platform: 'web',
      evidence: expect.arrayContaining([
        'implicit dependency site has platform:web',
      ]),
    });
  });
});
