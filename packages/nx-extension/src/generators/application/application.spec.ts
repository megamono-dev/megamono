import { readJson, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { extensionApplicationGenerator } from './application';

describe('extension application generator', () => {
  it('defaults to background-only without permissions and preserves existing content on rerun', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const options = { name: 'browser', skipFormat: true };
    await extensionApplicationGenerator(tree, options);
    expect(tree.exists('apps/browser/entrypoints/background.ts')).toBe(true);
    expect(tree.exists('apps/browser/entrypoints/content.ts')).toBe(false);
    expect(tree.read('apps/browser/wxt.config.ts', 'utf8')).not.toMatch(
      /permissions|all_urls/,
    );
    tree.write('apps/browser/entrypoints/content.ts', '// application-owned');
    await extensionApplicationGenerator(tree, options);
    expect(tree.read('apps/browser/entrypoints/content.ts', 'utf8')).toBe(
      '// application-owned',
    );
  });

  it('creates page access only for explicit match patterns and rejects empty opt-ins before writes', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const before = tree.listChanges();
    await expect(
      extensionApplicationGenerator(tree, {
        name: 'browser',
        contentScriptMatches: [],
        skipFormat: true,
      }),
    ).rejects.toThrow('match patterns');
    expect(tree.listChanges()).toEqual(before);
    await extensionApplicationGenerator(tree, {
      name: 'browser',
      contentScriptMatches: ['https://example.com/*'],
      skipFormat: true,
    });
    expect(tree.read('apps/browser/entrypoints/content.ts', 'utf8')).toContain(
      'https://example.com/*',
    );
    expect(
      tree.read('apps/browser/entrypoints/content.ts', 'utf8'),
    ).not.toContain('<all_urls>');
  });
  it.each([2, 3] as const)(
    'generates and preserves explicit MV%s with matching commands and outputs',
    async (manifestVersion) => {
      const tree = createTreeWithEmptyWorkspace();
      const options = {
        name: 'browser',
        scope: 'fixture',
        manifestVersion,
        skipFormat: true,
      };
      await extensionApplicationGenerator(tree, options);
      const project = readJson(tree, 'apps/browser/project.json');
      expect(project.targets['build-firefox'].outputs).toEqual([
        `{projectRoot}/.output/firefox-mv${manifestVersion}`,
      ]);
      expect(project.targets['build-firefox'].options).toEqual({
        command: `wxt build --browser firefox --mv${manifestVersion}`,
        cwd: '{projectRoot}',
      });
      expect(tree.read('apps/browser/wxt.config.ts', 'utf8')).toContain(
        `manifestVersion: ${manifestVersion}`,
      );
      expect(
        readJson(tree, 'apps/browser/package.json').megamono.extension
          .manifestVersions.firefox,
      ).toBe(manifestVersion);
      const before = tree.listChanges();
      await extensionApplicationGenerator(tree, options);
      expect(tree.listChanges()).toEqual(before);
      await expect(
        extensionApplicationGenerator(tree, {
          ...options,
          manifestVersion: manifestVersion === 2 ? 3 : 2,
        }),
      ).rejects.toThrow('application-owned');
    },
  );

  it('creates a WXT project with Chrome and Firefox targets', async () => {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'package.json', {
      name: '@fixture/workspace',
      private: true,
      workspaces: ['packages/*'],
    });
    tree.write('package-lock.json', '{"lockfileVersion":3}\n');

    await extensionApplicationGenerator(tree, {
      name: 'browser-extension',
      directory: 'apps/browser-extension',
      scope: 'fixture',
      displayName: 'Fixture Extension',
      skipFormat: true,
    });

    expect(tree.read('apps/browser-extension/wxt.config.ts', 'utf8')).toContain(
      "import { defineConfig } from 'wxt'",
    );
    expect(
      readJson(tree, 'apps/browser-extension/package.json').devDependencies.wxt,
    ).toBe('0.21.4');
    expect(
      readJson(tree, 'apps/browser-extension/project.json').targets.build
        .dependsOn,
    ).toEqual(['build-chrome', 'build-firefox']);
    expect(
      readJson(tree, 'apps/browser-extension/project.json').targets.lint
        .options,
    ).toEqual({
      command:
        "eslint . --ignore-pattern '.wxt/**' --ignore-pattern '.output/**'",
      cwd: '{projectRoot}',
    });
    expect(readJson(tree, 'package.json').workspaces).toEqual([
      'apps/browser-extension',
      'packages/*',
    ]);
    expect(tree.read('apps/browser-extension/README.md', 'utf8')).toContain(
      'Safari requires a separate Apple wrapper project',
    );
  });

  it('preserves an explicitly delegated Nx project identity', async () => {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'package.json', {
      name: '@fixture/workspace',
      private: true,
      workspaces: ['apps/*'],
    });

    await extensionApplicationGenerator(tree, {
      name: 'extension',
      projectName: 'fixture-extension',
      directory: 'apps/extension',
      scope: 'fixture',
      skipFormat: true,
    });

    expect(readJson(tree, 'apps/extension/project.json').name).toBe(
      'fixture-extension',
    );
    expect(readJson(tree, 'apps/extension/package.json').name).toBe(
      '@fixture/extension',
    );
  });
});
