import { addProjectConfiguration } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { parseWranglerConfig } from '../../lib/wrangler-config';
import { durableObjectGenerator } from './durable-object';

function workerTree() {
  const tree = createTreeWithEmptyWorkspace();
  addProjectConfiguration(tree, 'api', {
    root: 'apps/api',
    projectType: 'application',
  });
  tree.write(
    'apps/api/wrangler.jsonc',
    JSON.stringify({ name: 'api', main: 'src/index.ts' }, null, 2),
  );
  tree.write(
    'apps/api/src/index.ts',
    'export default { fetch: () => new Response("ok") };\n',
  );
  return tree;
}

describe('durableObjectGenerator', () => {
  it('plans the class, export, binding, and migration as one idempotent mutation', async () => {
    const tree = workerTree();
    expect(
      await durableObjectGenerator(tree, {
        project: 'api',
        className: 'SessionStore',
      }),
    ).toBeTypeOf('function');
    expect(
      tree.read('apps/api/src/durable-objects/session-store.ts', 'utf8'),
    ).toContain('export class SessionStore');
    expect(tree.read('apps/api/src/index.ts', 'utf8')).toContain(
      "export { SessionStore } from './durable-objects/session-store';",
    );
    const config = parseWranglerConfig(
      tree.read('apps/api/wrangler.jsonc', 'utf8') ?? '',
      'apps/api/wrangler.jsonc',
    ).config;
    expect(config).toMatchObject({
      durable_objects: {
        bindings: [{ name: 'SESSION_STORE', class_name: 'SessionStore' }],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['SessionStore'] }],
    });
    expect(
      await durableObjectGenerator(tree, {
        project: 'api',
        className: 'SessionStore',
      }),
    ).toBeUndefined();
  });

  it('keeps dry-run mutation-free and refuses migration tag reuse', async () => {
    const tree = workerTree();
    await durableObjectGenerator(tree, {
      project: 'api',
      className: 'SessionStore',
      dryRun: true,
    });
    expect(tree.exists('apps/api/src/durable-objects/session-store.ts')).toBe(
      false,
    );
    tree.write(
      'apps/api/wrangler.jsonc',
      JSON.stringify(
        {
          name: 'api',
          main: 'src/index.ts',
          migrations: [{ tag: 'v1', new_sqlite_classes: ['Other'] }],
        },
        null,
        2,
      ),
    );
    await expect(
      durableObjectGenerator(tree, {
        project: 'api',
        className: 'SessionStore',
      }),
    ).rejects.toMatchObject({ kind: 'conflict', exitCode: 3 });
    expect(tree.exists('apps/api/src/durable-objects/session-store.ts')).toBe(
      false,
    );
  });
});
