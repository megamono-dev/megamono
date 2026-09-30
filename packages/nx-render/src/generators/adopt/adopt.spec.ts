import { addProjectConfiguration, readProjectConfiguration } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderAdoptGenerator } from './adopt';

describe('Render adoption proposal generator', () => {
  function prismaFixture(manager = 'pnpm@11.24.0') {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('package.json', JSON.stringify({ packageManager: manager }));
    addProjectConfiguration(tree, 'api', {
      root: 'apps/api',
      projectType: 'application',
      implicitDependencies: ['db'],
      targets: { build: { command: 'webpack', dependsOn: ['^build'] } },
    });
    addProjectConfiguration(tree, 'db', {
      root: 'libs/prisma/primary',
      targets: {
        generate: {
          command: 'prisma generate --schema prisma',
          options: { cwd: 'libs/prisma/primary' },
        },
      },
    });
    tree.write(
      'libs/prisma/primary/prisma/schema.prisma',
      'generator client { provider = "prisma-client" }',
    );
    tree.write('libs/prisma/primary/prisma.config.ts', 'export default {};');
    tree.write(
      'megamono.json',
      JSON.stringify({
        databases: {
          primary: {
            adapter: 'prisma',
            project: 'db',
            schema: 'libs/prisma/primary/prisma',
          },
        },
      }),
    );
    tree.write('Procfile', 'web: pnpm exec nx run api:serve:production\n');
    return tree;
  }

  it.each([
    'npm@11.0.0',
    'pnpm@11.24.0',
    'yarn@1.22.22',
    'yarn@4.0.0',
    'bun@1.3.0',
  ])(
    'generates Prisma build ordering and schema/config-specific reviewed migration commands (%s)',
    async (manager) => {
      const tree = prismaFixture(manager);
      await renderAdoptGenerator(tree, {});
      const service = parse(tree.read('render.proposed.yaml', 'utf8') ?? '')
        .services[0];
      expect(service.rootDir).toBe('.');
      expect(service.buildCommand).toContain("nx run 'api:build'");
      expect(service.preDeployCommand).toContain(
        "prisma migrate deploy --schema 'libs/prisma/primary/prisma' --config 'libs/prisma/primary/prisma.config.ts'",
      );
      expect(service.buildCommand).not.toContain('migrate');
      expect(service.preDeployCommand).not.toContain('generate');
      const expected = ['^build', { projects: ['db'], target: 'generate' }];
      expect(
        readProjectConfiguration(tree, 'api').targets?.build.dependsOn,
      ).toEqual(expected);
      await renderAdoptGenerator(tree, { force: true });
      expect(
        readProjectConfiguration(tree, 'api').targets?.build.dependsOn,
      ).toEqual(expected);
      expect(tree.exists('render.yaml')).toBe(false);
    },
  );

  it('retains an already generated command chain when adopting its inventory again', async () => {
    const tree = prismaFixture();
    await renderAdoptGenerator(tree, {});
    const proposal = tree.read('render.proposed.yaml', 'utf8') ?? '';
    tree.write('render.services.json', JSON.stringify(parse(proposal)));
    await renderAdoptGenerator(tree, { force: true });
    expect(tree.read('render.proposed.yaml', 'utf8')).toBe(proposal);
  });

  it('keeps migration commands bound to each explicitly selected database', async () => {
    const tree = prismaFixture();
    addProjectConfiguration(tree, 'audit-db', {
      root: 'libs/audit db',
      targets: {
        generate: { command: 'prisma generate --schema schema.prisma' },
      },
    });
    tree.write(
      'libs/audit db/schema.prisma',
      'generator client { provider = "prisma-client" }',
    );
    tree.write('libs/audit db/prisma.config.ts', 'export default {};');
    tree.write(
      'megamono.json',
      JSON.stringify({
        databases: {
          primary: {
            adapter: 'prisma',
            project: 'db',
            schema: 'libs/prisma/primary/prisma',
          },
          audit: {
            adapter: 'prisma',
            project: 'audit-db',
            schema: 'libs/audit db/schema.prisma',
          },
        },
      }),
    );
    tree.write(
      'render-map.json',
      JSON.stringify({
        services: { web: { project: 'api', databases: ['primary', 'audit'] } },
      }),
    );
    await renderAdoptGenerator(tree, { serviceProjects: 'render-map.json' });
    const service = parse(tree.read('render.proposed.yaml', 'utf8') ?? '')
      .services[0];
    expect(service.preDeployCommand).toContain(
      "--schema 'libs/audit db/schema.prisma' --config 'libs/audit db/prisma.config.ts'",
    );
    expect(service.preDeployCommand).toContain(
      "--schema 'libs/prisma/primary/prisma'",
    );
    expect(service.preDeployCommand.split(' && ')).toHaveLength(2);
    expect(readProjectConfiguration(tree, 'api').implicitDependencies).toEqual([
      'db',
      'audit-db',
    ]);
  });

  it.each([
    { rootDir: 'apps/api' },
    { preDeployCommand: 'npm run custom-migration' },
    { runtime: 'docker' },
    { plan: 'free' },
    { buildCommand: 'webpack' },
  ])(
    'fails before writing when Prisma deployment requires review: %j',
    async (overrides) => {
      const tree = prismaFixture();
      tree.write(
        'render.services.json',
        JSON.stringify({
          services: [
            {
              type: 'web',
              name: 'web',
              runtime: 'node',
              startCommand: 'pnpm exec nx run api:serve',
              ...overrides,
            },
          ],
        }),
      );
      const before = tree.listChanges();
      await expect(renderAdoptGenerator(tree, {})).rejects.toThrow();
      expect(tree.listChanges()).toEqual(before);
    },
  );

  it('uses explicit database mappings and rejects unknown databases without writes', async () => {
    const tree = prismaFixture();
    tree.write(
      'render-map.json',
      JSON.stringify({
        services: { web: { project: 'api', databases: ['missing'] } },
      }),
    );
    const before = tree.listChanges();
    await expect(
      renderAdoptGenerator(tree, { serviceProjects: 'render-map.json' }),
    ).rejects.toThrow();
    expect(tree.listChanges()).toEqual(before);
  });

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
