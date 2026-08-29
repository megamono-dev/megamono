import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { appGenerator, AppGeneratorError } from './app';

function workspace() {
  const tree = createTreeWithEmptyWorkspace();
  tree.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  tree.write(
    'megamono.json',
    `${JSON.stringify({
      version: 1,
      conventions: {
        nestFeatureLibraries: true,
        docsLocation: 'centralized',
        packageManager: 'pnpm',
        rules: {},
      },
    })}\n`,
  );
  return tree;
}

function snapshot(tree: ReturnType<typeof workspace>): string {
  return tree.listChanges().map((change) => `${change.type}:${change.path}:${change.content?.toString('utf8') ?? ''}`).sort().join('\n');
}

describe('app generator', () => {
  it('composes the maintained web preset and is idempotent', async () => {
    const tree = workspace();
    await appGenerator(tree, {
      type: 'web',
      scope: 'fixture',
      workspaceName: 'Fixture',
      interactive: false,
      yes: true,
    });

    expect(tree.exists('apps/web/src/pages/index.tsx')).toBe(true);
    expect(tree.read('apps/web/src/pages/index.tsx', 'utf8')).toContain(
      'Fixture is ready to build.',
    );
    expect(tree.read('packages/theme/src/lib/system.ts', 'utf8')).toContain(
      'createSystem',
    );
    expect(tree.read('apps/web/package.json', 'utf8')).toContain(
      '"@fixture/theme": "workspace:*"',
    );
    expect(tree.children('apps')).toEqual(['web', 'web-e2e']);
    expect(tree.read('apps/web-e2e/package.json', 'utf8')).toContain(
      '"name": "fixture-web-e2e"',
    );
    expect(tree.read('apps/web-e2e/playwright.config.mts', 'utf8')).toContain(
      'pnpm exec nx run fixture-web:dev --port=${port}',
    );

    const first = snapshot(tree);
    await appGenerator(tree, {
      type: 'web',
      scope: 'fixture',
      workspaceName: 'Fixture',
      interactive: false,
      yes: true,
    });
    expect(snapshot(tree)).toBe(first);
  });

  it('creates a Nest feature library and keeps the API a composition root', async () => {
    const tree = workspace();
    await appGenerator(tree, {
      type: 'api',
      scope: 'fixture',
      interactive: false,
      yes: true,
    });

    expect(tree.read('apps/api/src/app/app.module.ts', 'utf8')).toContain(
      "from '@fixture/nest-home'",
    );
    expect(tree.exists('apps/api/src/app/app.controller.ts')).toBe(false);
    expect(tree.read('packages/nest-home/package.json', 'utf8')).toContain(
      '"type:feature"',
    );
    expect(tree.read('apps/api-e2e/package.json', 'utf8')).toContain(
      'apps/api-e2e/jest.config.cjs',
    );
    expect(tree.read('apps/api-e2e/jest.config.cjs', 'utf8')).toContain(
      "displayName: 'fixture-api-e2e'",
    );
    expect(tree.read('apps/api/src/main.ts', 'utf8')).toContain(
      'process.env.PORT || 45449',
    );
  });

  it('keeps dry-run mutation-free and rejects occupied roots', async () => {
    const tree = workspace();
    const before = snapshot(tree);
    await appGenerator(tree, {
      type: 'web',
      interactive: false,
      yes: true,
      dryRun: true,
    });
    expect(snapshot(tree)).toBe(before);

    tree.write('apps/web/README.md', 'owned\n');
    await expect(
      appGenerator(tree, {
        type: 'web',
        interactive: false,
        yes: true,
      }),
    ).rejects.toMatchObject({
      exitCode: 3,
      diagnosticCode: 'app-conflict',
    } satisfies Partial<AppGeneratorError>);
  });

  it('records scope-stable ports and allocates named instances without renumbering', async () => {
    const tree = workspace();
    await appGenerator(tree, {
      type: 'web',
      scope: 'fixture',
      interactive: false,
      yes: true,
    });
    await appGenerator(tree, {
      type: 'web',
      name: 'admin',
      scope: 'fixture',
      interactive: false,
      yes: true,
    });
    expect(JSON.parse(tree.read('megamono.json', 'utf8') ?? '{}').ports).toEqual({
      web: 45451,
      admin: 45461,
    });
    await expect(
      appGenerator(tree, {
        type: 'api',
        name: 'internal',
        scope: 'fixture',
        port: 45461,
        interactive: false,
        yes: true,
      }),
    ).rejects.toMatchObject({ diagnosticCode: 'app-port-conflict' });
  });

  it('requires initialization and explicit non-interactive choices', async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('package-lock.json', '{"lockfileVersion":3}\n');
    await expect(
      appGenerator(tree, { type: 'api', interactive: false, yes: true }),
    ).rejects.toMatchObject({ diagnosticCode: 'app-not-initialized' });
    await expect(
      appGenerator(workspace(), { interactive: false, yes: true }),
    ).rejects.toMatchObject({ diagnosticCode: 'app-decision-required' });
  });

  it.each([
    ['worker', 'apps/worker/wrangler.jsonc'],
    ['apple', 'apps/apple/project.json'],
    ['mobile', 'apps/mobile/package.json'],
    ['desktop', 'apps/desktop/src-tauri/Cargo.toml'],
  ] as const)('creates and reruns the %s adapter', async (type, expectedPath) => {
    const tree = workspace();
    const options = {
      type,
      scope: 'fixture',
      workspaceName: 'Fixture',
      interactive: false,
      yes: true,
    } as const;
    await appGenerator(tree, options);
    expect(tree.exists(expectedPath)).toBe(true);
    const first = snapshot(tree);
    await appGenerator(tree, options);
    expect(snapshot(tree)).toBe(first);
  });
});
