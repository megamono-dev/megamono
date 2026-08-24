import type { Linter, Rule } from 'eslint';
import type { MegamonoConfig } from '../lib/config';
import { noBareJsxStrings } from './rules/no-bare-jsx-strings';
import { noDeepRelativeImports } from './rules/no-deep-relative-imports';
import { platformBoundary } from './rules/platform-boundary';

type RuleSeverity = Linter.RuleSeverity | 'off' | 'warn' | 'error';

function severity(
  config: Pick<MegamonoConfig, 'conventions'>,
  rule: keyof MegamonoConfig['conventions']['rules'],
  fallback: RuleSeverity,
): RuleSeverity {
  const configured = config.conventions.rules[rule]?.severity;
  return configured === 'warning' ? 'warn' : (configured ?? fallback);
}

const rules = {
  'no-bare-jsx-strings': noBareJsxStrings,
  'no-deep-relative-imports': noDeepRelativeImports,
  'platform-boundary': platformBoundary,
} satisfies Record<string, Rule.RuleModule>;

export const megamonoEslintPlugin = {
  meta: { name: '@megamono/plugin', version: '0.0.1' },
  rules,
  createConfig(config: Pick<MegamonoConfig, 'conventions'>): Linter.Config {
    return {
      name: '@megamono/plugin/recommended',
      files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
      ignores: ['**/eslint.config.{js,cjs,mjs,ts,cts,mts}'],
      plugins: { megamono: megamonoEslintPlugin },
      rules: {
        '@nx/enforce-module-boundaries': severity(
          config,
          'module-boundaries',
          'error',
        ),
        'megamono/no-deep-relative-imports':
          severity(config, 'no-deep-relative-imports', 'error') === 'off'
            ? 'off'
            : [
                severity(config, 'no-deep-relative-imports', 'error'),
                { workspaceRoot: process.cwd() },
              ],
        'megamono/platform-boundary':
          severity(config, 'platform-boundary', 'error') === 'off'
            ? 'off'
            : [
                severity(config, 'platform-boundary', 'error'),
                { workspaceRoot: process.cwd() },
              ],
        'megamono/no-bare-jsx-strings': severity(
          config,
          'no-bare-jsx-strings',
          'warn',
        ),
      },
    };
  },
};

export default megamonoEslintPlugin;
