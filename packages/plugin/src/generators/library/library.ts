import {
  formatFiles,
  getProjects,
  installPackagesTask,
  logger,
  readJson,
  runTasksInSerial,
  updateJson,
  updateProjectConfiguration,
  workspaceRoot,
  writeJson,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { megamonoConfigSchema } from '../../lib/config';
import {
  assertWorkspaceMutationGitPreflight,
  collectWorkspaceInitHostState,
} from '../../lib/workspace-init-preflight';
import type { LibraryGeneratorSchema } from './schema';
import { preserveWorkspaceYaml } from '../../lib/preserve-workspace-yaml';

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Compose consumer-local Nx without taking ownership of release workflows. */
export async function libraryGenerator(
  tree: Tree,
  options: LibraryGeneratorSchema,
): Promise<GeneratorCallback> {
  if (!tree.exists('megamono.json'))
    throw new Error('Run megamono init before adding libraries.');
  megamonoConfigSchema.parse(readJson(tree, 'megamono.json'));
  const manifest = readJson<{ name?: string }>(tree, 'package.json');
  const scope =
    options.scope ??
    manifest.name?.replace(/^@/, '').replace(/\//g, '-') ??
    'workspace';
  if (!slug.test(options.name ?? '') || !slug.test(scope))
    throw new Error(
      'Library name and scope must be lowercase kebab-case names.',
    );
  const platform = options.platform ?? 'neutral';
  const type = options.type ?? 'util';
  if (!['neutral', 'web', 'node', 'mobile', 'worker'].includes(platform))
    throw new Error('Unsupported TypeScript library platform.');
  if (!['util', 'ui', 'data', 'feature'].includes(type))
    throw new Error('Unsupported library type tag.');
  if (
    options.access &&
    (!options.publishable || !['restricted', 'public'].includes(options.access))
  )
    throw new Error(
      'Registry access requires a publishable library and must be restricted or public.',
    );
  const root = `${options.publishable ? 'packages' : 'libs'}/${options.name}`;
  const name = `${scope}-${options.name}`;
  const importPath = `@${scope}/${options.name}`;
  const projects = getProjects(tree);
  if (
    tree.children(root).length ||
    projects.has(name) ||
    [...projects.values()].some(
      (project) =>
        project.root === root ||
        (tree.exists(`${project.root}/package.json`) &&
          readJson(tree, `${project.root}/package.json`).name === importPath),
    )
  ) {
    throw new Error(
      `Library ${name} or ${root} already exists; relocation and publication changes require a separate reviewed migration.`,
    );
  }
  const tags = [
    `scope:${scope}`,
    `type:${type}`,
    ...(platform === 'neutral' ? [] : [`platform:${platform}`]),
  ];
  logger.info(
    `# Megamono library plan\n\n- Project: ${name}\n- Root: ${root}\n- Package: ${importPath}\n- Tags: ${tags.join(', ')}\n- Publication: ${options.publishable ? (options.access ?? 'restricted') : 'private workspace library'}\n- Install: ${options.skipInstall ? 'deferred to the caller' : 'after generation'}\n\nExisting release workflows are retained. Review release enrollment separately.\n`,
  );
  if (options.dryRun || options.planOnly || !options.yes)
    return () => undefined;
  if (tree.root !== '/virtual')
    assertWorkspaceMutationGitPreflight(
      await collectWorkspaceInitHostState(tree.root),
      'Library addition',
    );
  let generate: (
    tree: Tree,
    options: Record<string, unknown>,
  ) => Promise<GeneratorCallback>;
  try {
    generate = createRequire(join(workspaceRoot, 'package.json'))(
      '@nx/js',
    ).libraryGenerator;
    if (typeof generate !== 'function') throw new Error('Missing export');
  } catch {
    throw new Error(
      'Install a compatible @nx/js in this workspace before adding libraries.',
    );
  }
  // Buildable is not the same as enrolled in Nx release. publishable:false
  // avoids Nx's automatic root release/registry setup; apply intent below.
  const restoreWorkspaceYaml = preserveWorkspaceYaml(tree);
  const callback = await generate(tree, {
    name,
    directory: root,
    importPath,
    tags: tags.join(','),
    bundler: options.publishable ? 'tsc' : 'none',
    publishable: false,
    linter: 'eslint',
    unitTestRunner: 'none',
    minimal: true,
    useProjectJson: true,
    skipFormat: true,
  });
  const project = getProjects(tree).get(name);
  if (!project)
    throw new Error(`Nx did not create the expected library project ${name}.`);
  // TS solution libraries normally infer this target. An existing workspace
  // can disable inference, so guarantee the build promised by this generator.
  if (options.publishable && !project.targets?.build) {
    project.targets = {
      ...project.targets,
      build: {
        executor: '@nx/js:tsc',
        cache: true,
        outputs: ['{options.outputPath}'],
        options: {
          main: `${root}/src/index.ts`,
          tsConfig: `${root}/tsconfig.lib.json`,
          rootDir: `${root}/src`,
          outputPath: `${root}/dist`,
          generatePackageJson: false,
        },
      },
    };
  }
  const output = project.targets?.build?.options?.outputPath as
    string | undefined;
  const publishFromSourceRoot = !output || output === `${root}/dist`;
  if (!tree.exists(`${root}/package.json`)) {
    writeJson(tree, `${root}/package.json`, {
      name: importPath,
      version: '0.0.1',
    });
  }
  updateJson(tree, `${root}/package.json`, (value) => ({
    ...value,
    private: !options.publishable,
    ...(options.publishable
      ? {
          publishConfig: {
            ...value.publishConfig,
            access: options.access ?? 'restricted',
          },
          ...(publishFromSourceRoot
            ? { files: ['dist', '!**/*.tsbuildinfo'] }
            : {}),
        }
      : {
          exports: {
            '.': { types: './src/index.ts', default: './src/index.ts' },
          },
        }),
  }));
  updateProjectConfiguration(tree, name, { ...project, tags });
  tree.write(
    `${root}/README.md`,
    `# ${importPath}\n\n${options.publishable ? `Publishable TypeScript library (${options.access ?? 'restricted'} access). Build ${name}:build before publishing from \`${publishFromSourceRoot ? root : output}\`. Inspect the packed archive and enroll this project in your reviewed release configuration; no root release workflow was changed.` : 'Internal, private TypeScript library. Consume through workspace imports; do not publish.'}\n\nPlatform: ${platform}. ${platform === 'neutral' ? 'Keep platform-specific APIs out of this library.' : 'This tag governs dependencies; it does not install or configure a runtime.'}\n\nAdd application-specific tests before adoption. Native/mobile device qualification remains a consumer responsibility.\n`,
  );
  await formatFiles(tree);
  restoreWorkspaceYaml();
  return options.skipInstall
    ? () => undefined
    : runTasksInSerial(() => installPackagesTask(tree, true), callback);
}

export default libraryGenerator;
