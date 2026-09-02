import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { workerGenerator } from './worker';
import { CloudflareGeneratorError } from '../shared';

describe('workerGenerator', () => {
  it('plans without mutation and then creates only repository conventions', async () => {
    const tree = createTreeWithEmptyWorkspace();
    await workerGenerator(tree, { name: 'events', dryRun: true });
    expect(tree.exists('apps/events/wrangler.jsonc')).toBe(false);

    const callback = await workerGenerator(tree, {
      name: 'events',
      scope: 'platform',
    });
    expect(callback).toBeTypeOf('function');
    expect(
      JSON.parse(tree.read('apps/events/project.json', 'utf8') ?? '{}'),
    ).toMatchObject({
      name: 'events',
      tags: [
        'platform:worker',
        'scope:platform',
        'type:app',
        'visibility:internal',
      ],
    });
    expect(
      JSON.parse(tree.read('apps/events/wrangler.jsonc', 'utf8') ?? '{}'),
    ).toMatchObject({
      $schema: '../../node_modules/wrangler/config-schema.json',
      name: 'events',
      main: 'src/index.ts',
      compatibility_date: '2026-08-23',
    });
    expect(
      JSON.parse(tree.read('nx.json', 'utf8') ?? '{}').plugins,
    ).toContainEqual({
      plugin: '@megamono/nx-cloudflare',
      options: { scope: 'platform' },
    });
    expect(
      JSON.parse(tree.read('package.json', 'utf8') ?? '{}').devDependencies,
    ).toMatchObject({
      '@megamono/nx-cloudflare': '0.0.1',
      wrangler: '4.125.0',
    });
  });

  it('is idempotent and refuses conflicting owned files or Pages', async () => {
    const tree = createTreeWithEmptyWorkspace();
    await workerGenerator(tree, { name: 'events' });
    const before = tree
      .listChanges()
      .map(({ path, content }) => [path, content?.toString()]);
    expect(await workerGenerator(tree, { name: 'events' })).toBeUndefined();
    expect(
      tree
        .listChanges()
        .map(({ path, content }) => [path, content?.toString()]),
    ).toEqual(before);

    tree.write('apps/conflict/project.json', '{}\n');
    await expect(
      workerGenerator(tree, { name: 'conflict' }),
    ).rejects.toMatchObject({
      kind: 'conflict',
      exitCode: 3,
      diagnosticCode: 'cloudflare-generator-conflict',
    });
    await expect(
      workerGenerator(tree, { name: 'site', pages: true }),
    ).rejects.toBeInstanceOf(CloudflareGeneratorError);
  });

  it('retains an exact plugin copied from the yalc store', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const packageJson = JSON.parse(tree.read('package.json', 'utf8') ?? '{}');
    packageJson.devDependencies = {
      '@megamono/nx-cloudflare': 'file:.yalc/@megamono/nx-cloudflare',
      wrangler: '4.125.0',
    };
    tree.write('package.json', JSON.stringify(packageJson));
    tree.write(
      '.yalc/@megamono/nx-cloudflare/package.json',
      JSON.stringify({
        name: '@megamono/nx-cloudflare',
        version: '0.0.1',
      }),
    );

    await workerGenerator(tree, { name: 'events' });

    expect(
      JSON.parse(tree.read('package.json', 'utf8') ?? '{}').devDependencies,
    ).toMatchObject({
      '@megamono/nx-cloudflare': 'file:.yalc/@megamono/nx-cloudflare',
      wrangler: '4.125.0',
    });
  });

  it('preserves a compatible Wrangler range during existing-workspace adoption', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const packageJson = JSON.parse(tree.read('package.json', 'utf8') ?? '{}');
    packageJson.devDependencies = {
      wrangler: '^4.105.0',
    };
    tree.write('package.json', JSON.stringify(packageJson));

    await workerGenerator(tree, { name: 'events' });

    expect(
      JSON.parse(tree.read('package.json', 'utf8') ?? '{}').devDependencies,
    ).toMatchObject({
      '@megamono/nx-cloudflare': '0.0.1',
      wrangler: '^4.105.0',
    });
  });

  it('rejects a Wrangler range below the tested adoption floor', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const packageJson = JSON.parse(tree.read('package.json', 'utf8') ?? '{}');
    packageJson.devDependencies = {
      wrangler: '^4.104.0',
    };
    tree.write('package.json', JSON.stringify(packageJson));

    await expect(
      workerGenerator(tree, { name: 'events' }),
    ).rejects.toMatchObject({
      kind: 'conflict',
      exitCode: 3,
      diagnosticCode: 'cloudflare-generator-conflict',
    });
  });

  it('upgrades a shorthand plugin registration with the selected scope', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const nxJson = JSON.parse(tree.read('nx.json', 'utf8') ?? '{}');
    nxJson.plugins = [...(nxJson.plugins ?? []), '@megamono/nx-cloudflare'];
    tree.write('nx.json', JSON.stringify(nxJson));

    await workerGenerator(tree, { name: 'events', scope: 'product' });

    expect(
      JSON.parse(tree.read('nx.json', 'utf8') ?? '{}').plugins,
    ).toContainEqual({
      plugin: '@megamono/nx-cloudflare',
      options: { scope: 'product' },
    });
  });
});
