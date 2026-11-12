import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { addProjectConfiguration, readJson, writeJson } from '@nx/devkit';
import { describe, expect, it } from 'vitest';
import { libraryEntrypointGenerator } from './library-entrypoint';

function library(exports: unknown) {
  const tree = createTreeWithEmptyWorkspace();
  addProjectConfiguration(tree, 'acme-browser', {
    root: 'libs/browser',
    projectType: 'library',
  });
  writeJson(tree, 'libs/browser/package.json', {
    name: '@acme/browser',
    private: true,
    exports,
  });
  tree.write(
    'libs/browser/src/index.ts',
    "export * from './lib/browser.js';\n",
  );
  tree.write('libs/browser/src/lib/browser.ts', 'export const browser = 1;\n');
  return tree;
}

describe('library entry point generator', () => {
  it('adds a source subpath export beside the root export of a private library', async () => {
    const tree = library({
      '.': { types: './src/index.ts', default: './src/index.ts' },
    });
    await libraryEntrypointGenerator(tree, {
      project: 'acme-browser',
      name: 'ranking',
    });
    expect(readJson(tree, 'libs/browser/package.json').exports).toEqual({
      '.': { types: './src/index.ts', default: './src/index.ts' },
      './ranking': {
        types: './src/ranking/index.ts',
        default: './src/ranking/index.ts',
      },
    });
    expect(tree.read('libs/browser/src/ranking/index.ts', 'utf8')).toContain(
      'must not import the root index',
    );
  });

  it('mirrors built and custom-condition targets of a publishable library', async () => {
    const tree = library({
      './package.json': './package.json',
      '.': {
        '@acme/source': './src/index.ts',
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
    });
    tree.write('libs/browser/src/protocol/index.ts', 'export const v = 1;\n');
    await libraryEntrypointGenerator(tree, {
      project: 'acme-browser',
      name: 'protocol',
    });
    const exports = readJson(tree, 'libs/browser/package.json').exports;
    expect(Object.keys(exports)).toEqual(['./package.json', '.', './protocol']);
    expect(exports['./protocol']).toEqual({
      '@acme/source': './src/protocol/index.ts',
      types: './dist/protocol/index.d.ts',
      import: './dist/protocol/index.js',
      default: './dist/protocol/index.js',
    });
    expect(tree.read('libs/browser/src/protocol/index.ts', 'utf8')).toBe(
      'export const v = 1;\n',
    );
  });

  it('declares sideEffects:false only when sources have no side-effect-only imports', async () => {
    const tree = library({ '.': './src/index.ts' });
    tree.write('libs/browser/src/index.spec.ts', "import './setup';\n");
    await libraryEntrypointGenerator(tree, {
      project: 'acme-browser',
      sideEffects: false,
    });
    expect(readJson(tree, 'libs/browser/package.json').sideEffects).toBe(false);
    const styled = library({ '.': './src/index.ts' });
    styled.write('libs/browser/src/lib/theme.ts', "import './theme.css';\n");
    await expect(
      libraryEntrypointGenerator(styled, {
        project: 'acme-browser',
        sideEffects: false,
      }),
    ).rejects.toThrow('libs/browser/src/lib/theme.ts imports ./theme.css');
    expect(
      readJson(styled, 'libs/browser/package.json').sideEffects,
    ).toBeUndefined();
  });

  it('rejects unsupported layouts, duplicates and missing intent before writing', async () => {
    const tree = library({ '.': { default: './src/main.ts' } });
    await expect(
      libraryEntrypointGenerator(tree, { project: 'acme-browser', name: 'x' }),
    ).rejects.toThrow('not an index file');
    await expect(
      libraryEntrypointGenerator(tree, { project: 'acme-browser' }),
    ).rejects.toThrow('--name');
    await expect(
      libraryEntrypointGenerator(tree, { project: 'missing', name: 'x' }),
    ).rejects.toThrow('not a library');
    const duplicate = library({
      '.': './src/index.ts',
      './ranking': './src/ranking/index.ts',
    });
    await expect(
      libraryEntrypointGenerator(duplicate, {
        project: 'acme-browser',
        name: 'ranking',
      }),
    ).rejects.toThrow('already exports');
    const planned = library({ '.': './src/index.ts' });
    const before = planned.listChanges().length;
    await libraryEntrypointGenerator(planned, {
      project: 'acme-browser',
      name: 'ranking',
      dryRun: true,
    });
    expect(planned.listChanges()).toHaveLength(before);
  });
});
