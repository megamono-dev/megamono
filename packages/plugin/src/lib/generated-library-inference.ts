import { readJson, updateJson, type Tree } from '@nx/devkit';
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
