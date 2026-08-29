import { readJson, type Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { appleApplicationGenerator } from './application';

const options = {
  name: 'Acme Tools Apple',
  directory: 'apps/apple',
  displayName: 'Acme Tools',
  bundleIdentifier: 'com.acme-tools.apple',
  deploymentTarget: '14.0',
  scope: 'acme-tools',
  tags: 'visibility:internal,type:app,scope:acme-tools,platform:apple',
  skipFormat: true,
};

function generatedFiles(tree: Tree): Record<string, string> {
  return Object.fromEntries(
    tree
      .listChanges()
      .filter((change) => change.type !== 'DELETE')
      .map((change) => [change.path, change.content?.toString() ?? '']),
  );
}

describe('appleApplicationGenerator', () => {
  it('creates a deterministic SwiftUI app, unit tests, and shared scheme', async () => {
    const first = createTreeWithEmptyWorkspace();
    const second = createTreeWithEmptyWorkspace();

    await appleApplicationGenerator(first, options);
    await appleApplicationGenerator(second, options);

    expect(generatedFiles(first)).toEqual(generatedFiles(second));
    const beforeRerun = generatedFiles(first);
    await appleApplicationGenerator(first, options);
    expect(generatedFiles(first)).toEqual(beforeRerun);
    expect(
      first.exists('apps/apple/acme-tools-apple.xcodeproj/project.pbxproj'),
    ).toBe(true);
    expect(
      first.exists(
        'apps/apple/acme-tools-apple.xcodeproj/xcshareddata/xcschemes/acme-tools-apple.xcscheme',
      ),
    ).toBe(true);
    expect(
      first.read('apps/apple/App/AcmeToolsAppleApp.swift', 'utf8'),
    ).toContain('@main');
    expect(
      first.read('apps/apple/Tests/AcmeToolsAppleTests.swift', 'utf8'),
    ).toContain('@testable import AcmeToolsApple');

    expect(readJson(first, 'apps/apple/project.json')).toEqual({
      name: 'acme-tools-apple',
      projectType: 'application',
      sourceRoot: 'apps/apple/App',
      tags: [
        'platform:apple',
        'scope:acme-tools',
        'type:app',
        'visibility:internal',
      ],
    });
    expect(readJson(first, 'nx.json').plugins).toContainEqual({
      plugin: '@megamono/nx-apple',
      options: { scope: 'acme-tools' },
    });

    const pbx = first.read(
      'apps/apple/acme-tools-apple.xcodeproj/project.pbxproj',
      'utf8',
    );
    expect(pbx).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.acme-tools.apple;');
    expect(pbx).toContain(
      'productType = "com.apple.product-type.application";',
    );
    expect(pbx).toContain(
      'productType = "com.apple.product-type.bundle.unit-test";',
    );
    expect(pbx).toContain(
      'TEST_HOST = "$(BUILT_PRODUCTS_DIR)/acme-tools-apple.app',
    );
  });

  it('refuses to overwrite a populated application directory', async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('apps/apple/owned.txt', 'keep');

    await expect(appleApplicationGenerator(tree, options)).rejects.toThrow(
      'directory is not empty',
    );
    expect(tree.read('apps/apple/owned.txt', 'utf8')).toBe('keep');
  });

  it('normalizes a numeric deployment target produced by the Nx CLI', async () => {
    const tree = createTreeWithEmptyWorkspace();
    await appleApplicationGenerator(tree, {
      ...options,
      deploymentTarget: 14,
    });
    expect(
      tree.read(
        'apps/apple/acme-tools-apple.xcodeproj/project.pbxproj',
        'utf8',
      ),
    ).toContain('MACOSX_DEPLOYMENT_TARGET = 14.0;');
  });

  it.each([
    [{ ...options, directory: '../apple' }, 'workspace-relative'],
    [{ ...options, bundleIdentifier: 'not-a-bundle-id' }, 'reverse-DNS'],
    [{ ...options, deploymentTarget: 'latest' }, 'dotted version'],
  ])('rejects invalid options', async (invalid, message) => {
    const tree = createTreeWithEmptyWorkspace();
    await expect(appleApplicationGenerator(tree, invalid)).rejects.toThrow(
      message,
    );
  });
});
