import { addProjectConfiguration } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { parseWranglerConfig } from '../../lib/wrangler-config';
import { bindingGenerator } from './binding';

function jsoncTree() {
  const tree = createTreeWithEmptyWorkspace();
  addProjectConfiguration(tree, 'api', {
    root: 'apps/api',
    projectType: 'application',
  });
  tree.write(
    'apps/api/wrangler.jsonc',
    `{
  // Keep this repository note.
  "name": "api",
  "main": "src/index.ts"
}
`,
  );
  return tree;
}

describe('bindingGenerator', () => {
  it('preserves JSONC comments, validates the result, and is idempotent', async () => {
    const tree = jsoncTree();
    expect(
      await bindingGenerator(tree, {
        project: 'api',
        type: 'd1',
        binding: 'DB',
        resource: 'acme',
        remote: true,
      }),
    ).toBeTypeOf('function');
    const source = tree.read('apps/api/wrangler.jsonc', 'utf8') ?? '';
    expect(source).toContain('// Keep this repository note.');
    expect(
      parseWranglerConfig(source, 'apps/api/wrangler.jsonc').config,
    ).toMatchObject({
      d1_databases: [{ binding: 'DB', database_name: 'acme', remote: true }],
    });
    expect(
      await bindingGenerator(tree, {
        project: 'api',
        type: 'd1',
        binding: 'DB',
        resource: 'acme',
        remote: true,
      }),
    ).toBeUndefined();
  });

  it('supports TOML and dry-run without writing', async () => {
    const tree = createTreeWithEmptyWorkspace();
    addProjectConfiguration(tree, 'jobs', {
      root: 'apps/jobs',
      projectType: 'application',
    });
    tree.write(
      'apps/jobs/wrangler.toml',
      'name = "jobs"\nmain = "src/index.ts"\n',
    );
    await bindingGenerator(tree, {
      project: 'jobs',
      type: 'service',
      binding: 'API',
      resource: 'api',
      dryRun: true,
    });
    expect(tree.read('apps/jobs/wrangler.toml', 'utf8')).not.toContain(
      'services',
    );
    await bindingGenerator(tree, {
      project: 'jobs',
      type: 'service',
      binding: 'API',
      resource: 'api',
    });
    expect(
      parseWranglerConfig(
        tree.read('apps/jobs/wrangler.toml', 'utf8') ?? '',
        'apps/jobs/wrangler.toml',
      ).config,
    ).toMatchObject({
      services: [{ binding: 'API', service: 'api' }],
    });
  });

  it('refuses to replace a binding with the same identity', async () => {
    const tree = jsoncTree();
    await bindingGenerator(tree, {
      project: 'api',
      type: 'service',
      binding: 'AUTH',
      resource: 'auth',
    });
    await expect(
      bindingGenerator(tree, {
        project: 'api',
        type: 'service',
        binding: 'AUTH',
        resource: 'other-auth',
      }),
    ).rejects.toMatchObject({ kind: 'conflict', exitCode: 3 });
  });
});
