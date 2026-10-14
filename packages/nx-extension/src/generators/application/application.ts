import {
  addProjectConfiguration,
  formatFiles,
  getProjects,
  installPackagesTask,
  readJson,
  updateJson,
  writeJson,
  type GeneratorCallback,
  type ProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import type { ExtensionApplicationSchema } from './schema';
import { wxtCommand, wxtTargets } from '../../lib/wxt-targets';
import { join } from 'node:path';
import { satisfies } from 'semver';
import { isMap, isSeq, parseDocument } from 'yaml';
import {
  EXTENSION_TOOLCHAIN,
  extensionTypeScript,
  verifyExtensionToolchain,
} from '../../lib/toolchain';

const WXT_VERSION = EXTENSION_TOOLCHAIN.wxt;

function slug(value: string, label: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) throw new Error(`${label} must contain a letter or number.`);
  return normalized;
}

function tags(options: ExtensionApplicationSchema, scope: string): string[] {
  return [
    ...(options.tags
      ?.split(',')
      .map((tag) => tag.trim())
      .filter(Boolean) ?? []),
    'platform:extension',
    `scope:${scope}`,
    'type:app',
    'visibility:internal',
  ]
    .filter((tag, index, values) => values.indexOf(tag) === index)
    .sort();
}

function targets(
  version?: 2 | 3,
): NonNullable<ProjectConfiguration['targets']> {
  return wxtTargets({ chrome: version, firefox: version });
}

function ensureWorkspace(tree: Tree, directory: string): void {
  if (tree.exists('pnpm-workspace.yaml')) {
    const current = tree.read('pnpm-workspace.yaml', 'utf8') ?? 'packages:\n';
    const document = parseDocument(current);
    let packages = document.get('packages');
    if (
      (packages === null || packages === undefined) &&
      document.has('packages')
    ) {
      document.set('packages', document.createNode([]));
      packages = document.get('packages');
    }
    if (
      document.errors.length ||
      !isMap(document.contents) ||
      !isSeq(packages) ||
      packages.toJSON().some((value: unknown) => typeof value !== 'string')
    ) {
      throw new Error('pnpm-workspace.yaml must contain a packages list.');
    }
    const registered = packages.items.some(
      (item) => String(item) === directory || String(item) === 'apps/*',
    );
    if (!registered) {
      packages.add(directory);
      tree.write('pnpm-workspace.yaml', document.toString());
    }
    return;
  }
  updateJson(tree, 'package.json', (value: Record<string, unknown>) => {
    const workspaces = value.workspaces;
    if (workspaces !== undefined && !Array.isArray(workspaces)) {
      throw new Error('package.json workspaces must be an array.');
    }
    return {
      ...value,
      workspaces: [...new Set([...(workspaces ?? []), directory])].sort(),
    };
  });
}

function configuredProject(
  directory: string,
  projectName: string,
  projectTags: readonly string[],
  version?: 2 | 3,
): ProjectConfiguration {
  return {
    root: directory,
    sourceRoot: `${directory}/entrypoints`,
    projectType: 'application',
    tags: [...projectTags],
    targets: targets(version),
  };
}

export async function extensionApplicationGenerator(
  tree: Tree,
  raw: ExtensionApplicationSchema,
): Promise<GeneratorCallback> {
  const matches = raw.contentScriptMatches;
  if (
    matches !== undefined &&
    (!Array.isArray(matches) ||
      !matches.length ||
      matches.length > 50 ||
      matches.some(
        (pattern) =>
          typeof pattern !== 'string' ||
          pattern.length > 2048 ||
          (pattern !== '<all_urls>' &&
            !/^(?:https?|file|\*):\/\/[^\s]*\/[^\s]*$/.test(pattern)),
      ))
  )
    throw new Error(
      'contentScriptMatches requires 1–50 explicit browser match patterns.',
    );
  if (
    raw.manifestVersion !== undefined &&
    ![2, 3].includes(raw.manifestVersion)
  )
    throw new Error('manifestVersion must be 2 or 3.');
  if (!satisfies(process.versions.node, '>=22.12 <23 || >=24 <25')) {
    throw new Error(
      `The WXT ${WXT_VERSION}/Vite/Vitest scaffold requires Node 22.12+ (22.x) or 24.x; the active runtime is Node ${process.versions.node}. Existing WXT projects can still be inferred without upgrading the workspace.`,
    );
  }
  const name = slug(raw.name, 'Extension name');
  const rootManifest = readJson<{ name?: string }>(tree, 'package.json');
  const scope = slug(
    raw.scope ??
      rootManifest.name?.replace(/^@/, '').replaceAll('/', '-') ??
      'workspace',
    'Extension scope',
  );
  const directory =
    raw.directory?.replace(/^\.\//, '').replace(/\/$/, '') ?? `apps/${name}`;
  const projectName = raw.projectName
    ? slug(raw.projectName, 'Extension project name')
    : `${scope}-${name}`;
  const projectTags = tags(raw, scope);
  const projects = getProjects(tree);
  const existing = projects.get(projectName);
  if (existing) {
    if (
      raw.manifestVersion !== undefined &&
      existing.targets?.['build-firefox']?.options?.command !==
        wxtCommand('build', 'firefox', raw.manifestVersion)
    )
      throw new Error(
        'Existing extension manifest-version targets differ; review the application-owned configuration rather than regenerating it.',
      );
    const existingTags = new Set(existing.tags ?? []);
    if (
      existing.root === directory &&
      existing.projectType === 'application' &&
      projectTags.every((tag) => existingTags.has(tag))
    ) {
      return () => undefined;
    }
    throw new Error(
      `Project ${projectName} already exists with a different contract.`,
    );
  }
  if (tree.exists(directory))
    throw new Error(`Path ${directory} is already occupied.`);

  const typescript = extensionTypeScript(tree);
  ensureWorkspace(tree, directory);
  addProjectConfiguration(
    tree,
    projectName,
    configuredProject(directory, projectName, projectTags, raw.manifestVersion),
  );
  writeJson(tree, `${directory}/package.json`, {
    name: `@${scope}/${name}`,
    version: '0.0.0',
    private: true,
    type: 'module',
    ...(raw.manifestVersion
      ? {
          megamono: {
            extension: {
              manifestVersions: {
                chrome: raw.manifestVersion,
                firefox: raw.manifestVersion,
              },
            },
          },
        }
      : {}),
    scripts: {
      dev: 'wxt',
      build: 'wxt build',
      zip: 'wxt zip',
      prepare: 'wxt prepare',
      test: 'vitest run',
    },
    devDependencies: {
      typescript,
      ...EXTENSION_TOOLCHAIN,
    },
    nx: { name: projectName, projectType: 'application', tags: projectTags },
  });
  tree.write(
    `${directory}/wxt.config.ts`,
    `import { defineConfig } from 'wxt';\n\nexport default defineConfig({\n${raw.manifestVersion ? `  manifestVersion: ${raw.manifestVersion},\n` : ''}  manifest: {\n    name: ${JSON.stringify(raw.displayName?.trim() || name)},\n    description: 'Browser extension generated by Megamono',\n  },\n});\n`,
  );
  writeJson(tree, `${directory}/tsconfig.json`, {
    extends: './.wxt/tsconfig.json',
    compilerOptions: { strict: true },
  });
  tree.write(
    `${directory}/entrypoints/background.ts`,
    'export default defineBackground(() => {\n  // Compose background capabilities here.\n});\n',
  );
  if (matches)
    tree.write(
      `${directory}/entrypoints/content.ts`,
      `export default defineContentScript({\n  matches: ${JSON.stringify([...new Set(matches)])},\n  main() {\n    // Compose the explicitly selected page integrations here.\n  },\n});\n`,
    );
  tree.write(
    `${directory}/src/extension.ts`,
    "export const extensionBrowsers = ['chrome', 'firefox'] as const;\n",
  );
  tree.write(
    `${directory}/src/extension.spec.ts`,
    "import { describe, expect, it } from 'vitest';\nimport { extensionBrowsers } from './extension';\n\ndescribe('extension targets', () => {\n  it('keeps Chrome and Firefox explicit', () => {\n    expect(extensionBrowsers).toEqual(['chrome', 'firefox']);\n  });\n});\n",
  );
  tree.write(
    `${directory}/README.md`,
    `# ${raw.displayName?.trim() || name}\n\nWXT browser extension managed as ${projectName}. Chrome and Firefox are first-class targets. Safari requires a separate Apple wrapper project and signing workflow.\n\nPlaystack product capabilities are optional and should be added through the Playstack CLI when a compatible extension package is available.\n`,
  );
  if (!raw.skipFormat) await formatFiles(tree);
  return raw.skipInstall
    ? () => undefined
    : () => {
        // App-scoped dependencies may change without changing the root manifest.
        installPackagesTask(tree, true);
        verifyExtensionToolchain(join(tree.root, directory));
      };
}

export default extensionApplicationGenerator;
