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
    expect(JSON.parse(tree.read('nx.json', 'utf8') ?? '{}').plugins).toContain(
      '@megamono/nx-cloudflare',
    );
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
});
