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
import { prompt } from 'enquirer';
import {
  DEFAULT_MEGAMONO_CONFIG,
  assertSupportedMegamonoConfigVersion,
  isSafeWorkspaceRelativePath,
  megamonoConfigSchema,
} from '../../lib/config';
import {
  applyManagedSkillTemplates,
  readPluginVersion,
  type ManagedSkillInstallResult,
} from '../../lib/managed-skills';
import {
  extractManagedSection,
  hashArtifactBytes,
  readArtifactRegistry,
  upsertArtifactEntry,
  writeArtifactRegistry,
  type ArtifactMode,
  type ManagedArtifactEntry,
} from '../../lib/managed-artifacts';
import type { WorkspaceInitGeneratorSchema } from './schema';
import {
  WORKSPACE_INIT_MODULES,
  WorkspaceInitError,
  createWorkspaceInitPlan,
  parseWorkspaceInitModules,
  renderWorkspaceInitCompletion,
  renderWorkspaceInitPlan,
  renderWorkspaceInitSurvey,
  surveyWorkspaceInit,
} from '../../lib/workspace-init-plan';
import {
  assertWorkspaceInitPreflight,
  collectWorkspaceInitHostState,
} from '../../lib/workspace-init-preflight';
import { createWorkspaceInitPostFlushCallback } from '../../lib/workspace-init-execution';
import { ensureManagedSkillsProjection } from '../../lib/skills-projection';

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

const AGENTS_SECTION_START = '<!-- megamono instructions start -->';
const AGENTS_SECTION_END = '<!-- megamono instructions end -->';
const LEGACY_AGENTS_MARKER = '<!-- megamono affected CI -->';
const SUPPORTED_PLATFORMS = new Set([
  'web',
  'node',
  'worker',
  'apple',
  'rust',
  'php',
  'extension',
]);
const SUPPORTED_SERVICES = new Set([
  'postgres',
  'redis',
  'clickhouse',
  'typesense',
]);

function canPrompt(options: WorkspaceInitGeneratorSchema): boolean {
  return (
    options.interactive !== false &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true
  );
}

async function promptForModules(): Promise<string> {
  const response = await prompt<{ modules: string[] }>({
    type: 'multiselect',
    name: 'modules',
    message: 'Which Megamono modules should this workspace adopt?',
    choices: WORKSPACE_INIT_MODULES.map((module) => ({
      name: module,
      message: module,
    })),
    validate: (value) =>
      Array.isArray(value) && value.length > 0
        ? true
        : 'Select at least one module.',
  });
  return response.modules.join(',');
}

async function promptForDefaultPlatform(): Promise<
  NonNullable<WorkspaceInitGeneratorSchema['defaultPlatform']>
> {
  const response = await prompt<{
    platform: NonNullable<WorkspaceInitGeneratorSchema['defaultPlatform']>;
  }>({
    type: 'select',
    name: 'platform',
    message: 'Which platform should untagged existing applications use?',
    choices: [...SUPPORTED_PLATFORMS].sort(),
  });
  return response.platform;
}

async function promptForConfirmation(): Promise<boolean> {
  const response = await prompt<{ confirmed: boolean }>({
    type: 'confirm',
    name: 'confirmed',
    message: 'Apply this workspace initialization plan?',
    initial: false,
  });
  return response.confirmed;
}

interface FileArtifactRegistration {
  readonly id: string;
  readonly module: string;
  readonly mode: ArtifactMode;
  readonly target: string;
  readonly ejectable: boolean;
  readonly templateContent?: string;
  readonly startDelimiter?: string;
  readonly endDelimiter?: string;
  readonly claimExisting?: boolean;
  readonly allowManagedUpdate?: boolean;
}

function artifactEntry(
  tree: Tree,
  id: string,
): ManagedArtifactEntry | undefined {
  return readArtifactRegistry(tree).artifacts.find(
    (artifact) => artifact.id === id,
  );
}

function artifactIsEjected(tree: Tree, id: string): boolean {
  return artifactEntry(tree, id)?.state === 'ejected';
}

function managedArtifactCanUpdate(
  tree: Tree,
  id: string,
  target: string,
  allowMissing = false,
): boolean {
  const current = artifactEntry(tree, id);
  if (!current) return !tree.exists(target);
  if (current.state === 'ejected' || current.mode !== 'managed') return false;
  const source = tree.read(target);
  if (source === null) return allowMissing;
  return hashArtifactBytes(source) === current.installedHash;
}

function applyManagedFileTemplate(
  tree: Tree,
  id: string,
  target: string,
  template: string,
  allowMissing = false,
): boolean {
  if (!managedArtifactCanUpdate(tree, id, target, allowMissing)) {
    const current = artifactEntry(tree, id);
    if (current?.state !== 'ejected') {
      logger.warn(
        `Megamono artifact ${id} is modified or repository-owned; left ${target} unchanged. Run workspace-eject before taking repository ownership.`,
      );
    }
    return false;
  }
  if (tree.read(target, 'utf8') !== template) tree.write(target, template);
  return true;
}

function registerFileArtifact(
  tree: Tree,
  registration: FileArtifactRegistration,
  sourceVersion: string,
): void {
  const source = tree.read(registration.target, 'utf8');
  if (source === null) return;
  const registry = readArtifactRegistry(tree);
  const current = registry.artifacts.find(({ id }) => id === registration.id);
  if (current?.state === 'ejected' || current?.mode === 'seeded') return;
  const ownedContent =
    registration.mode === 'managed-section'
      ? extractManagedSection(
          source,
          registration.startDelimiter ?? '',
          registration.endDelimiter ?? '',
        )
      : source;
  if (ownedContent === undefined) return;
  const installedHash = hashArtifactBytes(ownedContent);
  const templateHash = hashArtifactBytes(
    registration.templateContent ?? ownedContent,
  );
  if (
    current &&
    current.installedHash !== installedHash &&
    !registration.allowManagedUpdate
  ) {
    logger.warn(
      `Megamono artifact ${registration.id} is modified; left ${registration.target} unchanged. ${registration.ejectable ? 'Run workspace-eject to make it repository-owned.' : 'Restore the managed artifact before retrying.'}`,
    );
    return;
  }
  if (!current && !registration.claimExisting) {
    logger.warn(
      `${registration.target} is repository-owned and was not added to the Megamono artifact registry.`,
    );
    return;
  }
  const state =
    registration.mode === 'seeded'
      ? 'seeded'
      : registration.mode === 'derived'
        ? 'derived'
        : 'managed';
  writeArtifactRegistry(
    tree,
    upsertArtifactEntry(registry, {
      id: registration.id,
      module: registration.module,
      mode: registration.mode,
      target: registration.target,
      sourceVersion,
      templateHash,
      installedHash,
      state,
      ejectable: registration.ejectable,
      ...(registration.mode === 'managed-section'
        ? {
            startDelimiter: registration.startDelimiter,
            endDelimiter: registration.endDelimiter,
          }
        : {}),
    }),
  );
}

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

function linkSkillsCallback(
  workspaceRoot: string,
  pluginVersion: string,
  allowRecreate: boolean,
): GeneratorCallback {
  return () => {
    const result = ensureManagedSkillsProjection(workspaceRoot, pluginVersion, {
      allowRecreate,
    });
    if (
      result.state === 'conflict' ||
      result.state === 'missing' ||
      result.state === 'unmanaged'
    ) {
      logger.warn(`Megamono skills projection: ${result.reason}; unchanged.`);
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

function parseConfiguredPlatforms(source?: string): readonly string[] {
  if (!source) return [];
  const platforms = [...new Set(source.split(',').map((value) => value.trim()))]
    .filter(Boolean)
    .sort();
  const unknown = platforms.filter(
    (platform) => !SUPPORTED_PLATFORMS.has(platform),
  );
  if (unknown.length > 0) {
    throw new Error(`Unsupported configured platforms: ${unknown.join(', ')}.`);
  }
  return platforms;
}

function parseServiceRequirements(
  source?: string,
): Readonly<Record<string, string>> {
  if (!source) return {};
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error('serviceRequirements must be a valid JSON object.', {
      cause: error,
    });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('serviceRequirements must be a JSON object.');
  }
  const requirements = value as Record<string, unknown>;
  const invalid = Object.entries(requirements).filter(
    ([name, version]) =>
      !SUPPORTED_SERVICES.has(name) ||
      typeof version !== 'string' ||
      version.length === 0,
  );
  if (invalid.length > 0) {
    throw new Error(
      `Invalid service requirements: ${invalid
        .map(([name]) => name)
        .sort()
        .join(', ')}.`,
    );
  }
  return requirements as Record<string, string>;
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
  if (tree.root !== '/virtual') {
    assertWorkspaceInitPreflight(
      tree,
      await collectWorkspaceInitHostState(tree.root),
      { bootstrap: options.bootstrap },
    );
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
  const workspaceSurvey = surveyWorkspaceInit(tree);
  logger.info(renderWorkspaceInitSurvey(workspaceSurvey, outputFormat));
  let only = options.only;
  if (!only) {
    if (options.yes || !canPrompt(options)) {
      throw new WorkspaceInitError(
        'decision-required',
        'Provide --only with the modules to adopt in non-interactive mode.',
      );
    }
    only = await promptForModules();
  }
  const requestedModules = parseWorkspaceInitModules(only);
  let defaultPlatform = options.defaultPlatform;
  let adoptionPlan = createWorkspaceInitPlan(tree, {
    ...options,
    yes: false,
    only: requestedModules,
    defaultPlatform,
  });
  if (adoptionPlan.decisions.length > 0 && !defaultPlatform) {
    if (!canPrompt(options)) {
      throw new WorkspaceInitError(
        'decision-required',
        adoptionPlan.decisions.join(' '),
      );
    }
    defaultPlatform = await promptForDefaultPlatform();
    adoptionPlan = createWorkspaceInitPlan(tree, {
      ...options,
      yes: false,
      only: requestedModules,
      defaultPlatform,
    });
  }
  if (adoptionPlan.conflicts.length > 0) {
    throw new WorkspaceInitError('conflict', adoptionPlan.conflicts.join(' '));
  }
  logger.info(renderWorkspaceInitPlan(adoptionPlan, outputFormat));
  if (!options.yes) {
    if (!canPrompt(options)) {
      throw new WorkspaceInitError(
        'decision-required',
        'Preview confirmation is required; rerun interactively or pass --yes.',
      );
    }
    if (!(await promptForConfirmation())) return () => undefined;
  }
  const modules = new Set(requestedModules);
  const requestedPlatforms = parseConfiguredPlatforms(options.platforms);
  const serviceRequirements = parseServiceRequirements(
    options.serviceRequirements,
  );
  const docsRoot = existingConfig?.docs.root ?? options.docsRoot ?? 'docs';
  if (options.report && !isSafeWorkspaceRelativePath(options.report)) {
    throw new WorkspaceInitError(
      'options',
      'report must be a safe workspace-relative path.',
    );
  }
  const created = {
    config: !tree.exists('megamono.json'),
    project: !tree.exists('.megamono/project.json'),
    docsLoader: !tree.exists('content-collections.ts'),
    docsIndex: !tree.exists(`${docsRoot}/INDEX.md`),
    docsArchiveIndex: !tree.exists(`${docsRoot}/archives/INDEX.md`),
    design: !tree.exists(`${docsRoot}/DESIGN.md`),
    agents: !tree.exists('AGENTS.md'),
    claude: !tree.exists('CLAUDE.md'),
    ci: !tree.exists('.github/workflows/megamono-ci.yml'),
    health: !tree.exists('.github/workflows/megamono-health.yml'),
  };
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
    !defaultPlatform
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
        tags.add(`platform:${defaultPlatform}`);
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
  const coreProjectCanUpdate = managedArtifactCanUpdate(
    tree,
    'core.project',
    '.megamono/project.json',
    Boolean(options.yes),
  );
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
  } else if (coreProjectCanUpdate) {
    ensureImportTarget(tree);
    if (modules.has('health')) ensureHealthTarget(tree);
  } else {
    logger.warn(
      'Megamono artifact core.project is modified; left .megamono/project.json unchanged. Restore the managed project configuration before retrying.',
    );
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

  const inference = {
    ...(workspaceSurvey.manifests.apple.length > 0
      ? {
          apple: {
            plugin: '@megamono/nx-apple' as const,
            manifests: workspaceSurvey.manifests.apple,
          },
        }
      : {}),
    ...(workspaceSurvey.manifests.cargo.length > 0
      ? {
          cargo: {
            plugin: '@megamono/nx-cargo' as const,
            manifests: workspaceSurvey.manifests.cargo,
          },
        }
      : {}),
  };
  if (modules.has('inference') && Object.keys(inference).length > 0) {
    updateJson(tree, 'nx.json', (value) => {
      const plugins: unknown[] = Array.isArray(value.plugins)
        ? value.plugins
        : [];
      const pluginNames = new Set(
        plugins.flatMap((plugin) =>
          typeof plugin === 'string'
            ? [plugin]
            : plugin && typeof plugin === 'object' && 'plugin' in plugin
              ? [String(plugin.plugin)]
              : [],
        ),
      );
      const additions = Object.values(inference)
        .map(({ plugin }) => plugin)
        .filter((plugin) => !pluginNames.has(plugin));
      return { ...value, plugins: [...plugins, ...additions] };
    });
    if ('apple' in inference) configuredPlatforms.add('apple');
    if ('cargo' in inference) configuredPlatforms.add('rust');
  }
  if (configuredPlatforms.size === 0) {
    configuredPlatforms.add(defaultPlatform ?? 'node');
  }
  if (requestedPlatforms.length > 0) {
    configuredPlatforms.clear();
    for (const platform of requestedPlatforms)
      configuredPlatforms.add(platform);
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
      inference: modules.has('inference')
        ? inference
        : (existingConfig?.adoption.inference ?? {}),
    },
    services: {
      runner:
        options.serviceRunner ?? existingConfig?.services.runner ?? 'none',
      requirements:
        options.serviceRequirements !== undefined
          ? serviceRequirements
          : (existingConfig?.services.requirements ?? {}),
    },
  });
  tree.write('megamono.json', `${JSON.stringify(config, null, 2)}\n`);
  if (modules.has('lint')) {
    const eslint = tree.read('eslint.config.mjs', 'utf8');
    if (!eslint?.includes('// megamono eslint imports')) wireEslintConfig(tree);
  }
  const docsLoaderTemplate = renderContentCollectionsConfig(docsRoot);
  const docsLoaderCanUpdate = modules.has('docs')
    ? applyManagedFileTemplate(
        tree,
        'docs.loader',
        'content-collections.ts',
        docsLoaderTemplate,
        Boolean(options.yes),
      )
    : false;
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
  const healthWorkflow = renderHealthWorkflow(
    config.health.cadence === 'disabled' ? 'weekly' : config.health.cadence,
  );
  const healthCanUpdate =
    modules.has('health') && config.health.cadence !== 'disabled'
      ? applyManagedFileTemplate(
          tree,
          'health.workflow',
          '.github/workflows/megamono-health.yml',
          healthWorkflow,
          Boolean(options.yes),
        )
      : false;
  const ciWorkflow = renderCiWorkflow(
    configuredWorkspacePlatforms(tree, defaultPlatform),
  );
  const ciCanUpdate = modules.has('ci')
    ? applyManagedFileTemplate(
        tree,
        'ci.affected',
        '.github/workflows/megamono-ci.yml',
        ciWorkflow,
        Boolean(options.yes),
      )
    : false;
  if (
    modules.has('agents') &&
    !artifactIsEjected(tree, 'agents.instructions') &&
    !tree.exists('AGENTS.md')
  ) {
    tree.write(
      'AGENTS.md',
      `# Repository instructions\n\nRead ${docsRoot}/INDEX.md, accepted specs, decisions, and in-progress plans before changing the repository. Use Megamono generators instead of hand-rolling repository structure.\n`,
    );
  }
  const agentsPath = 'AGENTS.md';
  const agents = tree.read(agentsPath, 'utf8') ?? '';
  const agentsBody =
    '\n## Affected CI\n\nCI checks out full history and runs `nrwl/nx-set-shas@v5` before `nx affected`. Preserve that base/head convention when changing workflows so pull requests, merge queues, and default-branch runs compute the correct project set.\n';
  let agentsSectionCanUpdate = false;
  if (
    modules.has('agents') &&
    !artifactIsEjected(tree, 'agents.instructions') &&
    !artifactEntry(tree, 'agents.instructions') &&
    !agents.includes(AGENTS_SECTION_START)
  ) {
    if (agents.includes(LEGACY_AGENTS_MARKER)) {
      tree.write(
        agentsPath,
        `${agents.replace(LEGACY_AGENTS_MARKER, AGENTS_SECTION_START)}${agents.endsWith('\n') ? '' : '\n'}${AGENTS_SECTION_END}\n`,
      );
    } else {
      tree.write(
        agentsPath,
        `${agents}${agents.endsWith('\n') || agents.length === 0 ? '' : '\n'}\n${AGENTS_SECTION_START}${agentsBody}${AGENTS_SECTION_END}\n`,
      );
    }
    agentsSectionCanUpdate = true;
  } else if (
    modules.has('agents') &&
    !artifactIsEjected(tree, 'agents.instructions')
  ) {
    const current = artifactEntry(tree, 'agents.instructions');
    const section = extractManagedSection(
      agents,
      AGENTS_SECTION_START,
      AGENTS_SECTION_END,
    );
    if (current && section !== undefined) {
      if (hashArtifactBytes(section) === current.installedHash) {
        const start = agents.indexOf(AGENTS_SECTION_START);
        const bodyStart = start + AGENTS_SECTION_START.length;
        const end = agents.indexOf(AGENTS_SECTION_END, bodyStart);
        tree.write(
          agentsPath,
          `${agents.slice(0, bodyStart)}${agentsBody}${agents.slice(end)}`,
        );
        agentsSectionCanUpdate = true;
      } else {
        logger.warn(
          'Megamono artifact agents.instructions is modified; left its AGENTS.md section unchanged. Run workspace-eject to make it repository-owned.',
        );
      }
    }
  }
  if (
    modules.has('agents') &&
    !artifactIsEjected(tree, 'agents.claude-pointer') &&
    !tree.exists('CLAUDE.md')
  ) {
    tree.write('CLAUDE.md', '@AGENTS.md\n');
  }
  const pluginVersion = readPluginVersion();
  const developmentDependencies = {
    ...(modules.has('docs')
      ? {
          '@content-collections/core': '0.15.2',
          zod: '>=4.1 <5',
        }
      : {}),
    ...(modules.has('inference') && 'apple' in inference
      ? { '@megamono/nx-apple': pluginVersion }
      : {}),
    ...(modules.has('inference') && 'cargo' in inference
      ? { '@megamono/nx-cargo': pluginVersion }
      : {}),
  };
  const hasDependencies = Object.keys(developmentDependencies).length > 0;
  const installTask = hasDependencies
    ? addDependenciesToPackageJson(tree, {}, developmentDependencies)
    : () => undefined;
  await formatFiles(tree);

  registerFileArtifact(
    tree,
    {
      id: 'config.workspace',
      module: 'baseline',
      mode: 'seeded',
      target: 'megamono.json',
      ejectable: false,
      claimExisting: created.config,
    },
    pluginVersion,
  );
  registerFileArtifact(
    tree,
    {
      id: 'core.project',
      module: 'baseline',
      mode: 'managed',
      target: '.megamono/project.json',
      ejectable: false,
      claimExisting: created.project || Boolean(existingConfig),
      allowManagedUpdate: coreProjectCanUpdate,
    },
    pluginVersion,
  );
  if (modules.has('docs')) {
    registerFileArtifact(
      tree,
      {
        id: 'docs.loader',
        module: 'docs',
        mode: 'managed',
        target: 'content-collections.ts',
        ejectable: true,
        templateContent: docsLoaderTemplate,
        claimExisting: created.docsLoader,
        allowManagedUpdate: docsLoaderCanUpdate,
      },
      pluginVersion,
    );
    for (const [id, target, wasCreated] of [
      ['docs.index', `${docsRoot}/INDEX.md`, created.docsIndex],
      [
        'docs.archive-index',
        `${docsRoot}/archives/INDEX.md`,
        created.docsArchiveIndex,
      ],
    ] as const) {
      registerFileArtifact(
        tree,
        {
          id,
          module: 'docs',
          mode: 'derived',
          target,
          ejectable: false,
          claimExisting: wasCreated,
        },
        pluginVersion,
      );
    }
  }
  if (modules.has('agents')) {
    registerFileArtifact(
      tree,
      {
        id: 'agents.instructions',
        module: 'agents',
        mode: 'managed-section',
        target: 'AGENTS.md',
        ejectable: true,
        startDelimiter: AGENTS_SECTION_START,
        endDelimiter: AGENTS_SECTION_END,
        templateContent: agentsBody,
        claimExisting: agentsSectionCanUpdate,
        allowManagedUpdate: agentsSectionCanUpdate,
      },
      pluginVersion,
    );
    if (created.agents) {
      registerFileArtifact(
        tree,
        {
          id: 'agents.instructions-file',
          module: 'agents',
          mode: 'seeded',
          target: 'AGENTS.md',
          ejectable: false,
          claimExisting: true,
        },
        pluginVersion,
      );
    }
    if (created.claude) {
      registerFileArtifact(
        tree,
        {
          id: 'agents.claude-pointer',
          module: 'agents',
          mode: 'managed',
          target: 'CLAUDE.md',
          ejectable: true,
          templateContent: '@AGENTS.md\n',
          claimExisting: true,
        },
        pluginVersion,
      );
    }
    if (created.design) {
      registerFileArtifact(
        tree,
        {
          id: 'docs.design',
          module: 'agents',
          mode: 'seeded',
          target: `${docsRoot}/DESIGN.md`,
          ejectable: false,
          claimExisting: true,
        },
        pluginVersion,
      );
    }
  }
  if (modules.has('ci')) {
    registerFileArtifact(
      tree,
      {
        id: 'ci.affected',
        module: 'ci',
        mode: 'managed',
        target: '.github/workflows/megamono-ci.yml',
        ejectable: true,
        templateContent: ciWorkflow,
        claimExisting: created.ci,
        allowManagedUpdate: ciCanUpdate,
      },
      pluginVersion,
    );
  }
  if (modules.has('health') && config.health.cadence !== 'disabled') {
    registerFileArtifact(
      tree,
      {
        id: 'health.workflow',
        module: 'health',
        mode: 'managed',
        target: '.github/workflows/megamono-health.yml',
        ejectable: true,
        templateContent: healthWorkflow,
        claimExisting: created.health,
        allowManagedUpdate: healthCanUpdate,
      },
      pluginVersion,
    );
  }

  const completion = renderWorkspaceInitCompletion(adoptionPlan);
  logger.info(completion);
  if (options.report) tree.write(options.report, completion);

  const postFlushTasks = [
    ...(hasDependencies
      ? [
          {
            id: 'install-dependencies',
            retry: 'npm install',
            run: installTask,
          },
        ]
      : []),
  ];
  const externalCommands = createWorkspaceInitPostFlushCallback(
    tree.root,
    postFlushTasks,
  );
  return modules.has('skills')
    ? runTasksInSerial(
        externalCommands,
        linkSkillsCallback(tree.root, pluginVersion, Boolean(options.yes)),
      )
    : externalCommands;
}

export default workspaceInitGenerator;
