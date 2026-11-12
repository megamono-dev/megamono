import { Linter, RuleTester } from 'eslint';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { noBareJsxStrings } from './no-bare-jsx-strings';

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});
const filename = (path: string) => join(process.cwd(), path);
const text = '<Button>Fixture text</Button>;';
tester.run('no-bare-jsx-strings exclusions', noBareJsxStrings, {
  valid: [
    { filename: filename('src/button.spec.tsx'), code: text },
    { filename: filename('src/button.test.jsx'), code: text },
    { filename: filename('src/__tests__/fixture.tsx'), code: text },
    {
      filename: filename('src/dev/tokens.tsx'),
      code: text,
      options: [{ ignorePatterns: ['**/dev/**'] }],
    },
    {
      filename: filename('src/button.stories.tsx'),
      code: text,
      options: [{ ignorePatterns: ['**/*.stories.tsx'] }],
    },
    {
      filename: filename('src/dev/tokens.tsx'),
      code: text,
      options: [{ ignorePatterns: ['src/dev/'] }],
    },
    {
      filename: filename('src/button.tsx'),
      code: '<Button>{messages.fixtureLabel}</Button>;',
    },
    {
      filename: filename('src/button.tsx'),
      code: '<Button>{t("fixture.label")}</Button>;',
    },
  ],
  invalid: [
    {
      filename: filename('src/button.spec.tsx'),
      code: text,
      options: [{ ignoreTests: false }],
      errors: [{ messageId: 'bare' }],
    },
    {
      filename: filename('src/dev/tokens.tsx'),
      code: text,
      errors: [{ messageId: 'bare' }],
    },
    {
      filename: filename('src/button.stories.tsx'),
      code: text,
      errors: [{ messageId: 'bare' }],
    },
    {
      filename: filename('src/components/button.tsx'),
      code: text,
      options: [{ ignorePatterns: ['**/dev/**'] }],
      errors: [{ messageId: 'bare' }],
    },
    {
      filename: filename('src/dev/live.tsx'),
      code: text,
      options: [{ ignorePatterns: ['src/dev/**', '!src/dev/live.tsx'] }],
      errors: [{ messageId: 'bare' }],
    },
    {
      filename: resolve(process.cwd(), '../outside/button.tsx'),
      code: text,
      options: [{ ignorePatterns: ['**/*'] }],
      errors: [{ messageId: 'bare' }],
    },
    {
      filename: filename('src/button.tsx'),
      code: '<Button>{"Inline text"}</Button>;',
      errors: [
        {
          message:
            'Move user-facing JSX string "Inline text" to a message catalog or localization call. This rule checks inline literals, not translation completeness.',
        },
      ],
    },
  ],
});

describe('localization policy option validation', () => {
  it.each([
    { ignorePatterns: [''] },
    { ignoreTests: 'yes' },
    { ignoreAll: true },
  ])('rejects invalid rule options %j', (options) => {
    const linter = new Linter();
    expect(() =>
      linter.verify(
        text,
        [
          {
            files: ['**/*.jsx'],
            plugins: {
              megamono: { rules: { 'no-bare-jsx-strings': noBareJsxStrings } },
            },
            languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
            rules: { 'megamono/no-bare-jsx-strings': ['warn', options] },
          },
        ],
        { filename: filename('src/button.jsx') },
      ),
    ).toThrow();
  });
});
