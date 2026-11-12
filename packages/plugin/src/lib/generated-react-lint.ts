import {
  addDependenciesToPackageJson,
  readJson,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { locateEslintFlatConfig } from './eslint-flat-config';

/** Fresh React project wiring only. Existing projects are never migrated. */
export function wireGeneratedReactLint(
  tree: Tree,
  root: string,
  qualifiedVersion: string,
): GeneratorCallback {
  const path = `${root}/eslint.config.mjs`;
  const source = tree.read(path, 'utf8');
  const array = source === null ? undefined : locateEslintFlatConfig(source);
  const legacy = `${root}/.eslintrc.json`;
  if (source === null && tree.exists(legacy)) {
    const config = readJson(tree, legacy);
    tree.write(
      legacy,
      JSON.stringify(
        {
          ...config,
          overrides: [
            ...(config.overrides ?? []),
            {
              files: ['src/**/*.{js,jsx,ts,tsx}'],
              extends: ['plugin:react-hooks/recommended'],
            },
          ],
        },
        null,
        2,
      ) + '\n',
    );
  } else if (source === null || !array)
    throw new Error(
      `Cannot add React Hooks lint to ${path}: review the unsupported generated flat-config template.`,
    );
  else {
    const imports = `import megamonoReactPlugin from '@megamono/plugin/eslint';\nimport reactHooks from 'eslint-plugin-react-hooks';\n`;
    tree.write(
      path,
      imports +
        source.slice(0, array.opening) +
        'megamonoReactPlugin.withReactConfig(reactHooks, ' +
        source.slice(array.opening, array.closing + 1) +
        ", { files: ['src/**/*.{js,jsx,ts,tsx}'] })" +
        source.slice(array.closing + 1),
    );
  }
  const manifest = readJson(tree, 'package.json');
  const declared =
    manifest.devDependencies?.['eslint-plugin-react-hooks'] ??
    manifest.dependencies?.['eslint-plugin-react-hooks'];
  return addDependenciesToPackageJson(
    tree,
    {},
    declared ? {} : { 'eslint-plugin-react-hooks': qualifiedVersion },
  );
}
