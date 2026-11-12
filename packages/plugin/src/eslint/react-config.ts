import type { Linter, Rule } from 'eslint';

export interface ReactLintConfigOptions {
  /** Flat-config patterns; supply project-local source patterns for custom hooks. */
  readonly files?: readonly string[];
}

interface HooksPlugin {
  readonly rules: Record<string, Rule.RuleModule>;
  readonly configs: {
    readonly recommended: {
      readonly rules: NonNullable<Linter.Config['rules']>;
    };
  };
}

function recommendedPlugin(value: unknown): HooksPlugin {
  const plugin = value as Partial<HooksPlugin> | undefined;
  const rules = plugin?.rules;
  const recommended = plugin?.configs?.recommended?.rules;
  if (
    !rules ||
    !recommended ||
    !Object.hasOwn(recommended, 'react-hooks/rules-of-hooks') ||
    !Object.hasOwn(recommended, 'react-hooks/exhaustive-deps') ||
    Object.keys(recommended).some(
      (name) =>
        !name.startsWith('react-hooks/') ||
        typeof rules[name.slice('react-hooks/'.length)]?.create !== 'function',
    )
  )
    throw new Error(
      'createReactConfig requires the explicitly imported eslint-plugin-react-hooks plugin and its recommended preset. Install it in this workspace and pass the plugin object.',
    );
  return plugin as HooksPlugin;
}

/** Opt in where React is used, without loading optional peers for other projects. */
export function createReactConfig(
  hooksPlugin: unknown,
  options: ReactLintConfigOptions = {},
): Linter.Config {
  const plugin = recommendedPlugin(hooksPlugin);
  const files = options.files ?? ['**/*.{jsx,tsx}'];
  if (
    !Array.isArray(files) ||
    !files.length ||
    files.some((pattern) => typeof pattern !== 'string' || !pattern.trim())
  )
    throw new Error(
      'React lint files must contain at least one nonempty flat-config pattern.',
    );
  return {
    name: '@megamono/plugin/react-hooks',
    files: [...files],
    plugins: {
      'react-hooks': hooksPlugin as NonNullable<
        Linter.Config['plugins']
      >[string],
    },
    // Preserve the installed recommended preset's severity/options. Callers may
    // override them with a later flat-config entry, just as with the upstream plugin.
    rules: { ...plugin.configs.recommended.rules },
  };
}

/** Reuse an upstream registration rather than redefining its plugin identity. */
export function withReactConfig(
  hooksPlugin: unknown,
  configs: readonly Linter.Config[],
  options: ReactLintConfigOptions = {},
): Linter.Config[] {
  const existing = new Set(
    configs.flatMap((config) =>
      config.plugins && Object.hasOwn(config.plugins, 'react-hooks')
        ? [config.plugins['react-hooks']]
        : [],
    ),
  );
  if (existing.size > 1)
    throw new Error(
      'React lint configuration contains conflicting react-hooks plugin instances. Review the existing registrations before adding the React preset.',
    );
  const selected = existing.size ? existing.values().next().value : hooksPlugin;
  return [...configs, createReactConfig(selected, options)];
}
