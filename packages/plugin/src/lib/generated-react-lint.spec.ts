import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { readJson, writeJson } from '@nx/devkit';
import { describe, expect, it } from 'vitest';
import { wireGeneratedReactLint } from './generated-react-lint';

describe('generated React lint wiring', () => {
  it('scopes hooks and custom .ts hooks to the new React project without changing the base', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('eslint.config.mjs', 'export default [];\n');
    tree.write(
      'libs/ui/eslint.config.mjs',
      "import baseConfig from '../../eslint.config.mjs';\nexport default [...baseConfig, {settings: {custom: true}}];\n",
    );
    wireGeneratedReactLint(tree, 'libs/ui', '7.1.1');
    const source = tree.read('libs/ui/eslint.config.mjs', 'utf8');
    expect(source).toContain("from 'eslint-plugin-react-hooks'");
    expect(source).toContain('withReactConfig(reactHooks, [...baseConfig');
    expect(source).toContain('src/**/*.{js,jsx,ts,tsx}');
    expect(source).toContain('settings: {custom: true}');
    expect(tree.read('eslint.config.mjs', 'utf8')).toBe('export default [];\n');
    expect(
      readJson(tree, 'package.json').devDependencies[
        'eslint-plugin-react-hooks'
      ],
    ).toBe('7.1.1');
  });
  it('retains an existing declared Hooks version instead of rewriting it', () => {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'package.json', {
      devDependencies: { 'eslint-plugin-react-hooks': '^6.0.0' },
    });
    tree.write('libs/ui/eslint.config.mjs', 'export default [];');
    wireGeneratedReactLint(tree, 'libs/ui', '7.1.1');
    expect(
      readJson(tree, 'package.json').devDependencies[
        'eslint-plugin-react-hooks'
      ],
    ).toBe('^6.0.0');
  });
  it('supports the existing classic JSON lint template without converting it', () => {
    const tree = createTreeWithEmptyWorkspace();
    writeJson(tree, 'libs/ui/.eslintrc.json', {
      extends: ['../../.eslintrc.json'],
      rules: { 'custom/example': 'warn' },
    });
    wireGeneratedReactLint(tree, 'libs/ui', '7.1.1');
    expect(readJson(tree, 'libs/ui/.eslintrc.json')).toMatchObject({
      extends: ['../../.eslintrc.json'],
      rules: { 'custom/example': 'warn' },
      overrides: [
        {
          files: ['src/**/*.{js,jsx,ts,tsx}'],
          extends: ['plugin:react-hooks/recommended'],
        },
      ],
    });
    expect(tree.exists('libs/ui/eslint.config.mjs')).toBe(false);
  });
  it('fails unsupported generated factories before changing files or dependency policy', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('libs/ui/eslint.config.mjs', 'export default customFactory();');
    const before = tree.listChanges();
    expect(() => wireGeneratedReactLint(tree, 'libs/ui', '7.1.1')).toThrow(
      'unsupported',
    );
    expect(tree.listChanges()).toEqual(before);
  });
});
