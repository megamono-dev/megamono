import { addProjectConfiguration } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderAdoptGenerator } from './adopt';

describe('Render adoption proposal generator', () => {
  it('converts Procfile commands into a review-only Nx-aware Blueprint', async () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'api', {
      root: 'apps/api',
      projectType: 'application',
    });
    addProjectConfiguration(tree, 'firehose', {
      root: 'apps/firehose',
      projectType: 'application',
    });
    tree.write(
      'Procfile',
      'web: npm exec nx run api:serve:production\nworker: npm exec nx run firehose:serve:production\n',
    );

    await renderAdoptGenerator(tree, {});

    const source = tree.read('render.proposed.yaml', 'utf8') ?? '';
    expect(source).toContain('Review this proposal');
    expect(parse(source)).toEqual({
      services: [
        expect.objectContaining({
          name: 'web',
          type: 'web',
          rootDir: 'apps/api',
        }),
        expect.objectContaining({
          name: 'worker',
          type: 'worker',
          rootDir: 'apps/firehose',
        }),
      ],
    });
    expect(tree.exists('render.yaml')).toBe(false);
  });

  it('uses a committed dashboard inventory with reviewed service mappings', async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'render.services.json',
      JSON.stringify({
        version: 1,
        services: [{ name: 'site', type: 'web', runtime: 'node' }],
      }),
    );
    tree.write(
      'render-adoption.json',
      JSON.stringify({ services: { site: { root: 'apps/site' } } }),
    );

    await renderAdoptGenerator(tree, {
      serviceProjects: 'render-adoption.json',
    });

    expect(tree.read('render.proposed.yaml', 'utf8')).toContain(
      'rootDir: apps/site',
    );
  });

  it('never writes directly to the authoritative Blueprint', async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('Procfile', 'web: npm start\n');

    await expect(
      renderAdoptGenerator(tree, { output: 'render.yaml' }),
    ).rejects.toThrow('review proposal');
  });
});
