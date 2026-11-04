import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { appGenerator, AppGeneratorError } from './app';
import {
  addProjectConfiguration,
  readJson,
  readProjectConfiguration,
  updateJson,
} from '@nx/devkit';
import { parse } from 'yaml';
import { runInNewContext } from 'node:vm';
import * as nodePath from 'node:path';

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
  it('uses an existing app-owned SDK without requiring a Root Expo declaration', async () => {
    const tree = workspace();
    updateJson(tree, 'package.json', (manifest) => ({
      ...manifest,
      dependencies: { react: '19.3.1', 'react-dom': '19.3.1' },
    }));
    tree.write(
      'apps/existing/package.json',
      '{"name":"@fixture/existing","dependencies":{"expo":"~54.0.38"}}',
    );
    addProjectConfiguration(tree, 'existing', {
      root: 'apps/existing',
      projectType: 'application',
    });
    await appGenerator(tree, {
      type: 'mobile',
      yes: true,
      interactive: false,
      skipInstall: true,
    });
    expect(readJson(tree, 'package.json').dependencies.expo).toBeUndefined();
    expect(
      readJson(tree, 'apps/mobile/package.json').dependencies,
    ).toMatchObject({
      expo: '~54.0.38',
      react: '19.1.0',
      'react-native': '0.81.5',
    });
    expect(readJson(tree, 'apps/existing/package.json').dependencies.expo).toBe(
      '~54.0.38',
    );
  });

  it('refuses conflicting workspace SDK owners before writes', async () => {
    const tree = workspace();
    for (const version of ['54.0.38', '55.0.32']) {
      const name = `sdk-${version.split('.')[0]}`;
      tree.write(
        `apps/${name}/package.json`,
        JSON.stringify({ name, dependencies: { expo: version } }),
      );
      addProjectConfiguration(tree, name, {
        root: `apps/${name}`,
        projectType: 'application',
      });
    }
    const before = snapshot(tree);
    await expect(
      appGenerator(tree, {
        type: 'mobile',
        yes: true,
        interactive: false,
        skipInstall: true,
      }),
    ).rejects.toMatchObject({ diagnosticCode: 'app-compatibility' });
    expect(snapshot(tree)).toBe(before);
  });
  it('keeps desktop Rust and JavaScript versions compatible after Cargo resolution', async () => {
    const tree = workspace();
    await appGenerator(tree, {
      type: 'desktop',
      yes: true,
      interactive: false,
      skipInstall: true,
    });
    const manifest = readJson(tree, 'apps/desktop/package.json');
    const cargo = tree.read('apps/desktop/src-tauri/Cargo.toml', 'utf8') ?? '';
    const rustCore = cargo.match(
      /^tauri = \{ version = "(~\d+\.\d+\.\d+)"/m,
    )?.[1];

    expect(rustCore).toBeDefined();
    expect(cargo).toContain('rust-version = "1.90"');
    expect(rustCore?.slice(1).split('.').slice(0, 2)).toEqual(
      manifest.dependencies['@tauri-apps/api'].split('.').slice(0, 2),
    );
    expect(cargo).toContain(
      `tauri-plugin-opener = "=${manifest.dependencies['@tauri-apps/plugin-opener']}"`,
    );
  });

  it('uses qualified framework versions instead of older Nx web defaults', async () => {
    const tree = workspace();
    await appGenerator(tree, {
      type: 'site',
      styling: 'css-modules',
      yes: true,
      interactive: false,
      skipInstall: true,
    });
    const root = readJson(tree, 'package.json');
    const app = readJson(tree, 'apps/site/package.json');
    const framework = {
      next: '16.4.3',
      react: '19.3.1',
      'react-dom': '19.3.1',
    };
    expect(root.dependencies).toMatchObject(framework);
    expect(app.dependencies).toMatchObject(framework);
    expect(root.devDependencies['eslint-config-next']).toBe('16.4.3');
  });

  it('retains existing workspace framework declarations when adding a web app', async () => {
    const tree = workspace();
    const framework = {
      next: '^15.5.18',
      react: '^18.3.1',
      'react-dom': '^18.3.1',
    };
    updateJson(tree, 'package.json', (value) => ({
      ...value,
      dependencies: { ...value.dependencies, ...framework },
      devDependencies: {
        ...value.devDependencies,
        'eslint-config-next': '^15.5.18',
      },
    }));
    await appGenerator(tree, {
      type: 'site',
      styling: 'css-modules',
      yes: true,
      interactive: false,
      skipInstall: true,
    });
    expect(readJson(tree, 'package.json').dependencies).toMatchObject(
      framework,
    );
    expect(readJson(tree, 'apps/site/package.json').dependencies).toMatchObject(
      framework,
    );
    expect(
      readJson(tree, 'package.json').devDependencies['eslint-config-next'],
    ).toBe('^15.5.18');
  });

  it('keeps a new mobile app on its Expo React lane without changing web dependencies', async () => {
    const tree = workspace();
    const framework = {
      react: '19.3.1',
      'react-dom': '19.3.1',
      expo: '~54.0.38',
      'react-native': '>=0.81.0 <0.82',
    };
    updateJson(tree, 'package.json', (value) => ({
      ...value,
      dependencies: { ...value.dependencies, ...framework },
    }));
    tree.write(
      'apps/site/package.json',
      JSON.stringify({
        name: '@fixture/site',
        dependencies: {
          next: '16.4.3',
          react: '19.3.1',
          'react-dom': '19.3.1',
        },
      }),
    );
    const web = tree.read('apps/site/package.json', 'utf8');
    await appGenerator(tree, {
      type: 'mobile',
      scope: 'fixture',
      yes: true,
      interactive: false,
      skipInstall: true,
    });
    expect(readJson(tree, 'package.json').dependencies).toMatchObject(
      framework,
    );
    expect(readJson(tree, 'apps/site/package.json')).toEqual(
      JSON.parse(web ?? '{}'),
    );
    expect(
      readJson(tree, 'apps/mobile/package.json').dependencies,
    ).toMatchObject({
      expo: '~54.0.38',
      react: '19.1.0',
      'react-dom': '19.1.0',
      'react-native': '0.81.5',
    });
    expect(readJson(tree, 'apps/mobile/app.json').expo).toMatchObject({
      newArchEnabled: true,
      android: { edgeToEdgeEnabled: true },
    });
    expect(
      readJson(tree, 'apps/mobile/package.json').devDependencies[
        'react-test-renderer'
      ],
    ).toBe('19.1.0');
    for (const name of [
      '@testing-library/react-native',
      'jest-expo',
      'react-test-renderer',
    ]) {
      expect(
        readJson(tree, 'apps/mobile/package.json').dependencies[name],
      ).toBeUndefined();
      expect(
        readJson(tree, 'apps/mobile/package.json').devDependencies[name],
      ).toBeDefined();
      expect(
        readJson(tree, 'package.json').devDependencies[name],
      ).toBeUndefined();
    }
    expect(
      readJson(tree, 'apps/mobile/package.json').dependencies[
        '@expo/vector-icons'
      ],
    ).toBeUndefined();
    expect(
      readJson(tree, 'apps/mobile/package.json').dependencies[
        '@expo/metro-config'
      ],
    ).toBeUndefined();
    expect(
      readJson(tree, 'apps/mobile/package.json').expo.autolinking.exclude,
    ).toEqual(['react', 'react-dom']);
    expect(
      readJson(tree, 'package.json').dependencies['@expo/vector-icons'],
    ).toBeUndefined();
    const calls: unknown[][] = [];
    const defaults = {
      projectRoot: '/fixture/apps/mobile',
      watchFolders: ['/fixture/owned-by-expo'],
      transformer: { assetRegistryPath: 'expo-owned' },
      resolver: {
        nodeModulesPaths: [
          '/fixture/apps/mobile/node_modules',
          '/fixture/node_modules',
        ],
        assetExts: ['png', 'svg'],
        sourceExts: ['ts', 'tsx'],
        resolveRequest: (...args: unknown[]) => {
          calls.push(args);
          return 'expo-resolved';
        },
      },
    };
    const sandbox = {
      __dirname: '/fixture/apps/mobile',
      module: { exports: undefined as unknown },
      require: Object.assign(
        (name: string) => {
          expect(name).toBe('expo/metro-config');
          return { getDefaultConfig: () => defaults };
        },
        {
          resolve: (name: string) =>
            `/fixture/apps/mobile/${name.replace(/^\.\//, '')}`,
        },
      ),
    };
    runInNewContext(
      tree.read('apps/mobile/metro.config.js', 'utf8') ?? '',
      sandbox,
    );
    const metro = sandbox.module.exports as typeof defaults;
    expect(metro.projectRoot).toBe(defaults.projectRoot);
    expect(metro.watchFolders).toEqual(['/fixture/owned-by-expo']);
    expect(metro.resolver.nodeModulesPaths).toEqual(
      defaults.resolver.nodeModulesPaths,
    );
    expect(metro.transformer.assetRegistryPath).toBe('expo-owned');
    const context = {
      originModulePath: '/fixture/node_modules/react-native/index.js',
    };
    expect(
      metro.resolver.resolveRequest(context, 'react/jsx-runtime', 'ios'),
    ).toBe('expo-resolved');
    expect(calls[0]).toEqual([
      { ...context, originModulePath: '/fixture/apps/mobile/index.js' },
      'react/jsx-runtime',
      'ios',
    ]);
    metro.resolver.resolveRequest(context, 'react-native', 'android');
    expect(calls[1]).toEqual([context, 'react-native', 'android']);
    const jestSandbox = {
      module: { exports: undefined as unknown },
      __dirname: '/fixture/apps/mobile',
      require: Object.assign(
        (name: string) => {
          expect(name).toBe('node:path');
          return nodePath;
        },
        {
          resolve: (name: string) =>
            `/fixture/apps/mobile/node_modules/${name}`,
        },
      ),
    };
    runInNewContext(
      tree.read('apps/mobile/jest.config.cts', 'utf8') ?? '',
      jestSandbox,
    );
    const jestConfig = jestSandbox.module.exports as {
      moduleNameMapper: Record<string, string>;
    };
    expect(jestConfig.moduleNameMapper['^react$']).toBe(
      '/fixture/apps/mobile/node_modules/react',
    );
    expect(jestConfig.moduleNameMapper['^react/(.*)$']).toBe(
      '/fixture/apps/mobile/node_modules/react/$1',
    );
    expect(jestConfig.moduleNameMapper['^react-dom/(.*)$']).toBe(
      '/fixture/apps/mobile/node_modules/react-dom/$1',
    );
    expect(jestConfig.moduleNameMapper['^react-test-renderer/(.*)$']).toBe(
      '/fixture/apps/mobile/node_modules/react-test-renderer/$1',
    );
    expect(jestConfig.moduleNameMapper['[.]svg$']).toBe(
      '@nx/expo/plugins/jest/svg-mock',
    );
  });

  it('selects the maintained SDK for a new mobile app and retains every pre-existing root declaration', async () => {
    const tree = workspace();
    const owned = {
      dependencies: {
        react: '19.3.1',
        'react-dom': '19.3.1',
        '@nx/react-native': '23.3.1',
        'babel-preset-expo': '99.0.0',
        'expo-splash-screen': '99.0.0',
      },
      devDependencies: {
        '@types/react': '19.3.0',
        'react-test-renderer': '19.3.1',
        'jest-expo': '~55.0.18',
        '@testing-library/react-native': '~13.1.0',
      },
      peerDependencies: { 'some-public-peer': '>=1 <2' },
      optionalDependencies: { 'some-optional-peer': '^1.0.0' },
    };
    updateJson(tree, 'package.json', (manifest) => ({ ...manifest, ...owned }));
    await appGenerator(tree, {
      type: 'mobile',
      scope: 'fixture',
      yes: true,
      interactive: false,
      skipInstall: true,
    });
    expect(readJson(tree, 'package.json')).toMatchObject(owned);
    expect(
      readJson(tree, 'package.json').dependencies['@types/react'],
    ).toBeUndefined();
    expect(
      readJson(tree, 'package.json').devDependencies['babel-preset-expo'],
    ).toBeUndefined();
    const app = readJson(tree, 'apps/mobile/package.json');
    expect(app.dependencies).toMatchObject({
      expo: '57.0.31',
      react: '19.2.3',
      'react-dom': '19.2.3',
      'react-native': '0.86.3',
    });
    expect(app.devDependencies['react-test-renderer']).toBe('19.2.3');
    expect(app.devDependencies['jest-expo']).toBe('~57.0.6');
    expect(app.devDependencies['babel-preset-expo']).toBe('~57.0.16');
    expect(app.devDependencies['@types/react']).toBe('~19.2.0');
    expect(app.dependencies['expo-splash-screen']).toBe('~57.0.10');
    expect(
      readJson(tree, 'apps/mobile/app.json').expo.android.edgeToEdgeEnabled,
    ).toBeUndefined();
    expect(
      readJson(tree, 'apps/mobile/app.json').expo.newArchEnabled,
    ).toBeUndefined();
    expect(Object.values(app.dependencies)).not.toContain('*');
    expect(app.devDependencies['@testing-library/react-native']).toBe(
      '~13.2.0',
    );
  });

  it('keeps fresh SDK runtime packages local when the existing web app uses React 18', async () => {
    const tree = workspace();
    updateJson(tree, 'package.json', (manifest) => ({
      ...manifest,
      dependencies: { react: '18.3.1', 'react-dom': '18.3.1' },
      devDependencies: { '@types/react': '18.3.23' },
    }));
    await appGenerator(tree, {
      type: 'mobile',
      yes: true,
      interactive: false,
      skipInstall: true,
    });
    const root = readJson(tree, 'package.json');
    expect(root.dependencies).toMatchObject({
      react: '18.3.1',
      'react-dom': '18.3.1',
    });
    expect(root.dependencies.expo).toBeUndefined();
    expect(root.dependencies['react-native']).toBeUndefined();
    expect(root.dependencies['expo-splash-screen']).toBeUndefined();
    expect(root.devDependencies['@expo/cli']).toBeUndefined();
    const app = readJson(tree, 'apps/mobile/package.json');
    expect(app.dependencies).toMatchObject({
      expo: '57.0.31',
      react: '19.2.3',
      'react-native': '0.86.3',
      'expo-splash-screen': '~57.0.10',
    });
    expect(app.devDependencies).toMatchObject({
      'babel-preset-expo': '~57.0.16',
      '@types/react': '~19.2.0',
      '@expo/cli': '^57.0.32',
    });
  });

  it.each(['latest', 'file:../expo', '*', '>=0', '>=54 <57', '^59.0.0'])(
    'refuses an ambiguous or conflicting existing Expo declaration without keeping probe writes: %s',
    async (expo) => {
      const tree = workspace();
      updateJson(tree, 'package.json', (manifest) => ({
        ...manifest,
        dependencies: { expo, react: '19.3.1' },
      }));
      const before = snapshot(tree);
      await expect(
        appGenerator(tree, {
          type: 'mobile',
          yes: true,
          interactive: false,
          skipInstall: true,
        }),
      ).rejects.toMatchObject({ diagnosticCode: 'app-compatibility' });
      expect(snapshot(tree)).toBe(before);
    },
  );

  it('refuses a conflicting native runtime without introducing a second SDK lane', async () => {
    const tree = workspace();
    updateJson(tree, 'package.json', (manifest) => ({
      ...manifest,
      dependencies: { expo: '~54.0.38', 'react-native': '0.85.3' },
    }));
    const before = snapshot(tree);
    await expect(
      appGenerator(tree, {
        type: 'mobile',
        yes: true,
        interactive: false,
        skipInstall: true,
      }),
    ).rejects.toMatchObject({ diagnosticCode: 'app-compatibility' });
    expect(snapshot(tree)).toBe(before);
  });

  it('refuses an unbounded native runtime declaration before writes', async () => {
    const tree = workspace();
    updateJson(tree, 'package.json', (manifest) => ({
      ...manifest,
      dependencies: { expo: '~54.0.38', 'react-native': '*' },
    }));
    const before = snapshot(tree);
    await expect(
      appGenerator(tree, {
        type: 'mobile',
        yes: true,
        interactive: false,
        skipInstall: true,
      }),
    ).rejects.toMatchObject({ diagnosticCode: 'app-compatibility' });
    expect(snapshot(tree)).toBe(before);
  });

  it('registers inference only for the new app without migrating other projects', async () => {
    const tree = workspace();
    const existing = {
      plugin: '@nx/expo/plugin',
      include: ['apps/legacy/**'],
      options: { exportTargetName: 'bundle', buildTargetName: 'cloud-build' },
    };
    updateJson(tree, 'nx.json', (nx) => ({ ...nx, plugins: [existing] }));
    await appGenerator(tree, {
      type: 'mobile',
      scope: 'fixture',
      yes: true,
      interactive: false,
      skipInstall: true,
    });
    expect(readJson(tree, 'nx.json').plugins).toEqual([
      existing,
      {
        plugin: '@nx/expo/plugin',
        options: existing.options,
        include: [
          'apps/mobile/app.json',
          'apps/mobile/app.config.js',
          'apps/mobile/app.config.ts',
        ],
      },
    ]);
    const project = readProjectConfiguration(tree, 'fixture-mobile');
    expect(project.targets?.bundle).toEqual({
      dependsOn: ['^bundle', 'expo-doctor'],
    });
    expect(project.targets?.['cloud-build']).toEqual({
      dependsOn: ['expo-doctor'],
    });
    expect(project.targets?.['sync-deps']).toBeUndefined();
  });

  it('reuses equivalent unscoped Expo policies and refuses conflicting policies before writes', async () => {
    const tree = workspace();
    updateJson(tree, 'nx.json', (nx) => ({
      ...nx,
      plugins: [
        '@nx/expo/plugin',
        {
          plugin: '@nx/expo/plugin',
          include: ['apps/other/**'],
          options: { exportTargetName: 'export' },
        },
      ],
    }));
    await appGenerator(tree, {
      type: 'mobile',
      scope: 'fixture',
      yes: true,
      interactive: false,
      skipInstall: true,
    });
    expect(readJson(tree, 'nx.json').plugins).toHaveLength(2);
    const conflict = workspace();
    updateJson(conflict, 'nx.json', (nx) => ({
      ...nx,
      plugins: [
        '@nx/expo/plugin',
        {
          plugin: '@nx/expo/plugin',
          include: ['apps/other/**'],
          options: { exportTargetName: 'bundle' },
        },
      ],
    }));
    const before = snapshot(conflict);
    await expect(
      appGenerator(conflict, {
        type: 'mobile',
        yes: true,
        interactive: false,
        skipInstall: true,
      }),
    ).rejects.toMatchObject({ diagnosticCode: 'app-compatibility' });
    expect(snapshot(conflict)).toBe(before);
  });

  it.each([
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const)(
    'retains caller-owned Expo declarations in %s while selecting its SDK lane',
    async (section) => {
      const tree = workspace();
      updateJson(tree, 'package.json', (manifest) => ({
        ...manifest,
        dependencies: { react: '19.3.1', 'react-dom': '19.3.1' },
        [section]: { expo: '~54.0.38' },
      }));
      await appGenerator(tree, {
        type: 'mobile',
        yes: true,
        interactive: false,
        skipInstall: true,
      });
      const root = readJson(tree, 'package.json');
      expect(root[section].expo).toBe('~54.0.38');
      expect(root.dependencies.expo).toBeUndefined();
      expect(
        readJson(tree, 'apps/mobile/package.json').dependencies,
      ).toMatchObject({
        expo: '~54.0.38',
        react: '19.1.0',
        'react-dom': '19.1.0',
        'react-native': '0.81.5',
      });
    },
  );

  it('registers desktop packages without changing trailing pnpm policies', async () => {
    const tree = workspace();
    tree.write(
      'pnpm-workspace.yaml',
      "# Reviewed policy\npackages:\n  - 'packages/*'\nallowBuilds:\n  esbuild: true # approved\nminimumReleaseAgeExclude:\n  - '@megamono/plugin@0.0.1'\n",
    );
    await appGenerator(tree, {
      type: 'desktop',
      scope: 'fixture',
      yes: true,
      interactive: false,
      skipInstall: true,
    });
    const source = tree.read('pnpm-workspace.yaml', 'utf8')!;
    expect(parse(source)).toEqual({
      packages: ['packages/*', 'apps/*'],
      allowBuilds: { esbuild: true },
      minimumReleaseAgeExclude: ['@megamono/plugin@0.0.1'],
    });
    expect(source).toContain('# Reviewed policy');
    expect(source).toContain('# approved');
  });
  it.each([undefined, 'Quickzones'])(
    'uses the app basename or explicit extension display name: %s',
    async (displayName) => {
      const tree = workspace();
      await appGenerator(tree, {
        type: 'extension',
        name: 'browser',
        workspaceName: 'quickzones-int-source',
        displayName,
        yes: true,
        interactive: false,
        skipInstall: true,
      });
      expect(tree.read('apps/browser/wxt.config.ts', 'utf8')).toContain(
        `name: '${displayName ?? 'browser'}'`,
      );
      expect(tree.read('apps/browser/wxt.config.ts', 'utf8')).not.toContain(
        'quickzones-int-source',
      );
    },
  );
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
      expect(tree.read('apps/site/eslint.config.mjs', 'utf8')).toContain(
        "ignores: ['**/next-env.d.ts', '**/.next/**']",
      );
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
      if (styling === 'panda') {
        expect(tree.read('apps/site/eslint.config.mjs', 'utf8')).toContain(
          "ignores: ['**/styled-system/**']",
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
    expect(tree.read('apps/web/eslint.config.mjs', 'utf8')).toContain(
      "ignores: ['**/next-env.d.ts', '**/.next/**']",
    );
    expect(tree.read('apps/web-e2e/package.json', 'utf8')).toContain(
      '"name": "fixture-web-e2e"',
    );
    expect(tree.read('apps/web-e2e/playwright.config.mts', 'utf8')).toContain(
      'pnpm exec nx run fixture-web:serve --port=${port}',
    );
    expect(
      readProjectConfiguration(tree, 'fixture-web').targets?.serve,
    ).toMatchObject({
      executor: '@nx/next:server',
      options: { dev: true },
    });

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
    expect(
      readProjectConfiguration(tree, 'fixture-api-e2e').targets?.e2e.options
        .jestConfig,
    ).toBe('apps/api-e2e/jest.config.cjs');
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
        ...(type === 'extension'
          ? {
              manifestVersion: 3 as const,
              contentScriptMatches: ['https://example.com/*'],
            }
          : {}),
        scope: 'fixture',
        workspaceName: 'Fixture',
        interactive: false,
        yes: true,
      } as const;
      await appGenerator(tree, options);
      expect(tree.exists(expectedPath)).toBe(true);
      if (type === 'extension') {
        expect(tree.exists('eslint.config.mjs')).toBe(true);
        expect(tree.exists('apps/extension/eslint.config.mjs')).toBe(true);
        expect(tree.read(expectedPath, 'utf8')).toContain('manifestVersion: 3');
        expect(
          tree.read('apps/extension/entrypoints/content.ts', 'utf8'),
        ).toContain('https://example.com/*');
      }
      if (type === 'mobile') {
        const mobile = readProjectConfiguration(tree, 'fixture-mobile');
        expect(mobile.targets?.['expo-doctor']).toEqual({
          executor: '@megamono/plugin:expo-doctor',
          cache: false,
        });
        expect(mobile.targets?.build?.dependsOn).toContain('expo-doctor');
        expect(mobile.targets?.export?.dependsOn).toContain('expo-doctor');
        expect(tree.read('apps/mobile/package.json', 'utf8')).toContain(
          'platform:mobile',
        );
        expect(tree.read('apps/mobile/package.json', 'utf8')).not.toContain(
          'platform:web',
        );
      }
      if (type === 'desktop') {
        const root = 'apps/desktop/src-tauri';
        const config = JSON.parse(
          tree.read(`${root}/tauri.conf.json`, 'utf8')!,
        );
        for (const icon of config.bundle.icon) {
          expect(tree.read(`${root}/${icon}`)?.length).toBeGreaterThan(100);
        }
        const png = tree.read(`${root}/icons/icon.png`)!;
        expect(png.subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        // Tauri requires an RGBA PNG, rather than an indexed or RGB image.
        expect(png[25]).toBe(6);
      }
      const first = snapshot(tree);
      await appGenerator(tree, options);
      expect(snapshot(tree)).toBe(first);
    },
  );
});
