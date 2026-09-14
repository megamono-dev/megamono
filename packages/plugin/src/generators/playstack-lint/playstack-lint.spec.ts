import { readJson, writeJson, type Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { DEFAULT_MEGAMONO_CONFIG } from '../../lib/config';
import playstackLintGenerator from './playstack-lint';

function fixture(product = true): Tree {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    name: '@acme/workspace',
    private: true,
    ...(product
      ? { dependencies: { '@playstack/content': '0.1.0-beta.1' } }
      : {}),
    devDependencies: { eslint: '^9.39.0' },
  });
  writeJson(tree, 'megamono.json', DEFAULT_MEGAMONO_CONFIG);
  tree.write(
    'eslint.config.mjs',
    "import nx from '@nx/eslint-plugin';\n\nexport default [\n  ...nx.configs['flat/base'],\n];\n",
  );
  return tree;
}

function snapshot(tree: Tree): string[] {
  return tree
    .listChanges()
    .map(
      (change) =>
        `${change.type}:${change.path}:${change.content?.toString('utf8') ?? ''}`,
    );
}

describe('playstack-lint generator', () => {
  it.each([false, true])(
    'supports semicolon-free exports and comments idempotently (trailing comma: %s)',
    async (comma) => {
      const tree = fixture();
      tree.write('.prettierrc', JSON.stringify({ semi: false }));
      tree.write(
        'eslint.config.mjs',
        `export\n default /* keep export */ [\n { files: ['**/*.ts'] }${comma ? ',' : ''} // keep entry\n]\nconst unrelated = ['keep me'];\n`,
      );
      const before = snapshot(tree);
      await playstackLintGenerator(tree, { dryRun: true });
      expect(snapshot(tree)).toEqual(before);
      await playstackLintGenerator(tree, {});
      const applied = tree.read('eslint.config.mjs', 'utf8') ?? '';
      expect(applied).toContain('// keep entry');
      expect(applied).toContain('/* keep export */');
      expect(
        applied.indexOf(
          'playstackLintWarnings(playstackLintConfigs.recommended)',
        ),
      ).toBeLessThan(applied.indexOf('const unrelated'));
      await playstackLintGenerator(tree, {});
      expect(tree.read('eslint.config.mjs', 'utf8')).toBe(applied);
      await playstackLintGenerator(tree, { preset: 'all' });
      const switched = tree.read('eslint.config.mjs', 'utf8') ?? '';
      expect(switched).toContain('playstackLintConfigs.all');
      await playstackLintGenerator(tree, { preset: 'all' });
      expect(tree.read('eslint.config.mjs', 'utf8')).toBe(switched);
    },
  );

  it('does not mistake logic edits for formatting changes in semicolon-free sections', async () => {
    const tree = fixture();
    tree.write(
      '.prettierrc',
      JSON.stringify({ semi: false, singleQuote: false }),
    );
    await playstackLintGenerator(tree, {});
    const source = tree.read('eslint.config.mjs', 'utf8') ?? '';
    tree.write('eslint.config.mjs', source.replace(/"warn"/g, '"off"'));
    const before = snapshot(tree);
    await expect(playstackLintGenerator(tree, {})).rejects.toThrow(
      'managed Playstack lint import section was modified',
    );
    expect(snapshot(tree)).toEqual(before);
  });

  it.each([
    'export default defineConfig([])',
    'const config = []; export default config',
    'export default [',
  ])('rejects unsupported exports before any writes: %s', async (source) => {
    const tree = fixture();
    tree.write('eslint.config.mjs', source);
    const before = snapshot(tree);
    await expect(playstackLintGenerator(tree, {})).rejects.toThrow(
      'must export a flat config array',
    );
    expect(snapshot(tree)).toEqual(before);
  });
  it('plans without mutation, then adds the warning-first preset idempotently', async () => {
    const tree = fixture();
    const before = snapshot(tree);

    await playstackLintGenerator(tree, {
      preset: 'recommended',
      dryRun: true,
      interactive: false,
    });
    expect(snapshot(tree)).toEqual(before);

    const callback = await playstackLintGenerator(tree, {
      preset: 'recommended',
      interactive: false,
    });
    expect(callback).toBeTypeOf('function');
    const source = tree.read('eslint.config.mjs', 'utf8') ?? '';
    expect(source).toContain("from '@playstack/lint'");
    expect(source).toContain(
      'playstackLintWarnings(playstackLintConfigs.recommended)',
    );
    expect(source).toContain("Array.isArray(value) ? ['warn'");
    expect(readJson(tree, 'package.json')).toMatchObject({
      devDependencies: { '@playstack/lint': '0.1.0-beta.1' },
    });

    const applied = snapshot(tree);
    const rerun = await playstackLintGenerator(tree, {
      preset: 'recommended',
      interactive: false,
    });
    expect(rerun).toBeUndefined();
    expect(snapshot(tree)).toEqual(applied);
  });

  it('updates only the pristine managed preset selection', async () => {
    const tree = fixture();
    await playstackLintGenerator(tree, { preset: 'recommended' });
    await playstackLintGenerator(tree, { preset: 'all' });

    const source = tree.read('eslint.config.mjs', 'utf8') ?? '';
    expect(source).toContain('playstackLintWarnings(playstackLintConfigs.all)');
    expect(source).not.toContain(
      'playstackLintWarnings(playstackLintConfigs.recommended)',
    );
  });

  it('retains a local package address and refuses modified wiring', async () => {
    const tree = fixture();
    writeJson(tree, 'package.json', {
      name: '@acme/workspace',
      private: true,
      dependencies: { '@playstack/content': '0.1.0-beta.1' },
      devDependencies: {
        '@playstack/lint': 'file:.yalc/@playstack/lint',
        eslint: '^9.39.0',
      },
    });
    await playstackLintGenerator(tree, {});
    expect(readJson(tree, 'package.json')).toMatchObject({
      devDependencies: {
        '@playstack/lint': 'file:.yalc/@playstack/lint',
      },
    });
    tree.write(
      'eslint.config.mjs',
      (tree.read('eslint.config.mjs', 'utf8') ?? '').replace(
        'playstackLintWarnings =',
        'locallyChanged =',
      ),
    );
    const before = snapshot(tree);
    await expect(playstackLintGenerator(tree, {})).rejects.toThrow(
      /managed Playstack lint import section was modified/,
    );
    expect(snapshot(tree)).toEqual(before);
  });

  it('requires an initialized linted workspace with a Playstack product', async () => {
    await expect(playstackLintGenerator(fixture(false), {})).rejects.toThrow(
      /No @playstack\/\* product package/,
    );

    const missingLint = fixture();
    missingLint.delete('eslint.config.mjs');
    await expect(playstackLintGenerator(missingLint, {})).rejects.toThrow(
      /initialize the Megamono lint module first/,
    );
  });
});
