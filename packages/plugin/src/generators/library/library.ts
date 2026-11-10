import {
  formatFiles,
  addDependenciesToPackageJson,
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { minVersion, satisfies, validRange } from 'semver';
import { megamonoConfigSchema } from '../../lib/config';
import {
  assertWorkspaceMutationGitPreflight,
  collectWorkspaceInitHostState,
  isHostedWorkspaceTree,
} from '../../lib/workspace-init-preflight';
import type { LibraryGeneratorSchema } from './schema';
import { preserveWorkspaceYaml } from '../../lib/preserve-workspace-yaml';
import { wireGeneratedReactLint } from '../../lib/generated-react-lint';
import { nxWorkspaceCapabilities } from '../../lib/workspace-compatibility';
import {
  canInferGeneratedLibrary,
  scopeGeneratedLibraryInference,
} from '../../lib/generated-library-inference';

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const compatibility = JSON.parse(
  readFileSync(join(__dirname, '../../../compatibility.json'), 'utf8'),
) as { scaffoldPackages: Record<string, string> };
type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function declared(manifest: Manifest, name: string): string | undefined {
  return (
    manifest.dependencies?.[name] ??
    manifest.devDependencies?.[name] ??
    manifest.peerDependencies?.[name]
  );
}

const testExcludes = ['src/**/*.spec.*', 'src/**/*.test.*'];
const CHAKRA_SINGLETONS = ['@chakra-ui/react', '@emotion/react'] as const;

/**
 * Chakra and Emotion versions the workspace already uses, from the root, any
 * project manifest or the recorded web styling. Empty outside Chakra workspaces.
 */
function workspaceChakraVersions(
  tree: Tree,
  rootManifest: Manifest,
  libraryRoot: string,
): Record<string, string> {
  const manifests = [rootManifest];
  for (const project of getProjects(tree).values())
    if (
      project.root !== libraryRoot &&
      tree.exists(`${project.root}/package.json`)
    )
      manifests.push(readJson<Manifest>(tree, `${project.root}/package.json`));
  const chakraStyling =
    (
      readJson(tree, 'megamono.json') as {
        scaffolding?: { web?: { styling?: string } };
      }
    ).scaffolding?.web?.styling === 'chakra';
  if (
    !chakraStyling &&
    !manifests.some((value) => declared(value, '@chakra-ui/react'))
  )
    return {};
  return Object.fromEntries(
    CHAKRA_SINGLETONS.map((name) => [
      name,
      manifests
        .map((value) => declared(value, name))
        .find((range) => range && validRange(range)) ??
        compatibility.scaffoldPackages[name],
    ]),
  );
}

function configureLibraryTypes(
  tree: Tree,
  root: string,
  platform: string,
  react: boolean,
  tests: boolean,
  publishable: boolean,
): void {
  updateJson(tree, `${root}/tsconfig.lib.json`, (config) => ({
    ...config,
    compilerOptions: {
      ...config.compilerOptions,
      ...(publishable
        ? { rootDir: 'src', noEmit: false, emitDeclarationOnly: false }
        : {}),
      ...(platform === 'web'
        ? {
            lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            moduleResolution: 'Bundler',
          }
        : {}),
      ...(platform === 'worker' ? { lib: ['ES2022', 'WebWorker'] } : {}),
      ...(react ? { jsx: 'react-jsx' } : {}),
    },
    include: [
      ...new Set([
        ...(config.include ?? ['src/**/*.ts']),
        ...(react ? ['src/**/*.tsx'] : []),
      ]),
    ],
    exclude: [...new Set([...(config.exclude ?? []), ...testExcludes])],
  }));
  if (tests)
    writeJson(tree, `${root}/tsconfig.spec.json`, {
      extends: './tsconfig.lib.json',
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        composite: false,
        declaration: false,
        emitDeclarationOnly: false,
        noEmit: true,
        rootDir: '.',
        types: ['node'],
      },
      include: [...testExcludes, 'vitest.config.ts'],
      exclude: [],
    });
}

const lockfiles = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];

/**
 * Compose consumer-local Nx without taking ownership of release workflows.
 * A comma-separated name adds several libraries with the same options in one
 * reviewed change; allowDirty permits unrelated uncommitted work but still
 * refuses when any file this run writes (or an install would rewrite) is dirty.
 */
export async function libraryGenerator(
  tree: Tree,
  options: LibraryGeneratorSchema,
): Promise<GeneratorCallback> {
  const names = (options.name ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0 || names.some((name) => !slug.test(name)))
    throw new Error(
      'Library name and scope must be lowercase kebab-case names.',
    );
  if (new Set(names).size !== names.length)
    throw new Error('Library names must be unique within one generation.');
  let dirtyPaths: readonly string[] = [];
  let checked = false;
  const beforeMutation = async () => {
    if (checked || !isHostedWorkspaceTree(tree)) return;
    checked = true;
    const state = await collectWorkspaceInitHostState(tree.root);
    assertWorkspaceMutationGitPreflight(state, 'Library addition', {
      allowDirty: options.allowDirty === true,
    });
    dirtyPaths = state.git.dirtyPaths ?? [];
  };
  const callbacks: GeneratorCallback[] = [];
  for (const name of names)
    callbacks.push(
      await generateLibrary(
        tree,
        { ...options, name },
        beforeMutation,
        names.length > 1,
      ),
    );
  if (!checked) return callbacks[0] ?? (() => undefined);
  if (dirtyPaths.length) {
    const written = new Set(tree.listChanges().map(({ path }) => path));
    const conflicts = dirtyPaths.filter(
      (path) =>
        written.has(path) || (!options.skipInstall && lockfiles.includes(path)),
    );
    if (conflicts.length)
      throw new Error(
        `Library addition would change files with uncommitted work: ${conflicts.join(', ')}. Commit or stash them first; nothing was written.`,
      );
  }
  if (names.length === 1) return callbacks[0];
  return options.skipInstall
    ? () => undefined
    : runTasksInSerial(() => installPackagesTask(tree, true));
}

async function generateLibrary(
  tree: Tree,
  options: LibraryGeneratorSchema,
  beforeMutation: () => Promise<void>,
  batched = false,
): Promise<GeneratorCallback> {
  if (!tree.exists('megamono.json'))
    throw new Error('Run megamono init before adding libraries.');
  megamonoConfigSchema.parse(readJson(tree, 'megamono.json'));
  const manifest = readJson<Manifest>(tree, 'package.json');
  const scope =
    options.scope ??
    /^@([^/]+)\/source$/.exec(manifest.name ?? '')?.[1] ??
    manifest.name?.replace(/^@/, '').replace(/\//g, '-') ??
    'workspace';
  const packageScope = options.packageScope?.replace(/^@/, '') ?? scope;
  if (
    !slug.test(options.name ?? '') ||
    !slug.test(scope) ||
    !slug.test(packageScope)
  )
    throw new Error(
      'Library name and scope must be lowercase kebab-case names.',
    );
  const platform = options.platform ?? 'neutral';
  const type = options.type ?? 'util';
  const testRunner = options.testRunner ?? 'vitest';
  if (!['vitest', 'none'].includes(testRunner))
    throw new Error('Unsupported library test runner.');
  if (
    testRunner === 'vitest' &&
    !satisfies(process.versions.node, '^20.19.0 || ^22.12.0 || >=24.0.0')
  )
    throw new Error(
      'Generated Vitest tests require Node 20.19+, 22.12+, or 24+. Activate a supported Node version or explicitly use --testRunner=none.',
    );
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
  const importPath = `@${packageScope}/${options.name}`;
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
    `# Megamono library plan\n\n- Project: ${name}\n- Root: ${root}\n- Package: ${importPath}\n- Tags: ${tags.join(', ')}\n- Tests: ${testRunner}${testRunner === 'vitest' ? ` (${compatibility.scaffoldPackages.vitest}, Node 20.19+/22.12+/24+)` : ''}\n- Publication: ${options.publishable ? (options.access ?? 'restricted') : 'private workspace library'}\n- Install: ${options.skipInstall ? 'deferred to the caller' : batched ? 'once, after every listed library' : 'after generation'}\n\nExisting release workflows are retained. Review release enrollment separately.\n`,
  );
  if (options.dryRun || options.planOnly || !options.yes)
    return () => undefined;
  await beforeMutation();
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
  const nx = readJson(tree, 'nx.json');
  const inference = canInferGeneratedLibrary(tree);
  const pluginsBefore = nx.plugins ?? [];
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
    skipInstall: options.skipInstall === true || batched,
    addPlugin: inference,
  });
  if (inference) scopeGeneratedLibraryInference(tree, root, pluginsBefore);
  const project = getProjects(tree).get(name);
  if (!project)
    throw new Error(`Nx did not create the expected library project ${name}.`);
  if (!tree.exists(`${root}/package.json`)) {
    writeJson(tree, `${root}/package.json`, {
      name: importPath,
      version: '0.0.1',
    });
  }
  const react = platform === 'web' && type === 'ui';
  configureLibraryTypes(
    tree,
    root,
    platform,
    react,
    testRunner === 'vitest',
    options.publishable === true,
  );
  const dependencyCallbacks: GeneratorCallback[] = [];
  if (react) {
    dependencyCallbacks.push(
      wireGeneratedReactLint(
        tree,
        root,
        compatibility.scaffoldPackages['eslint-plugin-react-hooks'],
      ),
    );
    const version =
      declared(manifest, 'react') ?? compatibility.scaffoldPackages.react;
    const typesVersion =
      declared(manifest, '@types/react') ??
      `^${minVersion(validRange(version) ?? '19')?.major ?? 19}.0.0`;
    // A UI library in a Chakra workspace renders under the application's
    // ChakraProvider; its own Chakra/Emotion copy would split the React context.
    const styling = workspaceChakraVersions(tree, manifest, root);
    updateJson(tree, `${root}/package.json`, (value) => ({
      ...value,
      peerDependencies: {
        ...value.peerDependencies,
        react: validRange(version) ? version : '>=18 <20',
        ...styling,
      },
      devDependencies: {
        ...value.devDependencies,
        react: version,
        '@types/react': typesVersion,
        ...styling,
      },
    }));
  }
  if (testRunner === 'vitest') {
    const version =
      declared(manifest, 'vitest') ?? compatibility.scaffoldPackages.vitest;
    updateJson(tree, `${root}/package.json`, (value) => ({
      ...value,
      devDependencies: { ...value.devDependencies, vitest: version },
    }));
    dependencyCallbacks.push(
      addDependenciesToPackageJson(
        tree,
        {},
        declared(manifest, 'vitest') ? {} : { vitest: version },
      ),
    );
    project.targets = {
      ...project.targets,
      test: {
        executor: 'nx:run-commands',
        cache: true,
        options: { command: 'vitest run --config vitest.config.ts', cwd: root },
      },
    };
    tree.write(
      `${root}/vitest.config.ts`,
      `import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({ test: { environment: 'node', include: ['src/**/*.{spec,test}.{ts,tsx}'] } });\n`,
    );
    const source = tree.read(`${root}/src/index.ts`, 'utf8') ?? '';
    const exported = /export \* from ['"](.+)['"]/.exec(source)?.[1];
    const implementation =
      exported &&
      tree.read(
        `${root}/src/${exported.replace(/^\.\//, '').replace(/\.js$/, '')}.ts`,
        'utf8',
      );
    const helper =
      implementation && /export function (\w+)\(/.exec(implementation)?.[1];
    if (helper)
      tree.write(
        `${root}/src/index.spec.ts`,
        `import { describe, expect, it } from 'vitest';\nimport { ${helper} } from './index';\n\ndescribe('${importPath}', () => {\n  it('returns its library identifier', () => { expect(${helper}()).toBe(${JSON.stringify(name)}); });\n});\n`,
      );
    else
      throw new Error(
        'The installed Nx library template has no supported starter export; review test scaffolding before generation.',
      );
  }
  if (
    !inference &&
    project.targets?.lint?.executor === '@nx/eslint:lint' &&
    nxWorkspaceCapabilities(tree).major >= 18
  )
    project.targets.lint = {
      executor: 'nx:run-commands',
      cache: true,
      options: { command: 'eslint .', cwd: root },
    };
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
  if (
    options.publishable &&
    project.targets?.build?.executor === '@nx/js:tsc'
  ) {
    project.targets.build.options = {
      ...project.targets.build.options,
      rootDir: `${root}/src`,
    };
  }
  const output = project.targets?.build?.options?.outputPath as
    string | undefined;
  const publishFromSourceRoot = !output || output === `${root}/dist`;
  const entryRoot = publishFromSourceRoot ? './dist' : '.';
  updateJson(tree, `${root}/package.json`, (value) => ({
    ...value,
    private: !options.publishable,
    ...(options.publishable
      ? {
          main: `${entryRoot}/index.js`,
          types: `${entryRoot}/index.d.ts`,
          ...(typeof value.module === 'string'
            ? { module: `${entryRoot}/index.js` }
            : {}),
          exports: {
            './package.json': './package.json',
            '.': {
              types: `${entryRoot}/index.d.ts`,
              ...(value.type === 'module'
                ? { import: `${entryRoot}/index.js` }
                : {}),
              default: `${entryRoot}/index.js`,
            },
          },
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
    `# ${importPath}\n\n${options.publishable ? `Publishable TypeScript library (${options.access ?? 'restricted'} access). Build ${name}:build before publishing from \`${publishFromSourceRoot ? root : output}\`. Inspect the packed archive and enroll this project in your reviewed release configuration; no root release workflow was changed.` : 'Internal, private TypeScript library. Consume through workspace imports; do not publish.'}\n\nPlatform: ${platform}. ${platform === 'neutral' ? 'Keep platform-specific APIs out of this library.' : 'This tag governs dependencies; it does not install or configure a runtime.'}\n\n${testRunner === 'vitest' ? `Run ${name}:test for the Node-hosted Vitest starter (Node 20.19+/22.12+/24+). Production typechecking excludes specs; use tsconfig.spec.json when checking test types. Add application-specific and browser/DOM tests before adoption.` : 'Tests were explicitly omitted with testRunner=none. Add application-specific tests before adoption.'} Native/mobile device qualification remains a consumer responsibility.\n`,
  );
  await formatFiles(tree);
  restoreWorkspaceYaml();
  return options.skipInstall || batched
    ? () => undefined
    : runTasksInSerial(
        () => installPackagesTask(tree, true),
        callback,
        ...dependencyCallbacks,
      );
}

export default libraryGenerator;
