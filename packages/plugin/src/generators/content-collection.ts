import {
  addProjectConfiguration,
  getProjects,
  updateJson,
  type ProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import { posix } from 'node:path';
import { isSafeWorkspaceRelativePath } from '../lib/config';
import { compatiblePlaystackPackageVersion } from '../lib/emissions';
import { normalizeSlug, readDocsGeneratorConfig } from './docs-record';

const contentCollectionVersion = 1;
const contentCollectionsVersion = '0.15.2';
const playstackContentVersion = compatiblePlaystackPackageVersion(
  'content-lib',
  '@playstack/content',
);

export interface ContentCollectionMarker {
  readonly version: number;
  readonly name: string;
  readonly types: readonly string[];
}

interface ContentPackageManifest {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly devDependencies?: Readonly<Record<string, unknown>>;
  readonly optionalDependencies?: Readonly<Record<string, unknown>>;
  readonly megamono?: {
    readonly contentCollection?: ContentCollectionMarker;
  };
}

function playstackContentDependencyVersion(
  tree: Tree,
  targetRoot: string,
): string {
  const manifest = readJsonValue<ContentPackageManifest>(tree, 'package.json');
  const current = [
    manifest.dependencies?.['@playstack/content'],
    manifest.devDependencies?.['@playstack/content'],
    manifest.optionalDependencies?.['@playstack/content'],
  ].find((value): value is string => typeof value === 'string');
  if (!current || !/^(?:file:|link:|workspace:)/.test(current)) {
    return playstackContentVersion;
  }
  if (current.startsWith('workspace:')) return current;
  const separator = current.indexOf(':') + 1;
  const protocol = current.slice(0, separator);
  const address = current.slice(separator);
  if (posix.isAbsolute(address)) return current;
  const relative = posix.relative(targetRoot, address);
  return `${protocol}${relative.startsWith('.') ? relative : `./${relative}`}`;
}

export interface ContentCollection {
  readonly name: string;
  readonly packageName: string;
  readonly projectName: string;
  readonly root: string;
  readonly marker: ContentCollectionMarker;
}

function readJsonValue<T>(tree: Tree, path: string): T {
  try {
    return JSON.parse(tree.read(path, 'utf8') ?? '') as T;
  } catch (error) {
    throw new Error(`${path} is not valid JSON.`, { cause: error });
  }
}

function workspacePackageScope(tree: Tree): string {
  if (!tree.exists('package.json')) {
    throw new Error('package.json is missing.');
  }
  const manifest = readJsonValue<{ readonly name?: string }>(
    tree,
    'package.json',
  );
  const scoped = manifest.name?.match(/^@([^/]+)\//)?.[1];
  if (scoped) return scoped;
  return normalizeSlug(manifest.name ?? 'workspace', 'workspace package name');
}

function appendIgnoreEntry(tree: Tree, path: string, entry: string): void {
  let source = tree.read(path, 'utf8') ?? '';
  if (new Set(source.split(/\r?\n/)).has(entry)) return;
  if (source.length > 0 && !source.endsWith('\n')) source += '\n';
  tree.write(path, `${source}${entry}\n`);
}

function contentVariable(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, character: string) =>
    character.toUpperCase(),
  );
}

function renderContentConfig(types: readonly string[]): string {
  const schemaImports = types.map(
    (name) =>
      `import { ${contentVariable(name)}Schema } from './schemas/${name}.js';`,
  );
  const collections = types.map((name) => {
    const variable = contentVariable(name);
    return `const ${variable} = defineCollection({
  name: ${JSON.stringify(name)},
  directory: ${JSON.stringify(`content/${name}`)},
  include: '**/*.md',
  schema: ${variable}Schema,
  transform: (document) => ({
    ...document,
    slug: playstackContentTransforms.slugify(
      document.slug ?? document._meta.path,
    ),
    date: playstackContentTransforms.normalizeDate(document.date),
    readingTime: playstackContentTransforms.readingTime(document.content),
    toc: playstackContentTransforms.extractToc(document.content),
  }),
});`;
  });
  const variables = types.map(contentVariable).join(', ');
  return `import { defineCollection, defineConfig } from '@content-collections/core';
import {
  extractToc,
  normalizeDate,
  readingTime,
  slugify,
} from '@playstack/content';
${schemaImports.length > 0 ? `${schemaImports.join('\n')}\n` : ''}
export const playstackContentTransforms = Object.freeze({
  extractToc,
  normalizeDate,
  readingTime,
  slugify,
});
${collections.length > 0 ? `\n${collections.join('\n\n')}\n` : ''}
export default defineConfig({ content: [${variables}] });
`;
}

function renderContentSchema(name: string): string {
  const variable = contentVariable(name);
  return `import { contentBase } from '@playstack/content/schema';
import { z } from 'zod';

export const ${variable}Schema = z.object({
  ...contentBase,
  content: z.string(),
});
`;
}

function renderBuildScript(name: string): string {
  return `import { createBuilder } from '@content-collections/core';
import { fileURLToPath } from 'node:url';

const configurationPath = fileURLToPath(
  new URL('./content-collections.ts', import.meta.url),
);
const outputDir = fileURLToPath(
  new URL('./.content-collections', import.meta.url),
);
const builder = await createBuilder(configurationPath, {
  configName: ${JSON.stringify(`content-${name}`)},
  outputDir,
});
const errors = [];
builder.on('_error', ({ error }) => errors.push(error));
await builder.build();
if (errors.length > 0) {
  throw new AggregateError(
    errors,
    \`Content collection build failed with \${errors.length} error(s).\`,
  );
}
`;
}

function expectedProject(collection: ContentCollection): ProjectConfiguration {
  return {
    root: collection.root,
    sourceRoot: `${collection.root}/content`,
    projectType: 'library',
    tags: ['scope:shared', 'type:data'],
    targets: {
      build: {
        executor: 'nx:run-commands',
        cache: true,
        inputs: [
          '{projectRoot}/content-collections.ts',
          '{projectRoot}/schemas/**/*.ts',
          '{projectRoot}/content/**/*',
        ],
        outputs: ['{projectRoot}/.content-collections'],
        options: {
          command: 'node build-content.mjs',
          cwd: collection.root,
        },
      },
    },
  };
}

function markerFromManifest(
  manifest: ContentPackageManifest,
  path: string,
): ContentCollectionMarker | undefined {
  const marker = manifest.megamono?.contentCollection;
  if (!marker) return undefined;
  if (
    marker.version !== contentCollectionVersion ||
    typeof marker.name !== 'string' ||
    !Array.isArray(marker.types) ||
    marker.types.some(
      (name) =>
        typeof name !== 'string' ||
        normalizeSlug(name, 'content type marker') !== name,
    ) ||
    normalizeSlug(marker.name, 'content collection marker') !== marker.name ||
    new Set(marker.types).size !== marker.types.length ||
    JSON.stringify([...marker.types].sort()) !== JSON.stringify(marker.types)
  ) {
    throw new Error(`${path} has an unsupported Megamono content marker.`);
  }
  return marker;
}

export function createContentCollection(
  tree: Tree,
  rawName: string,
): ContentCollection {
  readDocsGeneratorConfig(tree);
  const name = normalizeSlug(rawName, 'content library name');
  const root = `packages/${name}`;
  const packageName = `@${workspacePackageScope(tree)}/${name}`;
  const projectName = packageName;
  const collection: ContentCollection = {
    name,
    packageName,
    projectName,
    root,
    marker: { version: contentCollectionVersion, name, types: [] },
  };
  if (!isSafeWorkspaceRelativePath(root)) {
    throw new Error(`Generated content library root ${root} is unsafe.`);
  }

  const projects = getProjects(tree);
  const existingProject = projects.get(projectName);
  const manifestPath = `${root}/package.json`;
  if (existingProject || tree.children(root).length > 0) {
    if (!existingProject || !tree.exists(manifestPath)) {
      throw new Error(
        `Content library destination ${root} already exists without a complete ${projectName} project.`,
      );
    }
    const manifest = readJsonValue<ContentPackageManifest>(tree, manifestPath);
    const marker = markerFromManifest(manifest, manifestPath);
    if (!marker || marker.name !== name || manifest.name !== packageName) {
      throw new Error(
        `Content library destination ${root} is owned by another project.`,
      );
    }
    const current: ContentCollection = { ...collection, marker };
    const projectContract = expectedProject(current);
    if (
      existingProject.root !== projectContract.root ||
      existingProject.sourceRoot !== projectContract.sourceRoot ||
      existingProject.projectType !== projectContract.projectType ||
      JSON.stringify([...(existingProject.tags ?? [])].sort()) !==
        JSON.stringify([...(projectContract.tags ?? [])].sort()) ||
      JSON.stringify(existingProject.targets?.build) !==
        JSON.stringify(projectContract.targets?.build)
    ) {
      throw new Error(
        `Content library ${projectName} project configuration differs from its generated contract.`,
      );
    }
    const required = [
      `${root}/build-content.mjs`,
      `${root}/content-collections.ts`,
    ];
    const missing = required.filter((path) => !tree.exists(path));
    if (missing.length > 0) {
      throw new Error(
        `Content library ${projectName} is incomplete; missing ${missing.join(', ')}.`,
      );
    }
    const expectedConfig = renderContentConfig(marker.types);
    if (
      tree.read(`${root}/content-collections.ts`, 'utf8') !== expectedConfig
    ) {
      throw new Error(
        `Content library ${projectName} configuration differs from its Megamono marker; reconcile it before rerunning content-lib.`,
      );
    }
    return current;
  }

  if (!tree.exists('tsconfig.base.json')) {
    throw new Error('tsconfig.base.json is missing.');
  }
  const tsconfig = readJsonValue<{
    readonly compilerOptions?: {
      readonly paths?: Readonly<Record<string, readonly string[]>>;
    };
  }>(tree, 'tsconfig.base.json');
  const mapping = [`./${root}/.content-collections/index.js`];
  const existingMapping = tsconfig.compilerOptions?.paths?.[packageName];
  if (
    existingMapping &&
    JSON.stringify(existingMapping) !== JSON.stringify(mapping)
  ) {
    throw new Error(
      `tsconfig.base.json already defines ${packageName}; choose another content library name.`,
    );
  }

  addProjectConfiguration(tree, projectName, expectedProject(collection));
  tree.write(
    manifestPath,
    `${JSON.stringify(
      {
        name: packageName,
        version: '0.0.1',
        private: true,
        type: 'module',
        exports: {
          '.': {
            types: './.content-collections/index.d.ts',
            import: './.content-collections/index.js',
            default: './.content-collections/index.js',
          },
        },
        dependencies: {
          '@playstack/content': playstackContentDependencyVersion(tree, root),
        },
        devDependencies: {
          '@content-collections/core': contentCollectionsVersion,
          zod: '^4.1.12',
        },
        megamono: { contentCollection: collection.marker },
      },
      null,
      2,
    )}\n`,
  );
  tree.write(`${root}/content-collections.ts`, renderContentConfig([]));
  tree.write(`${root}/build-content.mjs`, renderBuildScript(name));
  tree.write(`${root}/content/.gitkeep`, '');
  tree.write(`${root}/schemas/.gitkeep`, '');
  appendIgnoreEntry(tree, '.gitignore', `${root}/.content-collections/`);
  appendIgnoreEntry(tree, '.prettierignore', `${root}/.content-collections/`);
  updateJson(tree, 'tsconfig.base.json', (value) => {
    const compilerOptions = value.compilerOptions ?? {};
    const paths = compilerOptions.paths ?? {};
    return {
      ...value,
      compilerOptions: {
        ...compilerOptions,
        paths: { ...paths, [packageName]: mapping },
      },
    };
  });
  return collection;
}

export function findContentCollection(
  tree: Tree,
  rawCollection: string,
): ContentCollection {
  readDocsGeneratorConfig(tree);
  const requested = normalizeSlug(rawCollection, 'content collection');
  const matches: ContentCollection[] = [];
  for (const [projectName, project] of getProjects(tree)) {
    const manifestPath = posix.join(project.root, 'package.json');
    if (!tree.exists(manifestPath)) continue;
    const manifest = readJsonValue<ContentPackageManifest>(tree, manifestPath);
    const marker = markerFromManifest(manifest, manifestPath);
    if (!marker || !manifest.name) continue;
    if (
      projectName === rawCollection ||
      marker.name === requested ||
      manifest.name === rawCollection
    ) {
      matches.push({
        name: marker.name,
        packageName: manifest.name,
        projectName,
        root: project.root,
        marker,
      });
    }
  }
  if (matches.length === 0) {
    throw new Error(
      `Content collection ${rawCollection} was not found. Run content-lib first.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Content collection ${rawCollection} is ambiguous: ${matches
        .map(({ projectName }) => projectName)
        .sort()
        .join(', ')}. Use its exact Nx project or package name.`,
    );
  }
  return matches[0];
}

export function addContentType(
  tree: Tree,
  collection: ContentCollection,
  rawName: string,
): void {
  const name = normalizeSlug(rawName, 'content type name');
  const currentTypes = [...collection.marker.types].sort();
  const configPath = `${collection.root}/content-collections.ts`;
  if (tree.read(configPath, 'utf8') !== renderContentConfig(currentTypes)) {
    throw new Error(
      `Content collection ${collection.projectName} configuration differs from its Megamono marker; reconcile it before adding a type.`,
    );
  }
  if (currentTypes.includes(name)) {
    const required = [
      `${collection.root}/content/${name}`,
      `${collection.root}/schemas/${name}.ts`,
    ];
    const missing = required.filter((path) => !tree.exists(path));
    if (missing.length > 0) {
      throw new Error(
        `Content type ${name} is incomplete; missing ${missing.join(', ')}.`,
      );
    }
    return;
  }

  const schemaPath = `${collection.root}/schemas/${name}.ts`;
  const contentRoot = `${collection.root}/content/${name}`;
  if (tree.exists(schemaPath) || tree.exists(contentRoot)) {
    throw new Error(
      `Content type destination ${contentRoot} or schema ${schemaPath} already exists.`,
    );
  }
  const types = [...currentTypes, name].sort();
  tree.write(schemaPath, renderContentSchema(name));
  tree.write(`${contentRoot}/.gitkeep`, '');
  tree.write(configPath, renderContentConfig(types));
  updateJson(tree, `${collection.root}/package.json`, (value) => ({
    ...value,
    megamono: {
      ...value.megamono,
      contentCollection: {
        version: contentCollectionVersion,
        name: collection.name,
        types,
      },
    },
  }));
}
