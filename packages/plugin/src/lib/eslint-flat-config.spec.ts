import ts = require('typescript');
import {
  appendEslintFlatConfig,
  locateEslintFlatConfig,
} from './eslint-flat-config';

describe('syntax-aware ESLint flat config editing', () => {
  it.each([
    'export default []',
    'export default [];',
    'export\n default /* array */ ([{ files: ["**/*.ts"] }])',
    'export default [config // trailing line comment\n]',
    'export default [config /* trailing block comment */]',
    'export default [config, // comma already present\n]',
    'export default [/* empty comment */]',
    'export default [config /* comma in comment , */]',
    'export default [config]\nconst unrelated = ["fake ];"];',
    'export default [config]\r\n// final comment ];',
  ])(
    'inserts into the exported array and preserves surrounding bytes: %s',
    (source) => {
      const result = appendEslintFlatConfig(source, '  addedConfig,');
      if (result === undefined) throw new Error('Expected edited config');
      expect(result).toBeTypeOf('string');
      expect(locateEslintFlatConfig(result)).toBeDefined();
      const file = ts.createSourceFile(
        'eslint.config.mjs',
        result,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const exported = file.statements.find(ts.isExportAssignment);
      if (!exported) throw new Error('Expected default export');
      let expression = exported.expression;
      while (ts.isParenthesizedExpression(expression))
        expression = expression.expression;
      expect(ts.isArrayLiteralExpression(expression)).toBe(true);
      if (!ts.isArrayLiteralExpression(expression))
        throw new Error('Expected array');
      expect(expression.elements.at(-1)?.getText(file)).toBe('addedConfig');
      const location = locateEslintFlatConfig(source);
      if (!location) throw new Error('Expected array location');
      let expected = source.slice(0, location.closing);
      if (location.separatorAt !== undefined)
        expected = `${expected.slice(0, location.separatorAt)},${expected.slice(location.separatorAt)}`;
      expect(result.startsWith(expected)).toBe(true);
      expect(result.endsWith(source.slice(location.closing))).toBe(true);
    },
  );

  it('puts a required separator before, not inside, trailing comments', () => {
    expect(
      appendEslintFlatConfig('export default [config // keep\n]', '  added,'),
    ).toBe('export default [config, // keep\n  added,\n]');
  });

  it.each([
    'const config = []; export default config;',
    'export default defineConfig([]);',
    'export default {}; const unrelated = [];',
    '// export default []\nconst config = [];',
    'export default [',
    'export default []; export default [];',
  ])(
    'rejects malformed or unsupported export shapes without guessing: %s',
    (source) => {
      expect(locateEslintFlatConfig(source)).toBeUndefined();
      expect(appendEslintFlatConfig(source, 'added,')).toBeUndefined();
    },
  );
});
