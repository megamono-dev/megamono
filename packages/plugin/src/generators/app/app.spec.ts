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
  return tree
    .listChanges()
    .map(
      (change) =>
        `${change.type}:${change.path}:${change.content?.toString('utf8') ?? ''}`,
    )
    .sort()
    .join('\n');
}

describe('app generator', () => {
  it('preserves pnpm policy comments and skips deferred installation on request', async () => {
    const tree = workspace();
    tree.write(
      'pnpm-workspace.yaml',
      "# Reviewed workspace\npackages:\n  - 'apps/*' # app roots\nallowBuilds:\n  prisma: true # reviewed engine\n",
    );
    tree.write('.npmrc', 'store-dir=/existing/store\n');
    const callback = await appGenerator(tree, {
      type: 'site',
      scope: 'fixture',
      styling: 'css-modules',
      yes: true,
      interactive: false,
      skipInstall: true,
    });
    expect(callback()).toBeUndefined();
    expect(tree.read('.npmrc', 'utf8')).toBe('store-dir=/existing/store\n');
    expect(tree.read('pnpm-workspace.yaml', 'utf8')).toContain(
      '# Reviewed workspace',
    );
    expect(tree.read('pnpm-workspace.yaml', 'utf8')).toContain(
      '# reviewed engine',
    );
    expect(tree.exists('apps/site/src/pages/index.tsx')).toBe(true);
  });

  it.each([
    'chakra',
    'emotion',
    'css-modules',
    'inline',
    'tailwind',
    'panda',
    'stylex',
  ] as const)(
    'generates App Router %s behind a client boundary and preserves reruns',
    async (styling) => {
      const tree = workspace();
      const options = {
        type: 'site' as const,
        router: 'app' as const,
        styling,
        scope: 'fixture',
        interactive: false,
        yes: true,
      };
      await appGenerator(tree, options);
      if (styling === 'chakra') {
        expect(
          JSON.parse(tree.read('packages/theme/package.json', 'utf8') ?? '{}')
            .exports,
        ).toEqual({
          '.': { types: './src/index.ts', default: './src/index.ts' },
        });
      }
      expect(tree.exists('apps/site/src/pages')).toBe(false);
      const layout = tree.read('apps/site/src/app/layout.tsx', 'utf8') ?? '';
      expect(layout).toContain('export const metadata');
      expect(layout).not.toContain('megamonoSystem');
      expect(layout).not.toContain('use client');
      expect(tree.read('apps/site/src/app/providers.tsx', 'utf8')).toContain(
        'use client',
      );
      expect(
        tree.read('apps/site/src/app/billboard.tsx', 'utf8'),
      ).not.toContain('next/head');
      expect(tree.read('apps/site/src/app/page.tsx', 'utf8')).toContain(
        "from './billboard'",
      );
      if (styling === 'chakra') {
        expect(tree.read('apps/site/src/app/providers.tsx', 'utf8')).toContain(
          'value={megamonoSystem}',
        );
        tree.write(
          'packages/theme/src/lib/system.ts',
          '// application-owned customization\n',
        );
      }
      const before = snapshot(tree);
      await appGenerator(tree, options);
      expect(snapshot(tree)).toBe(before);
      await expect(
        appGenerator(tree, { ...options, router: 'pages' }),
      ).rejects.toThrow('different router');
    },
  );

  it('rejects router options on non-web applications before writing', async () => {
    const tree = workspace();
    const before = snapshot(tree);
    await expect(
      appGenerator(tree, {
        type: 'api',
        router: 'app',
        interactive: false,
        yes: true,
      }),
    ).rejects.toThrow('only to web/site');
    expect(snapshot(tree)).toBe(before);
  });

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
    expect(tree.read('apps/web/src/pages/index.module.css', 'utf8')).toContain(
      '.main',
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

  it.each([
    [
      'chakra',
      '@chakra-ui/react',
      '@chakra-ui/react',
      'packages/theme/src/lib/system.ts',
    ],
    ['emotion', '@emotion/react', '@jsxImportSource @emotion/react', undefined],
    [
      'tailwind',
      'tailwindcss',
      'tracking-[-.055em]',
      'apps/web/postcss.config.cjs',
    ],
    [
      'panda',
      '@pandacss/dev',
      "from '../../styled-system/css'",
      'apps/web/panda.config.ts',
    ],
    ['stylex', '@stylexjs/stylex', 'stylex.create', 'apps/web/babel.config.js'],
    [
      'css-modules',
      undefined,
      "from './index.module.css'",
      'apps/web/src/pages/index.module.css',
    ],
    ['inline', undefined, 'satisfies Record<string, CSSProperties>', undefined],
  ] as const)(
    'renders the billboard with %s without enforcing it as a convention',
    async (styling, dependency, sourceMarker, configPath) => {
      const tree = workspace();
      await appGenerator(tree, {
        type: 'web',
        scope: 'fixture',
        styling,
        interactive: false,
        yes: true,
      });
      const manifest = tree.read('apps/web/package.json', 'utf8') ?? '';
      const source = tree.read('apps/web/src/pages/index.tsx', 'utf8') ?? '';
      if (dependency) expect(manifest).toContain(`"${dependency}"`);
      expect(source).toContain(sourceMarker);
      if (configPath) expect(tree.exists(configPath)).toBe(true);
      expect(
        JSON.parse(tree.read('megamono.json', 'utf8') ?? '{}').scaffolding.web
          .styling,
      ).toBe(styling);
    },
  );

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
    expect(
      JSON.parse(tree.read('megamono.json', 'utf8') ?? '{}').ports,
    ).toEqual({
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
    ['extension', 'apps/extension/wxt.config.ts'],
  ] as const)(
    'creates and reruns the %s adapter',
    async (type, expectedPath) => {
      const tree = workspace();
      const options = {
        type,
        ...(type === 'extension' ? { manifestVersion: 3 as const } : {}),
        scope: 'fixture',
        workspaceName: 'Fixture',
        interactive: false,
        yes: true,
      } as const;
      await appGenerator(tree, options);
      expect(tree.exists(expectedPath)).toBe(true);
      if (type === 'extension')
        expect(tree.read(expectedPath, 'utf8')).toContain('manifestVersion: 3');
      if (type === 'mobile') {
        expect(tree.read('apps/mobile/package.json', 'utf8')).toContain(
          'platform:mobile',
        );
        expect(tree.read('apps/mobile/package.json', 'utf8')).not.toContain(
          'platform:web',
        );
      }
      const first = snapshot(tree);
      await appGenerator(tree, options);
      expect(snapshot(tree)).toBe(first);
    },
  );
});
