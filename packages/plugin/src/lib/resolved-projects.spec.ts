import {
  addProjectConfiguration,
  getProjects,
  type ProjectGraph,
} from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { resolvedProjects } from './resolved-projects';
import { planIntegrationVerification } from './integration-verification';

describe('resolved qualification projects', () => {
  it('includes graph-only projects with repository files', async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('libs/email/jest.config.js', 'module.exports = {}');
    expect(
      (await resolvedProjects(tree, async () => graph())).get('email')?.targets
        ?.test,
    ).toBeDefined();
  });
  const graph = (): ProjectGraph => ({
    nodes: {
      email: {
        name: 'email',
        type: 'lib',
        data: {
          root: 'libs/email',
          targets: {
            test: { executor: '@nx/jest:jest', cache: true },
            preview: { command: 'preview', cache: false },
          },
        },
      },
    },
    dependencies: {},
  });
  it('accepts inferred targets while retaining explicit overrides without writing inferred configuration', async () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'email', {
      root: 'libs/email',
      targets: { test: { cache: false } },
    });
    const before = tree.listChanges();
    const projects = await resolvedProjects(tree, async () => graph());
    expect(projects.get('email')?.targets?.test).toEqual({
      executor: '@nx/jest:jest',
      cache: false,
    });
    expect(projects.get('email')?.targets?.preview).toBeDefined();
    expect(
      planIntegrationVerification(tree, projects, ['mail:send'], {
        verificationProject: 'email',
        verification: JSON.stringify({ 'mail:send': 'email:test' }),
      })?.configuration.cache,
    ).toBe(false);
    expect(() =>
      planIntegrationVerification(tree, projects, ['mail:send'], {
        verificationProject: 'email',
        verification: JSON.stringify({ 'mail:send': 'email:missing' }),
      }),
    ).toThrow('missing Nx target');
    expect(getProjects(tree).get('email')?.targets?.preview).toBeUndefined();
    expect(tree.listChanges()).toEqual(before);
  });
  it('fails closed on graph errors and does not merge a stale project root', async () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'email', { root: 'libs/moved' });
    await expect(
      resolvedProjects(tree, async () => {
        throw new Error('broken Jest config');
      }),
    ).rejects.toThrow('complete Nx project graph');
    expect(
      (await resolvedProjects(tree, async () => graph())).get('email')?.targets,
    ).toEqual({});
  });
});
