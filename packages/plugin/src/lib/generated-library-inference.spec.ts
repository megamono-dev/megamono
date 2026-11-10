import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { readJson, writeJson } from '@nx/devkit';
import { describe, expect, it } from 'vitest';
import {
  canInferGeneratedLibrary,
  scopeGeneratedLibraryInference,
} from './generated-library-inference';

describe('generated library inference', () => {
  it('scopes newly introduced lint and TypeScript registrations without widening unrelated projects', () => {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'nx.json', {
      plugins: [
        'existing/plugin',
        '@nx/eslint/plugin',
        {
          plugin: '@nx/js/typescript',
          options: { typecheck: { targetName: 'typecheck' } },
        },
      ],
    });
    scopeGeneratedLibraryInference(tree, 'libs/ui', ['existing/plugin']);
    expect(readJson(tree, 'nx.json').plugins).toEqual([
      'existing/plugin',
      { plugin: '@nx/eslint/plugin', include: ['libs/ui/**/*'] },
      {
        plugin: '@nx/js/typescript',
        options: { typecheck: { targetName: 'typecheck' } },
        include: ['libs/ui/**/*'],
      },
    ]);
  });
  it('preserves existing global registrations and custom target names', () => {
    const tree = createTreeWithEmptyWorkspace();
    const plugins = [
      { plugin: '@nx/eslint/plugin', options: { targetName: 'eslint' } },
      '@nx/js/typescript',
    ];
    writeJson(tree, 'nx.json', { plugins });
    scopeGeneratedLibraryInference(tree, 'libs/ui', plugins);
    expect(readJson(tree, 'nx.json').plugins).toEqual(plugins);
  });
  it('retains existing scoped policy and adds only the new library to equivalent policy', () => {
    const tree = createTreeWithEmptyWorkspace();
    const plugins = [
      {
        plugin: '@nx/eslint/plugin',
        options: { targetName: 'eslint' },
        include: ['apps/old/**/*'],
        exclude: ['**/excluded/**'],
      },
    ];
    writeJson(tree, 'nx.json', { plugins });
    scopeGeneratedLibraryInference(tree, 'libs/ui', plugins);
    expect(readJson(tree, 'nx.json').plugins).toEqual([
      ...plugins,
      {
        plugin: '@nx/eslint/plugin',
        options: { targetName: 'eslint' },
        include: ['libs/ui/**/*'],
      },
    ]);
  });
  it('rejects ambiguous existing scoped policies instead of choosing a target convention', () => {
    const tree = createTreeWithEmptyWorkspace();
    const plugins = [
      {
        plugin: '@nx/eslint/plugin',
        options: { targetName: 'lint' },
        include: ['apps/one/**/*'],
      },
      {
        plugin: '@nx/eslint/plugin',
        options: { targetName: 'eslint' },
        include: ['apps/two/**/*'],
      },
    ];
    writeJson(tree, 'nx.json', { plugins });
    expect(() =>
      scopeGeneratedLibraryInference(tree, 'libs/ui', plugins),
    ).toThrow('different policies');
    expect(readJson(tree, 'nx.json').plugins).toEqual(plugins);
  });
  it('respects legacy Nx and explicit inference opt-out', () => {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'package.json', { devDependencies: { nx: '17.1.2' } });
    expect(canInferGeneratedLibrary(tree)).toBe(false);
    writeJson(tree, 'package.json', { devDependencies: { nx: '23.3.1' } });
    writeJson(tree, 'nx.json', { useInferencePlugins: false });
    expect(canInferGeneratedLibrary(tree)).toBe(false);
  });
});
