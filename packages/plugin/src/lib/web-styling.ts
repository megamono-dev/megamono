import { getProjects, readJson, type Tree } from '@nx/devkit';

export const WEB_STYLING_OPTIONS = [
  'auto',
  'chakra',
  'emotion',
  'tailwind',
  'panda',
  'stylex',
  'css-modules',
  'inline',
] as const;

export type WebStyling = (typeof WEB_STYLING_OPTIONS)[number];
export type ResolvedWebStyling = Exclude<WebStyling, 'auto'>;

const WEB_STYLING_SET = new Set<string>(WEB_STYLING_OPTIONS);

export function isWebStyling(value: string): value is WebStyling {
  return WEB_STYLING_SET.has(value);
}

function manifestPackages(tree: Tree): Set<string> {
  const packages = new Set<string>();
  const paths = new Set<string>(['package.json']);
  for (const project of getProjects(tree).values()) {
    paths.add(`${project.root}/package.json`);
  }
  for (const path of paths) {
    if (!tree.exists(path)) continue;
    const manifest = readJson<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(tree, path);
    for (const name of Object.keys(manifest.dependencies ?? {}))
      packages.add(name);
    for (const name of Object.keys(manifest.devDependencies ?? {}))
      packages.add(name);
  }
  return packages;
}

/** Detects an existing styling tool without making it a workspace invariant. */
export function detectWebStyling(tree: Tree): WebStyling {
  const packages = manifestPackages(tree);
  if (packages.has('@chakra-ui/react')) return 'chakra';
  if (
    packages.has('@stylexjs/stylex') ||
    packages.has('@stylexjs/babel-plugin')
  )
    return 'stylex';
  if (
    packages.has('@pandacss/dev') ||
    [...getProjects(tree).values()].some((project) =>
      tree.exists(`${project.root}/panda.config.ts`),
    ) ||
    tree.exists('panda.config.ts')
  )
    return 'panda';
  if (packages.has('tailwindcss')) return 'tailwind';
  if (packages.has('@emotion/react') || packages.has('@emotion/styled'))
    return 'emotion';
  return 'auto';
}
