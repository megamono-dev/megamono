import {
  formatFiles,
  getProjects,
  logger,
  readJson,
  updateJson,
  visitNotIgnoredFiles,
  type Tree,
} from '@nx/devkit';
import type { LibraryEntrypointGeneratorSchema } from './schema';

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
type ExportTarget = string | { readonly [condition: string]: ExportTarget };
interface Manifest {
  readonly name?: string;
  readonly exports?: Record<string, ExportTarget> | string;
  readonly sideEffects?: unknown;
}

/** Map every leaf of the root export onto the same layout under `<name>/`. */
function subpathTarget(target: ExportTarget, name: string): ExportTarget {
  if (typeof target === 'string') {
    const match = /^(.*\/)index(\.(?:d\.)?[cm]?[jt]sx?)$/.exec(target);
    if (!match)
      throw new Error(
        `The root export target ${target} is not an index file; add the subpath export by hand.`,
      );
    return `${match[1]}${name}/index${match[2]}`;
  }
  return Object.fromEntries(
    Object.entries(target).map(([condition, value]) => [
      condition,
      subpathTarget(value, name),
    ]),
  );
}

/** Production source files with an import evaluated only for its side effects. */
export function sideEffectImports(tree: Tree, root: string): readonly string[] {
  const found: string[] = [];
  visitNotIgnoredFiles(tree, `${root}/src`, (path) => {
    if (
      !/\.[cm]?[jt]sx?$/.test(path) ||
      /\.d\.[cm]?ts$/.test(path) ||
      /(?:^|\/)__tests__\/|\.(?:spec|test|stories|story)\.[cm]?[jt]sx?$/.test(
        path,
      )
    )
      return;
    const source = tree.read(path, 'utf8') ?? '';
    for (const match of source.matchAll(/^\s*import\s*(['"])([^'"]+)\1\s*;?/gm))
      found.push(`${path} imports ${match[2]}`);
    for (const match of source.matchAll(
      /^\s*require\(\s*(['"])([^'"]+)\1\s*\)\s*;?\s*$/gm,
    ))
      found.push(`${path} requires ${match[2]}`);
  });
  return found;
}

export async function libraryEntrypointGenerator(
  tree: Tree,
  options: LibraryEntrypointGeneratorSchema,
): Promise<void> {
  const project = getProjects(tree).get(options.project);
  if (!project || project.projectType === 'application')
    throw new Error(`${options.project} is not a library project.`);
  const manifestPath = `${project.root}/package.json`;
  if (!tree.exists(manifestPath))
    throw new Error(
      `${options.project} has no package.json at ${manifestPath}.`,
    );
  if (options.name === undefined && options.sideEffects === undefined)
    throw new Error(
      'Pass --name to add a subpath export, --sideEffects=false, or both.',
    );
  if (options.sideEffects === true)
    throw new Error(
      'Only --sideEffects=false is managed here; remove or edit an existing declaration by hand.',
    );
  const manifest = readJson<Manifest>(tree, manifestPath);
  const plan: string[] = [];
  let exportsMap: Record<string, ExportTarget> | undefined;
  if (options.name !== undefined) {
    if (!slug.test(options.name))
      throw new Error('The subpath name must be lowercase kebab-case.');
    if (options.name === 'index' || options.name === 'package.json')
      throw new Error(`${options.name} is reserved.`);
    const current =
      typeof manifest.exports === 'string'
        ? { '.': manifest.exports }
        : manifest.exports;
    const rootExport = current?.['.'];
    if (!rootExport)
      throw new Error(
        `${manifestPath} has no "." export to derive the subpath layout from.`,
      );
    if (current[`./${options.name}`])
      throw new Error(`${manifestPath} already exports ./${options.name}.`);
    const sourceIndex = `${project.root}/src/${options.name}/index.ts`;
    if (
      tree.exists(`${project.root}/src/${options.name}.ts`) ||
      tree.exists(`${project.root}/src/${options.name}.tsx`)
    )
      throw new Error(
        `src/${options.name}.ts exists; move it to src/${options.name}/index.ts before exporting it as a subpath.`,
      );
    const target = subpathTarget(rootExport, options.name);
    exportsMap = {};
    for (const [key, value] of Object.entries(current)) {
      exportsMap[key] = value;
      if (key === '.') exportsMap[`./${options.name}`] = target;
    }
    plan.push(`- Export ./${options.name}: ${JSON.stringify(target)}`);
    if (!tree.exists(sourceIndex)) {
      plan.push(`- Create ${sourceIndex}`);
      if (!options.dryRun)
        tree.write(
          sourceIndex,
          `// Public entry point for ${manifest.name ?? options.project}/${options.name}.\n// Export only what this subpath's consumers need; it must not import the root index.\nexport {};\n`,
        );
    }
  }
  if (options.sideEffects === false) {
    const found = sideEffectImports(tree, project.root);
    if (found.length)
      throw new Error(
        `${options.project} has side-effect-only imports that bundlers would drop under "sideEffects": false:\n${found.map((entry) => `  - ${entry}`).join('\n')}\nList the files that need them in an explicit sideEffects array instead.`,
      );
    plan.push(
      '- Declare "sideEffects": false (no side-effect-only imports found in src)',
    );
  }
  logger.info(
    `# Megamono library entry point plan\n\n- Project: ${options.project}\n${plan.join('\n')}\n`,
  );
  if (options.dryRun) return;
  updateJson(tree, manifestPath, (value) => ({
    ...value,
    ...(exportsMap ? { exports: exportsMap } : {}),
    ...(options.sideEffects === false ? { sideEffects: false } : {}),
  }));
  await formatFiles(tree);
}

export default libraryEntrypointGenerator;
