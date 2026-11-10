import { Linter, type Rule } from 'eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import { describe, expect, it } from 'vitest';
import { createReactConfig, withReactConfig } from './react-config';
import { megamonoEslintPlugin } from './plugin';
import { DEFAULT_MEGAMONO_CONFIG } from '../lib/config';

const source =
  'import {useState} from "react"; export function Widget({enabled}) { if(enabled) useState(0); return <div/>; }';
function lint(
  code: string,
  filename = 'src/widget.tsx',
  config = createReactConfig(reactHooks),
) {
  return new Linter().verify(
    code,
    [
      {
        files: ['**/*.{jsx,tsx,js,ts}'],
        languageOptions: {
          ecmaVersion: 2024,
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
      },
      config,
    ],
    { filename },
  );
}

describe('explicit React Hooks flat config', () => {
  it('runs real Rules of Hooks violations at recommended error severity', () => {
    const message = lint(source).find(
      (item) => item.ruleId === 'react-hooks/rules-of-hooks',
    );
    expect(message?.severity).toBe(2);
  });
  it('retains the real exhaustive-deps warning severity', () => {
    const message = lint(
      'import {useEffect} from "react"; export function Widget({value}) { useEffect(()=>{console.log(value)},[]); return <div/>; }',
    ).find((item) => item.ruleId === 'react-hooks/exhaustive-deps');
    expect(message?.severity).toBe(1);
  });
  it('accepts valid hook order', () => {
    expect(
      lint(
        'import {useState} from "react"; export function Widget() { const [value] = useState(0); return <div>{value}</div>; }',
      ),
    ).toEqual([]);
  });
  it('scopes defaults to JSX/TSX, not arbitrary JavaScript or TypeScript', () => {
    const code =
      'import {useState} from "react"; export function useThing(enabled) { if(enabled) useState(0); }';
    expect(lint(code, 'src/helper.ts')).toEqual([]);
    expect(lint(code, 'src/helper.js')).toEqual([]);
    const optedIn = lint(
      code,
      'src/useThing.ts',
      createReactConfig(reactHooks, { files: ['src/**/*.{js,jsx,ts,tsx}'] }),
    );
    expect(
      optedIn.some((item) => item.ruleId === 'react-hooks/rules-of-hooks'),
    ).toBe(true);
  });
  it('preserves caller overrides and never mutates the upstream preset', () => {
    const original = reactHooks.configs.recommended.rules;
    const snapshot = JSON.stringify(original);
    const config = createReactConfig(reactHooks);
    expect(config.plugins?.['react-hooks']).toBe(reactHooks);
    expect(config.rules).toEqual(original);
    expect(config.rules).not.toBe(original);
    const results = new Linter().verify(
      source,
      [
        {
          files: ['**/*.tsx'],
          languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
        },
        config,
        { rules: { 'react-hooks/rules-of-hooks': 'warn' } },
      ],
      { filename: 'src/widget.tsx' },
    );
    expect(
      results.find((item) => item.ruleId === 'react-hooks/rules-of-hooks')
        ?.severity,
    ).toBe(1);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
  it.each([
    undefined,
    {},
    { rules: {}, configs: { recommended: { rules: {} } } },
  ])('rejects absent or incomplete explicit plugins', (plugin) => {
    expect(() => createReactConfig(plugin)).toThrow(
      'explicitly imported eslint-plugin-react-hooks',
    );
  });
  it.each([{ files: [] }, { files: [''] }])(
    'rejects empty file selectors %j',
    ({ files }) => {
      expect(() => createReactConfig(reactHooks, { files })).toThrow(
        'at least one nonempty',
      );
    },
  );
  it('keeps legacy config independent from the optional React opt-in', () => {
    const config = megamonoEslintPlugin.createConfig({
      conventions: DEFAULT_MEGAMONO_CONFIG.conventions,
    });
    expect(config.plugins).not.toHaveProperty('react-hooks');
    expect(megamonoEslintPlugin.createReactConfig).toBe(createReactConfig);
    expect(megamonoEslintPlugin.withReactConfig).toBe(withReactConfig);
  });
  it('forwards optional docs authority without changing conventions-only callers', () => {
    const legacy = megamonoEslintPlugin.createConfig({
      conventions: DEFAULT_MEGAMONO_CONFIG.conventions,
    });
    const explicit = megamonoEslintPlugin.createConfig({
      conventions: DEFAULT_MEGAMONO_CONFIG.conventions,
      docs: { root: 'architecture' },
    });
    expect(legacy.rules?.['megamono/platform-boundary']).toEqual([
      'error',
      { workspaceRoot: process.cwd() },
    ]);
    expect(explicit.rules?.['megamono/platform-boundary']).toEqual([
      'error',
      { workspaceRoot: process.cwd(), docsRoot: 'architecture' },
    ]);
  });
});

describe('React flat-config composition', () => {
  it('reuses the real existing instance instead of a distinct supplied copy', () => {
    const supplied = { ...reactHooks };
    const base = [
      {
        files: ['**/*.tsx'],
        languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { 'react-hooks': reactHooks },
      },
    ];
    const config = withReactConfig(supplied, base);
    expect(config).not.toBe(base);
    expect(config[0]).toBe(base[0]);
    expect(config.at(-1)?.plugins?.['react-hooks']).toBe(reactHooks);
    const messages = new Linter().verify(source, config, {
      filename: 'src/widget.tsx',
    });
    expect(
      messages.some((item) => item.ruleId === 'react-hooks/rules-of-hooks'),
    ).toBe(true);
    expect(base).toHaveLength(1);
  });
  it('retains custom rules, globals and hook settings from the base', () => {
    const custom: Rule.RuleModule = {
      meta: {
        schema: [],
        messages: { custom: 'Existing custom hook rule remains active.' },
      },
      create(context) {
        return {
          Program(node) {
            context.report({ node, messageId: 'custom' });
          },
        };
      },
    };
    const registered = {
      ...reactHooks,
      rules: { ...reactHooks.rules, 'custom-check': custom },
    };
    const base = [
      {
        files: ['**/*.tsx'],
        languageOptions: {
          globals: { applicationValue: 'readonly' as const },
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        settings: {
          'react-hooks': { additionalEffectHooks: 'useApplicationEffect' },
        },
        plugins: { 'react-hooks': registered },
        rules: {
          'react-hooks/custom-check': 'warn' as const,
          'no-undef': 'error' as const,
        },
      },
    ];
    const config = withReactConfig(reactHooks, base);
    const messages = new Linter().verify(
      'export function Widget(){return <div>{applicationValue}</div>}',
      config,
      { filename: 'src/widget.tsx' },
    );
    expect(messages).toEqual([
      expect.objectContaining({
        ruleId: 'react-hooks/custom-check',
        severity: 1,
      }),
    ]);
    expect(config[0].settings).toBe(base[0].settings);
    expect(config[0].languageOptions?.globals).toBe(
      base[0].languageOptions.globals,
    );
    expect(base[0].rules).toEqual({
      'react-hooks/custom-check': 'warn',
      'no-undef': 'error',
    });
    const customEffect = new Linter().verify(
      'import {useApplicationEffect} from "./hooks"; export function Widget({value}){useApplicationEffect(()=>{applicationValue(value)},[]);return <div/>}',
      config,
      { filename: 'src/widget.tsx' },
    );
    expect(
      customEffect.find((item) => item.ruleId === 'react-hooks/exhaustive-deps')
        ?.severity,
    ).toBe(1);
  });
  it('does not hide conflicting registrations even when one matches the supplied plugin', () => {
    expect(() =>
      withReactConfig(reactHooks, [
        { plugins: { 'react-hooks': reactHooks } },
        { plugins: { 'react-hooks': { ...reactHooks } } },
      ]),
    ).toThrow('conflicting react-hooks plugin instances');
  });
  it('rejects incomplete existing registrations instead of silently substituting one', () => {
    expect(() =>
      withReactConfig(reactHooks, [
        { plugins: { 'react-hooks': { rules: {} } } },
      ]),
    ).toThrow('explicitly imported eslint-plugin-react-hooks');
  });
  it('uses the explicit supplied plugin when there is no existing registration', () => {
    const configs = withReactConfig(reactHooks, [], { files: ['src/**/*.ts'] });
    expect(configs).toHaveLength(1);
    expect(configs[0].plugins?.['react-hooks']).toBe(reactHooks);
    expect(configs[0].files).toEqual(['src/**/*.ts']);
  });
});
