import {
  addDependenciesToPackageJson,
  addProjectConfiguration,
  formatFiles,
  getProjects,
  logger,
  runTasksInSerial,
  updateProjectConfiguration,
  updateJson,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_MEGAMONO_CONFIG,
  isSafeWorkspaceRelativePath,
  megamonoConfigSchema,
} from '../../lib/config';
import {
  applyManagedSkillTemplates,
  type ManagedSkillInstallResult,
} from '../../lib/managed-skills';
import type { WorkspaceInitGeneratorSchema } from './schema';

const importTarget = {
  executor: '@megamono/plugin:import',
  cache: false,
  parallelism: false,
};

function ensureImportTarget(tree: Tree): boolean {
  const project = getProjects(tree).get('megamono');
  if (!project) {
    throw new Error(
      'Workspace initialization is incomplete; missing the megamono project.',
    );
  }
  const current = project.targets?.import;
  if (current) {
    if (JSON.stringify(current) !== JSON.stringify(importTarget)) {
      throw new Error(
        'megamono:import already exists with a different configuration.',
      );
    }
    return false;
  }
  updateProjectConfiguration(tree, 'megamono', {
    ...project,
    targets: { ...project.targets, import: importTarget },
  });
  return true;
}

function logManagedSkills(results: readonly ManagedSkillInstallResult[]): void {
  for (const result of results) {
    if (result.state === 'installed' || result.state === 'updated') {
      logger.info(`Megamono skill ${result.name}: ${result.reason}.`);
    } else if (
      result.state === 'modified' ||
      result.state === 'unmanaged' ||
      result.state === 'invalid-provenance'
    ) {
      logger.warn(
        `Megamono skill ${result.name}: ${result.reason}; unchanged.`,
      );
    }
  }
}

function linkSkillsCallback(workspaceRoot: string): GeneratorCallback {
  return () => {
    const linkPath = join(workspaceRoot, '.claude', 'skills');
    const target = join('..', '.agents', 'skills');
    if (existsSync(linkPath)) {
      const current = lstatSync(linkPath);
      if (!current.isSymbolicLink()) {
        logger.warn(
          '.claude/skills already exists and is not a symlink; left it unchanged.',
        );
      }
      return;
    }
    const parent = dirname(linkPath);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    try {
      symlinkSync(target, linkPath, 'dir');
    } catch (error) {
      logger.warn(
        `Unable to create .claude/skills symlink: ${(error as Error).message}`,
      );
    }
  };
}

function renderContentCollectionsConfig(docsRoot: string): string {
  return `import { defineCollection, defineConfig } from '@content-collections/core';
import { repositoryContentCollectionSchema } from '@megamono/plugin';

const repoDocs = defineCollection({
  name: 'repoDocs',
  directory: ${JSON.stringify(docsRoot)},
  include: [
    'specs/**/*.md',
    'plans/**/*.md',
    'decisions/**/*.md',
    'audits/**/*.md',
    'research/**/*.md',
    'reports/**/*.md',
  ],
  exclude: ['**/README.md', '**/OVERVIEW.md', '**/INDEX.md'],
  schema: repositoryContentCollectionSchema,
});

const archivedDocs = defineCollection({
  name: 'archivedDocs',
  directory: ${JSON.stringify(`${docsRoot}/archives`)},
  include: ['**/*.md'],
  exclude: ['**/INDEX.md'],
  schema: repositoryContentCollectionSchema,
});

export default defineConfig({ content: [repoDocs, archivedDocs] });
`;
}

function renderHealthWorkflow(cadence: 'weekly' | 'daily'): string {
  const cron = cadence === 'daily' ? '17 9 * * *' : '17 9 * * 1';
  return `name: Megamono repository health

on:
  schedule:
    - cron: '${cron}'
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  health:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm exec nx run megamono-docs:health
      - uses: actions/github-script@v8
        with:
          script: |
            const fs = require('node:fs');
            const { publishHealthIssue } = require('@megamono/plugin');
            const report = JSON.parse(fs.readFileSync('.megamono/health.json', 'utf8'));
            await publishHealthIssue({ github, context, core, report });
`;
}

function renderCiWorkflow(platforms: ReadonlySet<string>): string {
  const linuxPlatforms = ['web', 'node', 'worker', 'rust', 'php', 'extension'];
  const hasLinux = linuxPlatforms.some((platform) => platforms.has(platform));
  const hasApple = platforms.has('apple');
  const gh = (expression: string) => '${{ ' + expression + ' }}';
  const planChecks = [
    ...(hasLinux
      ? [
          `          if [ -n "$(npm exec nx show projects --affected --exclude=tag:platform:apple)" ]; then
            echo "linux=true" >> "$GITHUB_OUTPUT"
          else
            echo "linux=false" >> "$GITHUB_OUTPUT"
          fi`,
        ]
      : []),
    ...(hasApple
      ? [
          `          if [ -n "$(npm exec nx show projects --affected${hasLinux ? ' --projects=tag:platform:apple' : ''})" ]; then
            echo "apple=true" >> "$GITHUB_OUTPUT"
          else
            echo "apple=false" >> "$GITHUB_OUTPUT"
          fi`,
        ]
      : []),
  ].join('\n');
  const jobs = [
    ...(hasLinux
      ? [
          `  linux:
    needs: plan
    if: needs.plan.outputs.linux == 'true'
    runs-on: ubuntu-latest
    env:
      NX_BASE: ${gh('needs.plan.outputs.base')}
      NX_HEAD: ${gh('needs.plan.outputs.head')}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
${platforms.has('rust') ? '      - uses: dtolnay/rust-toolchain@stable\n' : ''}${platforms.has('php') ? '      - uses: shivammathur/setup-php@v2\n        with:\n          php-version: 8.4\n' : ''}      - run: npm ci
      - run: npm exec nx affected -t lint test build --exclude=tag:platform:apple --output-style=static`,
        ]
      : []),
    ...(hasApple
      ? [
          `  apple:
    needs: plan
    if: needs.plan.outputs.apple == 'true'
    runs-on: macos-latest
    env:
      NX_BASE: ${gh('needs.plan.outputs.base')}
      NX_HEAD: ${gh('needs.plan.outputs.head')}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: xcodebuild -downloadComponent MetalToolchain
      - run: npm exec nx affected -t lint test build${hasLinux ? " --exclude='*,!tag:platform:apple'" : ''} --output-style=static`,
        ]
      : []),
  ].join('\n\n');
  return `name: CI

on:
  push:
    branches: [main]
  pull_request:
  merge_group:

permissions:
  actions: read
  contents: read
  pull-requests: read

jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
${hasLinux ? `      linux: ${gh('steps.affected.outputs.linux')}\n` : ''}${hasApple ? `      apple: ${gh('steps.affected.outputs.apple')}\n` : ''}      base: ${gh('steps.affected.outputs.base')}
      head: ${gh('steps.affected.outputs.head')}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - uses: nrwl/nx-set-shas@v5
      - id: affected
        shell: bash
        run: |
${planChecks}
          echo "base=$NX_BASE" >> "$GITHUB_OUTPUT"
          echo "head=$NX_HEAD" >> "$GITHUB_OUTPUT"

${jobs}
`;
}

function wireEslintConfig(tree: Tree): void {
  const path = 'eslint.config.mjs';
  const importMarker = '// megamono eslint imports';
  const configMarker = '// megamono eslint rules';
  const imports = `${importMarker}
import megamonoConfig from './megamono.json' with { type: 'json' };
import megamonoPlugin from '@megamono/plugin/eslint';
`;
  const entry = `  ${configMarker}
  megamonoPlugin.createConfig(megamonoConfig),
`;
  const current = tree.read(path, 'utf8');
  if (!current) {
    tree.write(path, `${imports}\nexport default [\n${entry}];\n`);
    return;
  }
  if (current.includes(importMarker) || current.includes(configMarker)) {
    throw new Error(
      'eslint.config.mjs contains a partial Megamono ESLint configuration.',
    );
  }
  const closing = current.lastIndexOf('\n];');
  if (!current.includes('export default [') || closing < 0) {
    throw new Error(
      'eslint.config.mjs must export a flat config array before workspace-init can wire Megamono rules.',
    );
  }
  tree.write(
    path,
    `${imports}\n${current.slice(0, closing + 1)}${entry}${current.slice(closing + 1)}`,
  );
}

export async function workspaceInitGenerator(
  tree: Tree,
  options: WorkspaceInitGeneratorSchema,
): Promise<GeneratorCallback> {
  if (tree.exists('megamono.json')) {
    let currentConfig: unknown;
    try {
      currentConfig = JSON.parse(tree.read('megamono.json', 'utf8') ?? '');
    } catch (error) {
      throw new Error('Existing megamono.json is not valid JSON.', {
        cause: error,
      });
    }
    const parsed = megamonoConfigSchema.safeParse(currentConfig);
    if (!parsed.success) {
      throw new Error(
        `Existing megamono.json is invalid:\n${parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
          )
          .join('\n')}`,
      );
    }
    if (options.docsRoot && options.docsRoot !== parsed.data.docs.root) {
      throw new Error(
        `workspace-init already uses docsRoot=${parsed.data.docs.root}; received ${options.docsRoot}.`,
      );
    }
    if (
      options.defaultPlatform &&
      !parsed.data.platforms.includes(options.defaultPlatform)
    ) {
      throw new Error(
        `workspace-init is already configured without platform ${options.defaultPlatform}.`,
      );
    }
    const requiredFiles = [
      'content-collections.ts',
      '.megamono/project.json',
      `${parsed.data.docs.root}/project.json`,
    ];
    const missingFiles = requiredFiles.filter((path) => !tree.exists(path));
    if (missingFiles.length > 0) {
      throw new Error(
        `Workspace initialization is incomplete; missing ${missingFiles.join(', ')}. Repair the partial initialization before retrying.`,
      );
    }
    const importTargetInstalled = ensureImportTarget(tree);
    const skillResults = applyManagedSkillTemplates(tree);
    logManagedSkills(skillResults);
    if (
      !importTargetInstalled &&
      skillResults.every(
        ({ state }) =>
          state === 'current' ||
          state === 'ejected' ||
          state === 'modified' ||
          state === 'unmanaged' ||
          state === 'invalid-provenance',
      )
    ) {
      logger.info(
        'Megamono workspace is already initialized; no changes made.',
      );
    }
    return linkSkillsCallback(tree.root);
  }
  if (tree.exists('content-collections.ts')) {
    throw new Error(
      'content-collections.ts already exists. Merge the repository-document collections before running workspace-init.',
    );
  }

  const docsRoot = options.docsRoot ?? 'docs';
  if (!isSafeWorkspaceRelativePath(docsRoot)) {
    throw new Error('docsRoot must be a safe workspace-relative path.');
  }
  const defaultScope = options.defaultScope ?? 'shared';
  const projects = getProjects(tree);
  const configuredPlatforms = new Set<string>();
  const isApplication = (project: { projectType?: string }) =>
    project.projectType !== 'library';
  const projectsNeedingPlatform = [...projects.entries()].filter(
    ([name, project]) =>
      name !== 'megamono' &&
      name !== 'megamono-docs' &&
      isApplication(project) &&
      !(project.tags ?? []).some((tag) => tag.startsWith('platform:')),
  );
  if (projectsNeedingPlatform.length > 0 && !options.defaultPlatform) {
    throw new Error(
      `Existing applications require --defaultPlatform before initialization: ${projectsNeedingPlatform
        .map(([name]) => name)
        .sort()
        .join(', ')}`,
    );
  }

  for (const [name, project] of projects) {
    if (name === 'megamono' || name === 'megamono-docs') continue;
    const tags = new Set(project.tags ?? []);
    if (![...tags].some((tag) => tag.startsWith('type:'))) {
      tags.add(isApplication(project) ? 'type:app' : 'type:util');
    }
    if (![...tags].some((tag) => tag.startsWith('scope:'))) {
      tags.add(`scope:${defaultScope}`);
    }
    if (isApplication(project)) {
      if (![...tags].some((tag) => tag.startsWith('platform:'))) {
        tags.add(`platform:${options.defaultPlatform}`);
      }
      if (![...tags].some((tag) => tag.startsWith('visibility:'))) {
        tags.add('visibility:internal');
      }
    }
    updateProjectConfiguration(tree, name, {
      ...project,
      tags: [...tags].sort(),
    });
    for (const tag of tags) {
      if (tag.startsWith('platform:')) {
        configuredPlatforms.add(tag.slice('platform:'.length));
      }
    }
  }
  if (configuredPlatforms.size === 0) {
    configuredPlatforms.add(options.defaultPlatform ?? 'node');
  }

  addProjectConfiguration(tree, 'megamono', {
    root: '.megamono',
    projectType: 'application',
    tags: ['type:app', 'scope:shared', 'platform:node', 'visibility:internal'],
    targets: {
      check: {
        executor: '@megamono/plugin:check',
        cache: true,
        inputs: [
          '{workspaceRoot}/megamono.json',
          '{workspaceRoot}/package.json',
          '{workspaceRoot}/package-lock.json',
          '{workspaceRoot}/nx.json',
          '{workspaceRoot}/docs/**/*.md',
          '{workspaceRoot}/**/package.json',
          '{workspaceRoot}/.agents/skills/**/*',
        ],
      },
      import: importTarget,
    },
  });
  addProjectConfiguration(tree, 'megamono-docs', {
    root: docsRoot,
    projectType: 'library',
    tags: ['type:util', 'scope:shared', 'platform:node'],
    targets: {
      validate: {
        executor: '@megamono/plugin:docs-validate',
        cache: true,
        inputs: [
          '{workspaceRoot}/megamono.json',
          '{workspaceRoot}/content-collections.ts',
          `{workspaceRoot}/${docsRoot}/**/*.md`,
        ],
        outputs: ['{workspaceRoot}/.content-collections'],
      },
      index: {
        executor: '@megamono/plugin:docs-index',
        cache: false,
      },
      archive: {
        executor: '@megamono/plugin:docs-archive',
        cache: false,
      },
      'prune-reports': {
        executor: '@megamono/plugin:docs-prune-reports',
        cache: false,
      },
      health: {
        executor: '@megamono/plugin:health',
        cache: false,
        inputs: [
          '{workspaceRoot}/megamono.json',
          '{workspaceRoot}/package.json',
          '{workspaceRoot}/package-lock.json',
          '{workspaceRoot}/nx.json',
          `{workspaceRoot}/${docsRoot}/**/*.md`,
          '{workspaceRoot}/**/package.json',
          '{workspaceRoot}/**/app.json',
          '{workspaceRoot}/**/Cargo.toml',
          '{workspaceRoot}/**/Package.swift',
          '{workspaceRoot}/**/.megamono-integration.json',
          '{workspaceRoot}/.agents/skills/**/*',
        ],
        outputs: ['{workspaceRoot}/.megamono/health.json'],
      },
    },
  });

  const config = {
    ...DEFAULT_MEGAMONO_CONFIG,
    platforms: options.defaultPlatform ? [options.defaultPlatform] : [],
    docs: { ...DEFAULT_MEGAMONO_CONFIG.docs, root: docsRoot },
  };
  tree.write('megamono.json', `${JSON.stringify(config, null, 2)}\n`);
  wireEslintConfig(tree);
  tree.write(
    'content-collections.ts',
    renderContentCollectionsConfig(docsRoot),
  );
  const appendIgnoreEntries = (path: string, entries: readonly string[]) => {
    let source = tree.read(path, 'utf8') ?? '';
    const existing = new Set(source.split(/\r?\n/));
    for (const entry of entries) {
      if (existing.has(entry)) continue;
      source = `${source}${source.endsWith('\n') || source.length === 0 ? '' : '\n'}${entry}\n`;
      existing.add(entry);
    }
    tree.write(path, source);
  };
  appendIgnoreEntries('.gitignore', [
    '.content-collections/',
    '.megamono/graph.json',
    '.megamono/health.json',
  ]);
  appendIgnoreEntries('.prettierignore', [
    '.content-collections/',
    '.megamono/graph.json',
    '.megamono/health.json',
  ]);
  updateJson(tree, 'tsconfig.base.json', (value) => {
    const compilerOptions = value.compilerOptions ?? {};
    const paths = compilerOptions.paths ?? {};
    const generatedPaths = {
      'content-collections': ['./.content-collections/index.js'],
      'content-collections/*': ['./.content-collections/*.js'],
    };
    for (const [name, mapping] of Object.entries(generatedPaths)) {
      const current = paths[name];
      if (current && JSON.stringify(current) !== JSON.stringify(mapping)) {
        throw new Error(
          `tsconfig.base.json already defines ${name}; merge the Content Collections path before running workspace-init.`,
        );
      }
    }
    return {
      ...value,
      compilerOptions: {
        ...compilerOptions,
        paths: { ...paths, ...generatedPaths },
      },
    };
  });
  const files: Readonly<Record<string, string>> = {
    [`${docsRoot}/INDEX.md`]: '# Repository documentation index\n',
    [`${docsRoot}/archives/INDEX.md`]: '# Archived documentation index\n',
    [`${docsRoot}/DESIGN.md`]:
      '# Design\n\n## Direction\n\n## Influences\n\n## Not this\n\n## System\n',
    [`${docsRoot}/specs/.gitkeep`]: '',
    [`${docsRoot}/plans/.gitkeep`]: '',
    [`${docsRoot}/decisions/.gitkeep`]: '',
    [`${docsRoot}/audits/.gitkeep`]: '',
    [`${docsRoot}/research/.gitkeep`]: '',
    [`${docsRoot}/reports/.gitkeep`]: '',
    [`${docsRoot}/archives/specs/.gitkeep`]: '',
    [`${docsRoot}/archives/plans/.gitkeep`]: '',
    [`${docsRoot}/archives/research/.gitkeep`]: '',
    '.agents/skills/.gitkeep': '',
  };
  for (const [path, content] of Object.entries(files)) {
    if (!tree.exists(path)) tree.write(path, content);
  }
  logManagedSkills(applyManagedSkillTemplates(tree));
  if (config.health.cadence !== 'disabled') {
    const workflowPath = '.github/workflows/megamono-health.yml';
    if (tree.exists(workflowPath)) {
      throw new Error(
        `${workflowPath} already exists. Merge or remove it before running workspace-init.`,
      );
    }
    tree.write(workflowPath, renderHealthWorkflow(config.health.cadence));
  }
  const nxCiPath = '.github/workflows/ci.yml';
  const nxCi = tree.read(nxCiPath, 'utf8');
  const ciPath =
    !nxCi ||
    nxCi.includes('npx nx start-ci-run') ||
    nxCi.includes('npx nx fix-ci')
      ? nxCiPath
      : '.github/workflows/megamono-ci.yml';
  if (ciPath !== nxCiPath && tree.exists(ciPath)) {
    throw new Error(
      `${ciPath} already exists. Merge or remove it before running workspace-init.`,
    );
  }
  tree.write(ciPath, renderCiWorkflow(configuredPlatforms));
  if (!tree.exists('AGENTS.md')) {
    tree.write(
      'AGENTS.md',
      `# Repository instructions\n\nRead ${docsRoot}/INDEX.md, accepted specs, decisions, and in-progress plans before changing the repository. Use Megamono generators instead of hand-rolling repository structure.\n`,
    );
  }
  const agentsPath = 'AGENTS.md';
  const agentsMarker = '<!-- megamono affected CI -->';
  const agents = tree.read(agentsPath, 'utf8') ?? '';
  if (!agents.includes(agentsMarker)) {
    tree.write(
      agentsPath,
      `${agents}${agents.endsWith('\n') || agents.length === 0 ? '' : '\n'}\n${agentsMarker}\n## Affected CI\n\nCI checks out full history and runs \`nrwl/nx-set-shas@v5\` before \`nx affected\`. Preserve that base/head convention when changing workflows so pull requests, merge queues, and default-branch runs compute the correct project set.\n`,
    );
  }
  if (!tree.exists('CLAUDE.md')) tree.write('CLAUDE.md', '@AGENTS.md\n');
  const installTask = addDependenciesToPackageJson(
    tree,
    {},
    {
      '@content-collections/core': '0.15.2',
      zod: '>=4.1 <5',
    },
  );
  await formatFiles(tree);

  return runTasksInSerial(installTask, linkSkillsCallback(tree.root));
}

export default workspaceInitGenerator;
