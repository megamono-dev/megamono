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
  assertSupportedMegamonoConfigVersion,
  isSafeWorkspaceRelativePath,
  megamonoConfigSchema,
} from '../../lib/config';
import {
  applyManagedSkillTemplates,
  type ManagedSkillInstallResult,
} from '../../lib/managed-skills';
import {
  readArtifactRegistry,
  writeArtifactRegistry,
} from '../../lib/managed-artifacts';
import type { WorkspaceInitGeneratorSchema } from './schema';
import {
  createWorkspaceInitPlan,
  parseWorkspaceInitModules,
  renderWorkspaceInitPlan,
  renderWorkspaceInitSurvey,
  surveyWorkspaceInit,
} from '../../lib/workspace-init-plan';

const importTarget = {
  executor: '@megamono/plugin:import',
  cache: false,
  parallelism: false,
};

const healthTarget = {
  executor: '@megamono/plugin:health',
  cache: false,
  inputs: [
    '{workspaceRoot}/megamono.json',
    '{workspaceRoot}/.megamono/artifacts.json',
    '{workspaceRoot}/package.json',
    '{workspaceRoot}/package-lock.json',
    '{workspaceRoot}/nx.json',
    '{workspaceRoot}/docs/**/*.md',
    '{workspaceRoot}/**/package.json',
    '{workspaceRoot}/**/app.json',
    '{workspaceRoot}/**/Cargo.toml',
    '{workspaceRoot}/**/Package.swift',
    '{workspaceRoot}/**/.megamono-integration.json',
    '{workspaceRoot}/.agents/skills/**/*',
  ],
  outputs: ['{workspaceRoot}/.megamono/health.json'],
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

function ensureHealthTarget(tree: Tree): boolean {
  const project = getProjects(tree).get('megamono');
  if (!project) {
    throw new Error(
      'Workspace initialization is incomplete; missing the megamono project.',
    );
  }
  const current = project.targets?.health;
  if (current) {
    if (JSON.stringify(current) !== JSON.stringify(healthTarget)) {
      throw new Error(
        'megamono:health already exists with a different configuration.',
      );
    }
    return false;
  }
  updateProjectConfiguration(tree, 'megamono', {
    ...project,
    targets: { ...project.targets, health: healthTarget },
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
      - run: npm exec nx -- run megamono:health
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
          `          if [ -n "$(npm exec nx -- show projects --affected --exclude=tag:platform:apple)" ]; then
            echo "linux=true" >> "$GITHUB_OUTPUT"
          else
            echo "linux=false" >> "$GITHUB_OUTPUT"
          fi`,
        ]
      : []),
    ...(hasApple
      ? [
          `          if [ -n "$(npm exec nx -- show projects --affected${hasLinux ? ' --projects=tag:platform:apple' : ''})" ]; then
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
      - run: npm exec nx -- affected -t lint test build --exclude=tag:platform:apple --output-style=static`,
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
      - run: npm exec nx -- affected -t lint test build${hasLinux ? " --exclude='*,!tag:platform:apple'" : ''} --output-style=static`,
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
  const beforeClosing = current.slice(0, closing).trimEnd();
  const separator =
    beforeClosing.endsWith('[') || beforeClosing.endsWith(',') ? '' : ',';
  tree.write(
    path,
    `${imports}\n${beforeClosing}${separator}\n${entry}${current.slice(closing + 1)}`,
  );
}

function preflightEslintConfig(tree: Tree): void {
  const current = tree.read('eslint.config.mjs', 'utf8');
  if (!current) return;
  const hasImports = current.includes('// megamono eslint imports');
  const hasRules = current.includes('// megamono eslint rules');
  if (hasImports !== hasRules) {
    throw new Error(
      'eslint.config.mjs contains a partial Megamono ESLint configuration.',
    );
  }
  if (
    !hasImports &&
    (!current.includes('export default [') || current.lastIndexOf('\n];') < 0)
  ) {
    throw new Error(
      'eslint.config.mjs must export a flat config array before workspace-init can wire Megamono rules.',
    );
  }
}

function addIgnoreEntries(
  tree: Tree,
  path: string,
  entries: readonly string[],
): void {
  let source = tree.read(path, 'utf8') ?? '';
  const existing = new Set(source.split(/\r?\n/));
  for (const entry of entries) {
    if (existing.has(entry)) continue;
    source = `${source}${source.endsWith('\n') || source.length === 0 ? '' : '\n'}${entry}\n`;
    existing.add(entry);
  }
  tree.write(path, source);
}

function configuredWorkspacePlatforms(
  tree: Tree,
  fallback?: string,
): ReadonlySet<string> {
  const platforms = new Set<string>();
  for (const project of getProjects(tree).values()) {
    for (const tag of project.tags ?? []) {
      if (tag.startsWith('platform:')) {
        platforms.add(tag.slice('platform:'.length));
      }
    }
  }
  if (platforms.size === 0) platforms.add(fallback ?? 'node');
  return platforms;
}

function docsProjectConfiguration(docsRoot: string) {
  return {
    root: docsRoot,
    projectType: 'library' as const,
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
      index: { executor: '@megamono/plugin:docs-index', cache: false },
      archive: { executor: '@megamono/plugin:docs-archive', cache: false },
      'prune-reports': {
        executor: '@megamono/plugin:docs-prune-reports',
        cache: false,
      },
    },
  };
}

export async function workspaceInitGenerator(
  tree: Tree,
  options: WorkspaceInitGeneratorSchema,
): Promise<GeneratorCallback> {
  const outputFormat = options.format ?? 'markdown';
  if (options.survey) {
    logger.info(
      renderWorkspaceInitSurvey(surveyWorkspaceInit(tree), outputFormat),
    );
    return () => undefined;
  }
  let existingConfig: ReturnType<typeof megamonoConfigSchema.parse> | undefined;
  if (tree.exists('megamono.json')) {
    let currentConfig: unknown;
    try {
      currentConfig = JSON.parse(tree.read('megamono.json', 'utf8') ?? '');
    } catch (error) {
      throw new Error('Existing megamono.json is not valid JSON.', {
        cause: error,
      });
    }
    assertSupportedMegamonoConfigVersion(currentConfig, 'megamono.json');
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
    existingConfig = parsed.data;
  }
  const requestedModules = options.only
    ? parseWorkspaceInitModules(options.only)
    : existingConfig?.adoption.modules.length
      ? existingConfig.adoption.modules
      : parseWorkspaceInitModules();
  const adoptionPlan = createWorkspaceInitPlan(tree, {
    ...options,
    only: requestedModules,
  });
  if (options.only || options.yes) {
    logger.info(renderWorkspaceInitPlan(adoptionPlan, outputFormat));
  }
  const modules = new Set(requestedModules);
  const docsRoot = existingConfig?.docs.root ?? options.docsRoot ?? 'docs';
  if (!isSafeWorkspaceRelativePath(docsRoot)) {
    throw new Error('docsRoot must be a safe workspace-relative path.');
  }
  if (existingConfig && options.docsRoot && options.docsRoot !== docsRoot) {
    throw new Error(
      `workspace-init already uses docsRoot=${docsRoot}; received ${options.docsRoot}.`,
    );
  }
  if (
    !existingConfig &&
    modules.has('docs') &&
    tree.exists('content-collections.ts')
  ) {
    throw new Error(
      'content-collections.ts already exists. Merge the repository-document collections before running workspace-init.',
    );
  }
  for (const [module, path] of [
    ['ci', '.github/workflows/megamono-ci.yml'],
    ['health', '.github/workflows/megamono-health.yml'],
  ] as const) {
    if (!existingConfig && modules.has(module) && tree.exists(path)) {
      throw new Error(
        `${path} already exists without Megamono ownership metadata.`,
      );
    }
  }
  if (modules.has('lint')) preflightEslintConfig(tree);

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
  if (
    modules.has('lint') &&
    projectsNeedingPlatform.length > 0 &&
    !options.defaultPlatform
  ) {
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
    if (
      modules.has('lint') &&
      ![...tags].some((tag) => tag.startsWith('type:'))
    ) {
      tags.add(isApplication(project) ? 'type:app' : 'type:util');
    }
    if (
      modules.has('lint') &&
      ![...tags].some((tag) => tag.startsWith('scope:'))
    ) {
      tags.add(`scope:${defaultScope}`);
    }
    if (modules.has('lint') && isApplication(project)) {
      if (![...tags].some((tag) => tag.startsWith('platform:'))) {
        tags.add(`platform:${options.defaultPlatform}`);
      }
      if (![...tags].some((tag) => tag.startsWith('visibility:'))) {
        tags.add('visibility:internal');
      }
    }
    if (modules.has('lint')) {
      updateProjectConfiguration(tree, name, {
        ...project,
        tags: [...tags].sort(),
      });
    }
    for (const tag of tags) {
      if (tag.startsWith('platform:')) {
        configuredPlatforms.add(tag.slice('platform:'.length));
      }
    }
  }
  if (configuredPlatforms.size === 0) {
    configuredPlatforms.add(options.defaultPlatform ?? 'node');
  }

  if (!projects.has('megamono')) {
    addProjectConfiguration(tree, 'megamono', {
      root: '.megamono',
      projectType: 'application',
      tags: [
        'type:app',
        'scope:shared',
        'platform:node',
        'visibility:internal',
      ],
      targets: {
        check: {
          executor: '@megamono/plugin:check',
          cache: true,
          inputs: [
            '{workspaceRoot}/megamono.json',
            '{workspaceRoot}/.megamono/artifacts.json',
            '{workspaceRoot}/package.json',
            '{workspaceRoot}/package-lock.json',
            '{workspaceRoot}/nx.json',
            '{workspaceRoot}/docs/**/*.md',
            '{workspaceRoot}/**/package.json',
            '{workspaceRoot}/.agents/skills/**/*',
          ],
        },
        import: importTarget,
        ...(modules.has('health') ? { health: healthTarget } : {}),
      },
    });
  } else {
    ensureImportTarget(tree);
    if (modules.has('health')) ensureHealthTarget(tree);
  }
  if (!tree.exists('.megamono/artifacts.json')) {
    writeArtifactRegistry(tree, readArtifactRegistry(tree));
  }
  if (modules.has('docs') && !getProjects(tree).has('megamono-docs')) {
    addProjectConfiguration(
      tree,
      'megamono-docs',
      docsProjectConfiguration(docsRoot),
    );
  }

  const adoptedModules = new Set(existingConfig?.adoption.modules ?? []);
  for (const module of requestedModules) adoptedModules.add(module);
  const reductions = [
    ...(existingConfig?.adoption.reductions ?? []).filter(
      ({ module }) => !requestedModules.includes(module),
    ),
    ...adoptionPlan.reductions,
  ];
  const config = megamonoConfigSchema.parse({
    ...(existingConfig ?? DEFAULT_MEGAMONO_CONFIG),
    platforms: [...configuredPlatforms].sort(),
    docs: {
      ...(existingConfig?.docs ?? DEFAULT_MEGAMONO_CONFIG.docs),
      root: docsRoot,
    },
    adoption: {
      ...(existingConfig?.adoption ?? DEFAULT_MEGAMONO_CONFIG.adoption),
      modules: parseWorkspaceInitModules([...adoptedModules]),
      reductions,
    },
  });
  tree.write('megamono.json', `${JSON.stringify(config, null, 2)}\n`);
  if (modules.has('lint')) {
    const eslint = tree.read('eslint.config.mjs', 'utf8');
    if (!eslint?.includes('// megamono eslint imports')) wireEslintConfig(tree);
  }
  if (modules.has('docs') && !tree.exists('content-collections.ts')) {
    tree.write(
      'content-collections.ts',
      renderContentCollectionsConfig(docsRoot),
    );
  }
  const ignored = [
    ...(modules.has('docs') ? ['.content-collections/'] : []),
    '.megamono/graph.json',
    ...(modules.has('health') ? ['.megamono/health.json'] : []),
  ];
  addIgnoreEntries(tree, '.gitignore', ignored);
  addIgnoreEntries(tree, '.prettierignore', ignored);
  if (modules.has('docs'))
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
    ...(modules.has('docs')
      ? {
          [`${docsRoot}/INDEX.md`]: '# Repository documentation index\n',
          [`${docsRoot}/archives/INDEX.md`]: '# Archived documentation index\n',
          [`${docsRoot}/specs/.gitkeep`]: '',
          [`${docsRoot}/plans/.gitkeep`]: '',
          [`${docsRoot}/decisions/.gitkeep`]: '',
          [`${docsRoot}/audits/.gitkeep`]: '',
          [`${docsRoot}/research/.gitkeep`]: '',
          [`${docsRoot}/reports/.gitkeep`]: '',
          [`${docsRoot}/archives/specs/.gitkeep`]: '',
          [`${docsRoot}/archives/plans/.gitkeep`]: '',
          [`${docsRoot}/archives/research/.gitkeep`]: '',
        }
      : {}),
    ...(modules.has('agents')
      ? {
          [`${docsRoot}/DESIGN.md`]:
            '# Design\n\n## Direction\n\n## Influences\n\n## Not this\n\n## System\n',
        }
      : {}),
    ...(modules.has('skills') ? { '.agents/skills/.gitkeep': '' } : {}),
  };
  for (const [path, content] of Object.entries(files)) {
    if (!tree.exists(path)) tree.write(path, content);
  }
  if (modules.has('skills')) logManagedSkills(applyManagedSkillTemplates(tree));
  if (modules.has('health') && config.health.cadence !== 'disabled') {
    const workflowPath = '.github/workflows/megamono-health.yml';
    const workflow = renderHealthWorkflow(config.health.cadence);
    if (
      tree.exists(workflowPath) &&
      tree.read(workflowPath, 'utf8') !== workflow
    ) {
      throw new Error(
        `${workflowPath} already exists. Merge or remove it before running workspace-init.`,
      );
    }
    if (!tree.exists(workflowPath)) tree.write(workflowPath, workflow);
  }
  if (modules.has('ci')) {
    const ciPath = '.github/workflows/megamono-ci.yml';
    const workflow = renderCiWorkflow(
      configuredWorkspacePlatforms(tree, options.defaultPlatform),
    );
    if (tree.exists(ciPath) && tree.read(ciPath, 'utf8') !== workflow) {
      throw new Error(`${ciPath} differs from the managed Megamono template.`);
    }
    if (!tree.exists(ciPath)) tree.write(ciPath, workflow);
  }
  if (modules.has('agents') && !tree.exists('AGENTS.md')) {
    tree.write(
      'AGENTS.md',
      `# Repository instructions\n\nRead ${docsRoot}/INDEX.md, accepted specs, decisions, and in-progress plans before changing the repository. Use Megamono generators instead of hand-rolling repository structure.\n`,
    );
  }
  const agentsPath = 'AGENTS.md';
  const agentsMarker = '<!-- megamono affected CI -->';
  const agents = tree.read(agentsPath, 'utf8') ?? '';
  if (modules.has('agents') && !agents.includes(agentsMarker)) {
    tree.write(
      agentsPath,
      `${agents}${agents.endsWith('\n') || agents.length === 0 ? '' : '\n'}\n${agentsMarker}\n## Affected CI\n\nCI checks out full history and runs \`nrwl/nx-set-shas@v5\` before \`nx affected\`. Preserve that base/head convention when changing workflows so pull requests, merge queues, and default-branch runs compute the correct project set.\n`,
    );
  }
  if (modules.has('agents') && !tree.exists('CLAUDE.md')) {
    tree.write('CLAUDE.md', '@AGENTS.md\n');
  }
  if (options.report) {
    if (!isSafeWorkspaceRelativePath(options.report)) {
      throw new Error('report must be a safe workspace-relative path.');
    }
    tree.write(options.report, renderWorkspaceInitPlan(adoptionPlan));
  }
  const installTask = modules.has('docs')
    ? addDependenciesToPackageJson(
        tree,
        {},
        {
          '@content-collections/core': '0.15.2',
          zod: '>=4.1 <5',
        },
      )
    : () => undefined;
  await formatFiles(tree);

  return modules.has('skills')
    ? runTasksInSerial(installTask, linkSkillsCallback(tree.root))
    : installTask;
}

export default workspaceInitGenerator;
