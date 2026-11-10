import {
  getProjects,
  readJson,
  updateJson,
  updateProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import { nxWorkspaceCapabilities } from './workspace-compatibility';

export function canInferGeneratedLibrary(tree: Tree): boolean {
  return (
    nxWorkspaceCapabilities(tree).major >= 18 &&
    readJson(tree, 'nx.json').useInferencePlugins !== false &&
    process.env.NX_ADD_PLUGINS !== 'false'
  );
}

/** Scope only registrations introduced by this generator, not existing policy. */
export function scopeGeneratedLibraryInference(
  tree: Tree,
  root: string,
  before: readonly unknown[],
): void {
  const name = (entry: unknown): string | undefined =>
    typeof entry === 'string' ? entry : (entry as { plugin?: string }).plugin;
  updateJson(tree, 'nx.json', (value) => {
    const plugins = (value.plugins ?? []).map((entry: unknown) => {
      const plugin = name(entry);
      if (
        !['@nx/js/typescript', '@nx/eslint/plugin'].includes(plugin ?? '') ||
        before.some((previous) => name(previous) === plugin)
      )
        return entry;
      return {
        ...(typeof entry === 'string' ? { plugin: entry } : (entry as object)),
        include: [`${root}/**/*`],
      };
    });
    for (const plugin of ['@nx/js/typescript', '@nx/eslint/plugin']) {
      const registrations = before.filter(
        (entry) => name(entry) === plugin,
      ) as (
        | string
        | {
            plugin: string;
            options?: Record<string, unknown>;
            include?: string[];
            exclude?: string[];
          }
      )[];
      if (
        !registrations.length ||
        registrations.some(
          (entry) =>
            typeof entry === 'string' || (!entry.include && !entry.exclude),
        )
      )
        continue;
      const policies = new Set(
        registrations.map((entry) =>
          JSON.stringify(
            typeof entry === 'string' ? {} : (entry.options ?? {}),
          ),
        ),
      );
      if (policies.size !== 1)
        throw new Error(
          `Existing ${plugin} registrations use different policies. Review inference coverage before adding this library.`,
        );
      const representative = registrations[0];
      const options =
        typeof representative === 'string' ? undefined : representative.options;
      plugins.push({
        plugin,
        ...(options ? { options } : {}),
        include: [`${root}/**/*`],
      });
    }
    return { ...value, plugins };
  });
}

const ESLINT_PLUGIN = '@nx/eslint/plugin';
const ESLINT_CONFIG_FILES = [
  'eslint.config.mjs',
  'eslint.config.js',
  'eslint.config.cjs',
];

/**
 * Nx composed generators skip the lint target whenever any @nx/eslint/plugin
 * registration exists, even one scoped to another project, and otherwise emit
 * the deprecated @nx/eslint:lint executor whose `files` globs match from the
 * workspace root. Give every newly generated project with an ESLint config
 * inferred, project-relative linting (`eslint .` from the project root) through
 * a registration scoped to that project. Existing projects are left alone.
 */
export function inferGeneratedProjectLint(
  tree: Tree,
  existingProjects: ReadonlySet<string>,
): string[] {
  if (!canInferGeneratedLibrary(tree)) return [];
  const registrations = (
    (readJson(tree, 'nx.json').plugins ?? []) as unknown[]
  ).filter(
    (entry) =>
      (typeof entry === 'string'
        ? entry
        : (entry as { plugin?: string }).plugin) === ESLINT_PLUGIN,
  ) as (
    | string
    | {
        options?: Record<string, unknown>;
        include?: string[];
        exclude?: string[];
      }
  )[];
  const unscoped = registrations.some(
    (entry) => typeof entry === 'string' || (!entry.include && !entry.exclude),
  );
  const policies = new Set(
    registrations.map((entry) =>
      JSON.stringify(typeof entry === 'string' ? {} : (entry.options ?? {})),
    ),
  );
  if (policies.size > 1)
    throw new Error(
      `Existing ${ESLINT_PLUGIN} registrations use different policies. Review inference coverage before adding this application.`,
    );
  const included = new Set(
    registrations.flatMap((entry) =>
      typeof entry === 'string' ? [] : (entry.include ?? []),
    ),
  );
  const covered: string[] = [];
  for (const [name, project] of getProjects(tree)) {
    if (existingProjects.has(name)) continue;
    if (
      !ESLINT_CONFIG_FILES.some((file) =>
        tree.exists(`${project.root}/${file}`),
      )
    )
      continue;
    const lint = project.targets?.lint as
      | {
          executor?: string;
          command?: unknown;
          options?: Record<string, unknown>;
        }
      | undefined;
    if (lint) {
      const explicit =
        lint.executor === '@nx/eslint:lint' ||
        (lint.executor === undefined &&
          typeof lint.command === 'string' &&
          /^eslint\s/.test(lint.command));
      if (!explicit) continue;
      delete project.targets?.lint;
      updateProjectConfiguration(tree, name, project);
    }
    covered.push(project.root);
  }
  const roots = covered.filter(
    (root) => !unscoped && !included.has(`${root}/**/*`),
  );
  if (roots.length === 0) return covered;
  const representative = registrations[0];
  const options =
    representative && typeof representative !== 'string'
      ? representative.options
      : registrations.length
        ? undefined
        : { targetName: 'lint' };
  updateJson(tree, 'nx.json', (value) => ({
    ...value,
    plugins: [
      ...(value.plugins ?? []),
      {
        plugin: ESLINT_PLUGIN,
        ...(options ? { options } : {}),
        include: roots.map((root) => `${root}/**/*`),
      },
    ],
  }));
  return covered;
}
