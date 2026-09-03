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

const WXT_VERSION = '0.21.4';

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

function targets(): NonNullable<ProjectConfiguration['targets']> {
  const run = (command: string, cache = true) => ({
    executor: 'nx:run-commands',
    cache,
    options: { command, cwd: '{projectRoot}' },
  });
  return {
    prepare: run('wxt prepare'),
    'dev-chrome': { ...run('wxt --browser chrome', false), continuous: true },
    'dev-firefox': {
      ...run('wxt --browser firefox', false),
      continuous: true,
    },
    'build-chrome': {
      ...run('wxt build --browser chrome'),
      outputs: ['{projectRoot}/.output/chrome-mv3'],
    },
    'build-firefox': {
      ...run('wxt build --browser firefox'),
      outputs: ['{projectRoot}/.output/firefox-mv2'],
    },
    build: {
      executor: 'nx:noop',
      cache: true,
      dependsOn: ['build-chrome', 'build-firefox'],
      outputs: ['{projectRoot}/.output'],
    },
    'package-chrome': {
      ...run('wxt zip --browser chrome'),
      dependsOn: ['build-chrome'],
      outputs: ['{projectRoot}/.output/*-chrome.zip'],
    },
    'package-firefox': {
      ...run('wxt zip --browser firefox'),
      dependsOn: ['build-firefox'],
      outputs: ['{projectRoot}/.output/*-firefox.zip'],
    },
    'package-firefox-source': {
      ...run('wxt zip --browser firefox --sources'),
      outputs: ['{projectRoot}/.output/*-sources.zip'],
    },
    package: {
      executor: 'nx:noop',
      cache: true,
      dependsOn: [
        'package-chrome',
        'package-firefox',
        'package-firefox-source',
      ],
      outputs: ['{projectRoot}/.output/*.zip'],
    },
    test: run('vitest run'),
    lint: run(
      "eslint . --ignore-pattern '.wxt/**' --ignore-pattern '.output/**'",
    ),
  };
}

function ensureWorkspace(tree: Tree, directory: string): void {
  if (tree.exists('pnpm-workspace.yaml')) {
    const current = tree.read('pnpm-workspace.yaml', 'utf8') ?? 'packages:\n';
    if (!/^packages:\s*$/m.test(current)) {
      throw new Error('pnpm-workspace.yaml must contain a packages list.');
    }
    const registered = [
      ...current.matchAll(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/gm),
    ].some((match) => match[1] === directory || match[1] === 'apps/*');
    if (!registered) {
      tree.write(
        'pnpm-workspace.yaml',
        `${current.replace(/\s*$/, '')}\n  - '${directory}'\n`,
      );
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
): ProjectConfiguration {
  return {
    root: directory,
    sourceRoot: `${directory}/entrypoints`,
    projectType: 'application',
    tags: [...projectTags],
    targets: targets(),
  };
}

export async function extensionApplicationGenerator(
  tree: Tree,
  raw: ExtensionApplicationSchema,
): Promise<GeneratorCallback> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) {
    throw new Error(
      `WXT ${WXT_VERSION} application generation requires Node 22 or newer; the active runtime is Node ${process.versions.node}. Existing WXT projects can still be inferred without upgrading the workspace.`,
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

  ensureWorkspace(tree, directory);
  addProjectConfiguration(
    tree,
    projectName,
    configuredProject(directory, projectName, projectTags),
  );
  writeJson(tree, `${directory}/package.json`, {
    name: `@${scope}/${name}`,
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: {
      dev: 'wxt',
      build: 'wxt build',
      zip: 'wxt zip',
      prepare: 'wxt prepare',
      test: 'vitest run',
    },
    devDependencies: {
      typescript: '^5.4.0 || ^6.0.0',
      vitest: '^4.1.10',
      wxt: WXT_VERSION,
    },
    nx: { name: projectName, projectType: 'application', tags: projectTags },
  });
  tree.write(
    `${directory}/wxt.config.ts`,
    `import { defineConfig } from 'wxt';\n\nexport default defineConfig({\n  manifest: {\n    name: ${JSON.stringify(raw.displayName?.trim() || name)},\n    description: 'Browser extension generated by Megamono',\n    permissions: ['storage'],\n  },\n});\n`,
  );
  writeJson(tree, `${directory}/tsconfig.json`, {
    extends: './.wxt/tsconfig.json',
    compilerOptions: { strict: true },
  });
  tree.write(
    `${directory}/entrypoints/background.ts`,
    'export default defineBackground(() => {\n  // Compose background capabilities here.\n});\n',
  );
  tree.write(
    `${directory}/entrypoints/content.ts`,
    "export default defineContentScript({\n  matches: ['<all_urls>'],\n  main() {\n    // Compose page integrations here.\n  },\n});\n",
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
  return () => installPackagesTask(tree);
}

export default extensionApplicationGenerator;
