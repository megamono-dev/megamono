import {
  addDependenciesToPackageJson,
  addProjectConfiguration,
  createProjectGraphAsync,
  formatFiles,
  getProjects,
  logger,
  runTasksInSerial,
  updateProjectConfiguration,
  updateJson,
  type GeneratorCallback,
  type ProjectGraph,
  type Tree,
} from '@nx/devkit';
import { prompt } from 'enquirer';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADOPTION_STRUCTURAL_RULES,
  DEFAULT_MEGAMONO_CONFIG,
  assertSupportedMegamonoConfigVersion,
  isSafeWorkspaceRelativePath,
  megamonoConfigSchema,
} from '../../lib/config';
import { detectWebStyling } from '../../lib/web-styling';
import { planInferenceYalc } from '../../lib/inference-yalc';
import { checkWorkspaceStructure } from '../../lib/structural-check';
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
  parseRenderServiceProjects,
  parseWorkspaceInitModules,
  renderWorkspaceInitCompletion,
  renderWorkspaceInitPlan,
  renderWorkspaceInitSurvey,
  resolveWorkspaceDocsContract,
  surveyWorkspaceInit,
} from '../../lib/workspace-init-plan';
import {
  classifyProjectForAdoption,
  readProjectAdoptionResolutions,
} from '../../lib/project-adoption';
import {
  assessWorkspaceInitHostReadiness,
  assertWorkspaceInitPreflight,
  collectWorkspaceInitHostState,
} from '../../lib/workspace-init-preflight';
import { createWorkspaceInitPostFlushCallback } from '../../lib/workspace-init-execution';
import { ensureManagedSkillsProjection } from '../../lib/skills-projection';
import { nxWorkspaceCapabilities } from '../../lib/workspace-compatibility';
import {
  applyDocsAdoptionMap,
  readDocsAdoptionMap,
} from '../../lib/docs-adoption';
import {
  parsePackageRegistries,
  renderPackageRegistrySection,
} from '../../lib/package-sources';
import {
  lockfileManagers,
  packageManagerAdapter,
  type PackageManager,
} from '../../lib/package-manager';
import { workspaceInitDependencyAssessments } from '../../lib/dependency-compatibility';

const compatibility = JSON.parse(
  readFileSync(join(__dirname, '../../../compatibility.json'), 'utf8'),
) as {
  packageManagers: Record<PackageManager, string>;
};

function importTarget(tree: Tree) {
  return {
    executor: '@megamono/plugin:import',
    cache: false,
    ...(nxWorkspaceCapabilities(tree).targetParallelism
      ? { parallelism: false }
      : {}),
  };
}

const packagePolicyInputs = [
  ...(['npm', 'pnpm', 'yarn', 'bun'] as const).flatMap((manager) =>
    packageManagerAdapter(manager).lockfiles.map(
      (file) => `{workspaceRoot}/${file}`,
    ),
  ),
  '{workspaceRoot}/pnpm-workspace.yaml',
  '{workspaceRoot}/.npmrc',
  '{workspaceRoot}/.yarnrc.yml',
  '{workspaceRoot}/yalc.lock',
];

const healthTarget = {
  executor: '@megamono/plugin:health',
  cache: false,
  inputs: [
    '{workspaceRoot}/megamono.json',
    '{workspaceRoot}/.megamono/artifacts.json',
    '{workspaceRoot}/package.json',
    '{workspaceRoot}/package-lock.json',
    '{workspaceRoot}/pnpm-lock.yaml',
    '{workspaceRoot}/yarn.lock',
    '{workspaceRoot}/bun.lock',
    '{workspaceRoot}/bun.lockb',
    '{workspaceRoot}/nx.json',
    '{workspaceRoot}/docs/**/*.md',
    '{workspaceRoot}/**/package.json',
    '{workspaceRoot}/**/app.json',
    '{workspaceRoot}/**/Cargo.toml',
    '{workspaceRoot}/**/Package.swift',
    '{workspaceRoot}/**/wrangler.jsonc',
    '{workspaceRoot}/**/wrangler.json',
    '{workspaceRoot}/**/wrangler.toml',
    '{workspaceRoot}/**/.megamono-integration.json',
    '{workspaceRoot}/.agents/skills/**/*',
  ],
  outputs: ['{workspaceRoot}/.megamono/health.json'],
};

const verifyRuntimeTarget = {
  executor: '@megamono/plugin:verify-runtime',
  cache: false,
};

function ensureCheckInputs(tree: Tree): void {
  const project = getProjects(tree).get('megamono');
  const current = project?.targets?.check;
  if (!project || current?.executor !== '@megamono/plugin:check') return;
  const inputs = [
    ...new Set([...(current.inputs ?? ['default']), ...packagePolicyInputs]),
  ];
  // Keep custom targets, executor options, and existing input definitions intact.
  // CI selects a stricter package-source profile even without an explicit flag.
  if (
    !inputs.some(
      (input) =>
        typeof input === 'object' && 'env' in input && input.env === 'CI',
    )
  )
    inputs.push({ env: 'CI' });
  updateProjectConfiguration(tree, 'megamono', {
    ...project,
    targets: { ...project.targets, check: { ...current, inputs } },
  });
}

const verifyDependenciesTarget = {
  executor: '@megamono/plugin:verify-workspace-dependencies',
  cache: false,
};

const verifyContainerTarget = {
  executor: '@megamono/plugin:verify-container',
  cache: false,
};

const AGENTS_SECTION_START = '<!-- megamono instructions start -->';
const AGENTS_SECTION_END = '<!-- megamono instructions end -->';
const LEGACY_AGENTS_MARKER = '<!-- megamono affected CI -->';
const IGNORE_SECTION_START = '# megamono ignore entries start';
const IGNORE_SECTION_END = '# megamono ignore entries end';
const REGISTRY_SECTION_START = '# megamono package registries start';
const REGISTRY_SECTION_END = '# megamono package registries end';
const ESLINT_IMPORTS_START = '// megamono eslint imports start';
const ESLINT_IMPORTS_END = '// megamono eslint imports end';
const ESLINT_RULES_START = '  // megamono eslint rules start';
const ESLINT_RULES_END = '  // megamono eslint rules end';
const LEGACY_ESLINT_IMPORTS_MARKER = '// megamono eslint imports';
const LEGACY_ESLINT_RULES_MARKER = '// megamono eslint rules';
const ESLINT_IMPORTS_BODY = `
import megamonoConfig from './megamono.json' with { type: 'json' };
import megamonoPlugin from '@megamono/plugin/eslint';
`;
const ESLINT_RULES_BODY = `
  megamonoPlugin.createConfig(megamonoConfig),
`;
const SUPPORTED_PLATFORMS = new Set([
  'web',
  'node',
  'worker',
  'mobile',
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

function inferenceDependencyVersion(
  tree: Tree,
  name: string,
  version: string,
): string {
  const localAddress = `file:.yalc/${name}`;
  try {
    const rootManifest = JSON.parse(
      tree.read('package.json', 'utf8') ?? '{}',
    ) as {
      devDependencies?: Record<string, unknown>;
    };
    if (rootManifest.devDependencies?.[name] !== localAddress) return version;
    const localManifest = JSON.parse(
      tree.read(`.yalc/${name}/package.json`, 'utf8') ?? '{}',
    ) as { name?: unknown; version?: unknown };
    return localManifest.name === name && localManifest.version === version
      ? localAddress
      : version;
  } catch {
    return version;
  }
}

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

function applyManagedSectionTemplate(
  tree: Tree,
  id: string,
  target: string,
  template: string,
  startDelimiter: string,
  endDelimiter: string,
): boolean {
  const current = artifactEntry(tree, id);
  if (current?.state === 'ejected') return false;
  const source = tree.read(target, 'utf8') ?? '';
  const section = extractManagedSection(source, startDelimiter, endDelimiter);
  if (!current) {
    if (section !== undefined) {
      logger.warn(
        `${target} contains unregistered Megamono delimiters; left it unchanged.`,
      );
      return false;
    }
    const separator = source.length === 0 || source.endsWith('\n') ? '' : '\n';
    tree.write(
      target,
      `${source}${separator}${startDelimiter}${template}${endDelimiter}\n`,
    );
    return true;
  }
  if (
    section === undefined ||
    hashArtifactBytes(section) !== current.installedHash
  ) {
    logger.warn(
      `Megamono artifact ${id} is modified; left its ${target} section unchanged. Run workspace-eject to make it repository-owned.`,
    );
    return false;
  }
  const start = source.indexOf(startDelimiter);
  const bodyStart = start + startDelimiter.length;
  const end = source.indexOf(endDelimiter, bodyStart);
  const updated = `${source.slice(0, bodyStart)}${template}${source.slice(end)}`;
  if (updated !== source) tree.write(target, updated);
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
  const expected = importTarget(tree);
  if (current) {
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error(
        'megamono:import already exists with a different configuration.',
      );
    }
    return false;
  }
  updateProjectConfiguration(tree, 'megamono', {
    ...project,
    targets: { ...project.targets, import: expected },
  });
  return true;
}

function ensureVerifyRuntimeTarget(tree: Tree): boolean {
  const project = getProjects(tree).get('megamono');
  if (!project) {
    throw new Error(
      'Workspace initialization is incomplete; missing the megamono project.',
    );
  }
  const current = project.targets?.['verify-runtime'];
  if (current) {
    if (JSON.stringify(current) !== JSON.stringify(verifyRuntimeTarget)) {
      throw new Error(
        'megamono:verify-runtime already exists with a different configuration.',
      );
    }
    return false;
  }
  updateProjectConfiguration(tree, 'megamono', {
    ...project,
    targets: {
      ...project.targets,
      'verify-runtime': verifyRuntimeTarget,
    },
  });
  return true;
}

function ensureVerifyDependenciesTarget(tree: Tree): boolean {
  const project = getProjects(tree).get('megamono');
  if (!project) {
    throw new Error(
      'Workspace initialization is incomplete; missing the megamono project.',
    );
  }
  const current = project.targets?.['verify-dependencies'];
  if (current) {
    if (JSON.stringify(current) !== JSON.stringify(verifyDependenciesTarget)) {
      throw new Error(
        'megamono:verify-dependencies already exists with a different configuration.',
      );
    }
    return false;
  }
  updateProjectConfiguration(tree, 'megamono', {
    ...project,
    targets: {
      ...project.targets,
      'verify-dependencies': verifyDependenciesTarget,
    },
  });
  return true;
}

function ensureVerifyContainerTarget(tree: Tree): boolean {
  const project = getProjects(tree).get('megamono');
  if (!project) {
    throw new Error(
      'Workspace initialization is incomplete; missing the megamono project.',
    );
  }
  const current = project.targets?.['verify-container'];
  if (current) {
    if (JSON.stringify(current) !== JSON.stringify(verifyContainerTarget)) {
      throw new Error(
        'megamono:verify-container already exists with a different configuration.',
      );
    }
    return false;
  }
  updateProjectConfiguration(tree, 'megamono', {
    ...project,
    targets: {
      ...project.targets,
      'verify-container': verifyContainerTarget,
    },
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

function renderHealthWorkflow(
  cadence: 'weekly' | 'daily',
  target: 'megamono:health' | 'megamono-docs:health',
  packageManager: PackageManager,
  toolchain: WorkflowToolchain,
): string {
  const cron = cadence === 'daily' ? '17 9 * * *' : '17 9 * * 1';
  const packageManagerSetup = renderPackageManagerSetup(
    packageManager,
    toolchain,
  );
  const adapter = packageManagerAdapter(packageManager);
  const install = frozenInstall(packageManager, toolchain);
  const nx = adapter.nx;
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
${packageManagerSetup}
      - run: ${install}
      - run: ${nx} run ${target}
      - uses: actions/github-script@v8
        with:
          script: |
            const fs = require('node:fs');
            const { publishHealthIssue } = require('@megamono/plugin');
            const report = JSON.parse(fs.readFileSync('.megamono/health.json', 'utf8'));
            await publishHealthIssue({ github, context, core, report });
`;
}

interface WorkflowToolchain {
  readonly node: string;
  readonly packageManagerVersion?: string;
}

interface ReleaseProject {
  readonly name: string;
  readonly outputPath: string;
}

function releaseProjects(tree: Tree): readonly ReleaseProject[] {
  return [...getProjects(tree).entries()]
    .flatMap(([name, project]) => {
      const manifestPath =
        project.root === '.' ? 'package.json' : `${project.root}/package.json`;
      let manifest: { name?: unknown; private?: unknown };
      try {
        manifest = JSON.parse(tree.read(manifestPath, 'utf8') ?? '{}');
      } catch {
        return [];
      }
      if (
        project.projectType !== 'library' ||
        typeof manifest.name !== 'string' ||
        manifest.private === true
      ) {
        return [];
      }
      const configuredOutput = project.targets?.build?.options?.outputPath;
      const outputPath =
        typeof configuredOutput === 'string'
          ? configuredOutput
          : `dist/${project.root}`;
      return [{ name, outputPath }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function renderYalcPublisher(
  projects: readonly ReleaseProject[],
  packageManager: PackageManager,
): string {
  const managerArgs: Readonly<Record<PackageManager, readonly string[]>> = {
    npm: ['exec', 'nx', '--', 'run-many', '-t', 'build', '-p'],
    pnpm: ['exec', 'nx', 'run-many', '-t', 'build', '-p'],
    yarn: ['nx', 'run-many', '-t', 'build', '-p'],
    bun: ['x', 'nx', 'run-many', '-t', 'build', '-p'],
  };
  return `#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageManager = process.platform === 'win32' ? '${packageManager}.cmd' : '${packageManager}';
const yalc = process.platform === 'win32' ? 'yalc.cmd' : 'yalc';
const projects = ${JSON.stringify(projects, null, 2)};

function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NX_DAEMON: 'false' },
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', (error) => reject(new Error(\`Unable to run \${command}: \${error.message}\`)));
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(\`\${command} \${args.join(' ')} \${code === null ? \`stopped after signal \${signal ?? 'unknown'}\` : \`exited with code \${code}\`}\`));
    });
  });
}

try {
  await run(yalc, ['--version']);
  await run(packageManager, [...${JSON.stringify(managerArgs[packageManager])}, ...projects.map(({ name }) => name), '--output-style=static']);
  for (const { name, outputPath } of projects) {
    const directory = join(root, outputPath);
    await access(join(directory, 'package.json'));
    process.stdout.write(\`\\nPublishing \${name} from \${outputPath} to yalc...\\n\`);
    await run(yalc, ['publish'], directory);
  }
} catch (error) {
  process.stderr.write(\`\${error instanceof Error ? error.message : String(error)}\\n\`);
  process.exitCode = 1;
}
`;
}

function renderReleaseWorkflow(
  projects: readonly ReleaseProject[],
  packageManager: PackageManager,
  toolchain: WorkflowToolchain,
): string {
  const packageManagerSetup = renderPackageManagerSetup(
    packageManager,
    toolchain,
  );
  const adapter = packageManagerAdapter(packageManager);
  const install = frozenInstall(packageManager, toolchain);
  const nx = adapter.nx;
  const projectSelection = projects.map(({ name }) => name).join(',');
  return `name: Megamono package prerelease

on:
  workflow_dispatch:
    inputs:
      specifier:
        description: Semver keyword or exact version
        required: true
        default: prerelease
        type: string
      preid:
        description: Prerelease identifier
        required: true
        default: next
        type: string

permissions:
  contents: write

jobs:
  prerelease:
    runs-on: ubuntu-latest
    environment: npm-next
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
${packageManagerSetup}
      - run: ${install}
      - run: ${nx} run-many -t lint test build -p ${projectSelection} --output-style=static
      - name: Preview version changes
        run: ${nx} release version "\${{ inputs.specifier }}" --preid "\${{ inputs.preid }}" --dry-run
      - name: Version packages
        run: ${nx} release version "\${{ inputs.specifier }}" --preid "\${{ inputs.preid }}" --git-commit --git-tag
      - name: Publish next prerelease
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
        run: ${nx} release publish --tag next
      - run: git push --follow-tags origin HEAD
`;
}

function workflowToolchain(
  tree: Tree,
  packageManager: PackageManager,
): WorkflowToolchain {
  let manifest: {
    packageManager?: unknown;
    engines?: { node?: unknown };
  } = {};
  try {
    manifest = JSON.parse(tree.read('package.json', 'utf8') ?? '{}');
  } catch {
    // Preflight owns the structured invalid-manifest diagnostic.
  }
  const configuredNode =
    tree.read('.node-version', 'utf8')?.trim() ||
    tree.read('.nvmrc', 'utf8')?.trim() ||
    (typeof manifest.engines?.node === 'string'
      ? manifest.engines.node
      : undefined);
  const nxMajor = nxWorkspaceCapabilities(tree).major;
  const defaultNode = nxMajor >= 23 ? '24' : nxMajor >= 21 ? '22' : '20';
  const declaredManager =
    typeof manifest.packageManager === 'string'
      ? manifest.packageManager.split('@')[1]
      : undefined;
  const inferredYarnVersion =
    packageManager === 'yarn' &&
    /(?:^|\n)# yarn lockfile v1(?:\n|$)/.test(
      tree.read('yarn.lock', 'utf8') ?? '',
    )
      ? '1.22.22'
      : undefined;
  return {
    node: configuredNode ?? defaultNode,
    packageManagerVersion:
      declaredManager ??
      inferredYarnVersion ??
      compatibility.packageManagers[packageManager],
  };
}

function frozenInstall(
  packageManager: PackageManager,
  toolchain: WorkflowToolchain,
): string {
  if (
    packageManager === 'yarn' &&
    toolchain.packageManagerVersion?.startsWith('1.')
  ) {
    return 'yarn install --frozen-lockfile';
  }
  return packageManagerAdapter(packageManager).frozenInstall;
}

function renderPackageManagerSetup(
  packageManager: PackageManager,
  toolchain: WorkflowToolchain,
): string {
  const pnpmSetup =
    packageManager === 'pnpm'
      ? `      - uses: pnpm/action-setup@v4
        with:
          version: ${toolchain.packageManagerVersion}
`
      : '';
  const bunSetup =
    packageManager === 'bun'
      ? `      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${toolchain.packageManagerVersion}
`
      : '';
  const nodeVersion = /^\d+\.\d+\.\d+$/.test(toolchain.node)
    ? toolchain.node
    : `'${toolchain.node.replaceAll("'", "''")}'`;
  const yarnSetup =
    packageManager === 'yarn' ? '\n      - run: corepack enable' : '';
  const cache =
    packageManager === 'bun' ? '' : `\n          cache: ${packageManager}`;
  return `${pnpmSetup}${bunSetup}      - uses: actions/setup-node@v5
        with:
          node-version: ${nodeVersion}${cache}${yarnSetup}`;
}

function renderCiWorkflow(
  platforms: ReadonlySet<string>,
  packageManager: PackageManager,
  toolchain: WorkflowToolchain,
  includeDocs: boolean,
  reusable = false,
): string {
  const linuxPlatforms = [
    'web',
    'node',
    'worker',
    'mobile',
    'rust',
    'php',
    'extension',
  ];
  const hasLinux = linuxPlatforms.some((platform) => platforms.has(platform));
  const hasApple = platforms.has('apple');
  const gh = (expression: string) => '${{ ' + expression + ' }}';
  const packageManagerSetup = renderPackageManagerSetup(
    packageManager,
    toolchain,
  );
  const adapter = packageManagerAdapter(packageManager);
  const install = frozenInstall(packageManager, toolchain);
  const nx = adapter.nx;
  const trigger = reusable
    ? '  workflow_call:'
    : '  push:\n    branches: [main]\n  pull_request:\n  merge_group:';
  const planChecks = [
    ...(hasLinux
      ? [
          `          if [ -n "$(${nx} show projects --affected --exclude=tag:platform:apple)" ]; then
            echo "linux=true" >> "$GITHUB_OUTPUT"
          else
            echo "linux=false" >> "$GITHUB_OUTPUT"
          fi`,
        ]
      : []),
    ...(hasApple
      ? [
          `          if [ -n "$(${nx} show projects --affected${hasLinux ? ' --projects=tag:platform:apple' : ''})" ]; then
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
${packageManagerSetup}
${platforms.has('rust') ? '      - uses: dtolnay/rust-toolchain@stable\n' : ''}${platforms.has('php') ? '      - uses: shivammathur/setup-php@v2\n        with:\n          php-version: 8.4\n' : ''}      - run: ${install}
${includeDocs ? `      - run: ${nx} run megamono-docs:validate --output-style=static\n` : ''}
      - run: ${nx} affected -t lint test build --exclude=tag:platform:apple --output-style=static`,
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
${packageManagerSetup}
      - run: ${install}
${includeDocs ? `      - run: ${nx} run megamono-docs:validate --output-style=static\n` : ''}
      - run: xcodebuild -downloadComponent MetalToolchain
      - run: ${nx} affected -t lint test build${hasLinux ? " --exclude='*,!tag:platform:apple'" : ''} --output-style=static`,
        ]
      : []),
  ].join('\n\n');
  return `name: ${reusable ? 'Megamono reusable CI' : 'CI'}

on:
${trigger}

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
${packageManagerSetup}
      - run: ${install}
      - uses: nrwl/nx-set-shas@v5
      - run: ${nx} run megamono:check --ci --output-style=static
      - id: affected
        shell: bash
        run: |
${planChecks}
          echo "base=$NX_BASE" >> "$GITHUB_OUTPUT"
          echo "head=$NX_HEAD" >> "$GITHUB_OUTPUT"

${jobs}
`;
}

interface EslintWiringResult {
  readonly imports: boolean;
  readonly rules: boolean;
}

function wireEslintConfig(tree: Tree): EslintWiringResult {
  const path = 'eslint.config.mjs';
  let current = tree.read(path, 'utf8') ?? 'export default [\n];\n';
  if (!tree.exists(path)) tree.write(path, current);
  let migratedImports = false;
  let migratedRules = false;
  const legacyImports = `${LEGACY_ESLINT_IMPORTS_MARKER}${ESLINT_IMPORTS_BODY}`;
  const legacyRules = `  ${LEGACY_ESLINT_RULES_MARKER}${ESLINT_RULES_BODY}`;
  if (current.includes(legacyImports) && current.includes(legacyRules)) {
    current = current
      .replace(
        legacyImports,
        `${ESLINT_IMPORTS_START}${ESLINT_IMPORTS_BODY}${ESLINT_IMPORTS_END}\n`,
      )
      .replace(
        legacyRules,
        `${ESLINT_RULES_START}${ESLINT_RULES_BODY}${ESLINT_RULES_END}\n`,
      );
    tree.write(path, current);
    migratedImports = true;
    migratedRules = true;
  }
  const ensureImports = (): boolean => {
    if (artifactIsEjected(tree, 'lint.eslint-imports')) return false;
    const registered = artifactEntry(tree, 'lint.eslint-imports');
    const source = tree.read(path, 'utf8') ?? '';
    if (source.includes(ESLINT_IMPORTS_START)) {
      if (!registered) return migratedImports;
      return applyManagedSectionTemplate(
        tree,
        'lint.eslint-imports',
        path,
        ESLINT_IMPORTS_BODY,
        ESLINT_IMPORTS_START,
        ESLINT_IMPORTS_END,
      );
    }
    if (!registered && source.includes(ESLINT_IMPORTS_BODY.trim())) {
      return false;
    }
    tree.write(
      path,
      `${ESLINT_IMPORTS_START}${ESLINT_IMPORTS_BODY}${ESLINT_IMPORTS_END}\n\n${source}`,
    );
    return true;
  };
  const ensureRules = (): boolean => {
    if (artifactIsEjected(tree, 'lint.eslint-rules')) return false;
    const registered = artifactEntry(tree, 'lint.eslint-rules');
    const source = tree.read(path, 'utf8') ?? '';
    if (source.includes(ESLINT_RULES_START)) {
      if (!registered) return migratedRules;
      return applyManagedSectionTemplate(
        tree,
        'lint.eslint-rules',
        path,
        ESLINT_RULES_BODY,
        ESLINT_RULES_START,
        ESLINT_RULES_END,
      );
    }
    if (!registered && source.includes(ESLINT_RULES_BODY.trim())) return false;
    const closing = source.lastIndexOf('];');
    if (!source.includes('export default [') || closing < 0) {
      throw new WorkspaceInitError(
        'conflict',
        'eslint.config.mjs must export a flat config array before workspace-init can wire Megamono rules.',
      );
    }
    const beforeClosing = source.slice(0, closing).trimEnd();
    const separator =
      beforeClosing.endsWith('[') || beforeClosing.endsWith(',') ? '' : ',';
    tree.write(
      path,
      `${beforeClosing}${separator}\n${ESLINT_RULES_START}${ESLINT_RULES_BODY}${ESLINT_RULES_END}\n${source.slice(closing)}`,
    );
    return true;
  };
  const imports = ensureImports();
  const rules = ensureRules();
  return { imports, rules };
}

function delimiterCount(source: string, delimiter: string): number {
  return source.split(delimiter).length - 1;
}

function preflightEslintConfig(tree: Tree): void {
  const current = tree.read('eslint.config.mjs', 'utf8');
  if (!current) return;
  for (const [id, start, end] of [
    ['lint.eslint-imports', ESLINT_IMPORTS_START, ESLINT_IMPORTS_END],
    ['lint.eslint-rules', ESLINT_RULES_START, ESLINT_RULES_END],
  ] as const) {
    if (artifactIsEjected(tree, id)) continue;
    const starts = delimiterCount(current, start);
    const ends = delimiterCount(current, end);
    if (starts !== ends || starts > 1) {
      throw new WorkspaceInitError(
        'conflict',
        `eslint.config.mjs contains malformed ownership delimiters for ${id}.`,
      );
    }
    if (starts === 1 && !artifactEntry(tree, id)) {
      throw new WorkspaceInitError(
        'conflict',
        `eslint.config.mjs contains unregistered ownership delimiters for ${id}.`,
      );
    }
  }
  const lines = current.split('\n').map((line) => line.trim());
  const legacyImports = lines.includes(LEGACY_ESLINT_IMPORTS_MARKER);
  const legacyRules = lines.includes(LEGACY_ESLINT_RULES_MARKER);
  if (legacyImports !== legacyRules) {
    throw new WorkspaceInitError(
      'conflict',
      'eslint.config.mjs contains a partial legacy Megamono ESLint configuration.',
    );
  }
  const repositoryImports = current.includes(ESLINT_IMPORTS_BODY.trim());
  const repositoryRules = current.includes(ESLINT_RULES_BODY.trim());
  const hasRegisteredWiring = Boolean(
    artifactEntry(tree, 'lint.eslint-imports') ||
    artifactEntry(tree, 'lint.eslint-rules'),
  );
  if (
    repositoryImports !== repositoryRules &&
    !legacyImports &&
    !hasRegisteredWiring
  ) {
    throw new WorkspaceInitError(
      'conflict',
      'eslint.config.mjs contains partial repository-owned Megamono ESLint wiring.',
    );
  }
  if (
    !legacyImports &&
    !repositoryRules &&
    (!current.includes('export default [') || current.lastIndexOf('];') < 0)
  ) {
    throw new WorkspaceInitError(
      'conflict',
      'eslint.config.mjs must export a flat config array before workspace-init can wire Megamono rules.',
    );
  }
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

function parseConfiguredPorts(
  source?: string,
): Readonly<Record<string, number>> {
  if (!source) return {};
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error('ports must be a valid JSON object.', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ports must be a JSON object.');
  }
  const ports = value as Record<string, unknown>;
  const invalid = Object.entries(ports).filter(
    ([name, port]) =>
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      !Number.isInteger(port) ||
      (port as number) < 1024 ||
      (port as number) > 65535,
  );
  if (
    invalid.length > 0 ||
    new Set(Object.values(ports)).size !== Object.keys(ports).length
  ) {
    throw new Error(
      'ports must contain unique application ports from 1024 through 65535.',
    );
  }
  return ports as Record<string, number>;
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

function docsProjectConfiguration(
  docsRoot: string,
  includeHealth: boolean,
  docsLoader = 'content-collections.ts',
  docsOutput = '.content-collections',
) {
  return {
    root: docsRoot,
    projectType: 'library' as const,
    tags: ['type:util', 'scope:shared', 'platform:node'],
    targets: {
      validate: {
        executor: '@megamono/plugin:docs-validate',
        cache: false,
        inputs: [
          '{workspaceRoot}/megamono.json',
          `{workspaceRoot}/${docsLoader}`,
          `{workspaceRoot}/${docsRoot}/**/*.md`,
        ],
        outputs: [`{workspaceRoot}/${docsOutput}`],
        options: { contentConfig: docsLoader, outputDir: docsOutput },
      },
      index: { executor: '@megamono/plugin:docs-index', cache: false },
      archive: { executor: '@megamono/plugin:docs-archive', cache: false },
      'prune-reports': {
        executor: '@megamono/plugin:docs-prune-reports',
        cache: false,
      },
      ...(includeHealth ? { health: healthTarget } : {}),
    },
  };
}

function projectGraphFromTree(
  tree: Tree,
  resolutions = readProjectAdoptionResolutions(tree),
  defaultPlatform?: WorkspaceInitGeneratorSchema['defaultPlatform'],
): ProjectGraph {
  const projects = getProjects(tree);
  return {
    nodes: Object.fromEntries(
      [...projects.entries()].map(([name, project]) => {
        const classification = classifyProjectForAdoption(
          tree,
          name,
          project,
          resolutions,
          defaultPlatform,
          projects,
        );
        return [
          name,
          {
            name,
            type: classification.kind === 'application' ? 'app' : 'lib',
            data: project,
          },
        ];
      }),
    ),
    dependencies: Object.fromEntries(
      [...projects.keys()].map((name) => [name, []]),
    ),
  };
}

export async function workspaceInitGenerator(
  tree: Tree,
  options: WorkspaceInitGeneratorSchema,
): Promise<GeneratorCallback> {
  const outputFormat = options.format ?? 'markdown';
  const hostState =
    tree.root === '/virtual'
      ? undefined
      : await collectWorkspaceInitHostState(tree.root);
  const initialSurvey = surveyWorkspaceInit(tree, {
    adoptionMap: options.adoptionMap,
    defaultPlatform: options.defaultPlatform,
    ...(hostState
      ? {
          host: assessWorkspaceInitHostReadiness(tree, hostState, {
            packageManager: options.packageManager,
          }),
        }
      : {}),
  });
  const declaredPackageManager =
    initialSurvey.baseline.packageManager?.split('@')[0];
  if (
    options.packageManager &&
    declaredPackageManager &&
    declaredPackageManager !== options.packageManager
  ) {
    throw new WorkspaceInitError(
      'options',
      `Requested ${options.packageManager}, but package.json declares ${initialSurvey.baseline.packageManager}.`,
    );
  }
  const detectedManagers = lockfileManagers((path) => tree.exists(path));
  const inferredManager =
    detectedManagers[0] ??
    (declaredPackageManager as PackageManager | undefined);
  const packageManager = options.packageManager ?? inferredManager ?? 'npm';
  if (options.survey) {
    const report = renderWorkspaceInitSurvey(initialSurvey, outputFormat);
    const outputFile = process.env.MEGAMONO_SURVEY_OUTPUT_FILE;
    if (outputFormat === 'json' && outputFile) {
      // CLI-owned private handoff: Nx may exit before its stdout pipe drains.
      // Exclusive creation prevents overwriting a pre-existing user file.
      writeFileSync(outputFile, report, { encoding: 'utf8', flag: 'wx' });
    } else logger.info(report);
    return () => undefined;
  }
  if (
    tree.root !== '/virtual' &&
    !options.dryRun &&
    process.env.NX_DRY_RUN !== 'true'
  ) {
    assertWorkspaceInitPreflight(
      tree,
      hostState ?? (await collectWorkspaceInitHostState(tree.root)),
      { bootstrap: options.bootstrap, packageManager },
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
  const workspaceSurvey = initialSurvey;
  logger.info(renderWorkspaceInitSurvey(workspaceSurvey, outputFormat));
  let only = options.only;
  if (only && options.profile) {
    throw new WorkspaceInitError(
      'options',
      'Select either --only or --profile, not both.',
    );
  }
  if (!only && options.profile) {
    only = parseWorkspaceInitModules(undefined, options.profile).join(',');
  }
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
  const lintCanWire =
    !requestedModules.includes('lint') ||
    workspaceSurvey.existing.eslint.some((path) =>
      path.startsWith('eslint.config.'),
    ) ||
    !workspaceSurvey.existing.eslint.some((path) =>
      path.startsWith('.eslintrc'),
    );
  let defaultPlatform = options.defaultPlatform;
  let adoptionPlan = createWorkspaceInitPlan(tree, {
    ...options,
    yes: false,
    only: requestedModules,
    profile: undefined,
    defaultPlatform,
    packageManager,
    host: initialSurvey.host,
  });
  if (
    adoptionPlan.decisions.length > 0 &&
    !defaultPlatform &&
    adoptionPlan.decisions.every((decision) =>
      decision.startsWith('defaultPlatform is required'),
    )
  ) {
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
      profile: undefined,
      defaultPlatform,
      packageManager,
      host: initialSurvey.host,
    });
  }
  if (adoptionPlan.decisions.length > 0) {
    throw new WorkspaceInitError(
      'decision-required',
      adoptionPlan.decisions.join(' '),
    );
  }
  if (adoptionPlan.conflicts.length > 0) {
    throw new WorkspaceInitError('conflict', adoptionPlan.conflicts.join(' '));
  }
  if (requestedModules.includes('lint') && lintCanWire)
    preflightEslintConfig(tree);
  logger.info(renderWorkspaceInitPlan(adoptionPlan, outputFormat));
  const inferenceNames =
    requestedModules.includes('inference') &&
    nxWorkspaceCapabilities(tree).major >= 18
      ? Object.entries(workspaceSurvey.manifests)
          .filter(
            ([platform, paths]) =>
              platform !== 'unsupported' && paths.length > 0,
          )
          .map(([platform]) => `@megamono/nx-${platform}`)
      : [];
  const localInference =
    options.localPackages === 'yalc' && inferenceNames.length
      ? planInferenceYalc(inferenceNames, readPluginVersion(), tree.root)
      : undefined;
  if (localInference)
    logger.info(
      JSON.stringify(
        {
          kind: 'yalc-inference-plan',
          packages: localInference.packages,
          dependencies: localInference.dependencies,
          install:
            'Yalc add and package-manager install run only after approved generator writes.',
        },
        null,
        2,
      ),
    );
  if (options.dryRun || process.env.NX_DRY_RUN === 'true') {
    return () => undefined;
  }
  if (!options.yes) {
    if (!canPrompt(options)) {
      throw new WorkspaceInitError(
        'decision-required',
        'Preview confirmation is required; rerun interactively or pass --yes.',
      );
    }
    if (!(await promptForConfirmation())) return () => undefined;
  }
  const planConfirmed = true;
  const modules = new Set(requestedModules);
  const docsAdoptionEntries = modules.has('docs')
    ? readDocsAdoptionMap(tree, options.docsAdoptionMap)
    : [];
  const ciMode = options.ciMode ?? 'auto';
  const equivalentCi = workspaceSurvey.recommendations.find(
    (recommendation) => recommendation.module === 'ci',
  );
  const ciShouldGenerate =
    modules.has('ci') && !(ciMode === 'auto' && equivalentCi);
  const ciTarget =
    ciMode === 'reusable'
      ? '.github/workflows/megamono-ci-reusable.yml'
      : '.github/workflows/megamono-ci.yml';
  const configuredReleaseProjects = modules.has('release')
    ? releaseProjects(tree)
    : [];
  const requestedPlatforms = parseConfiguredPlatforms(options.platforms);
  const configuredPorts = parseConfiguredPorts(options.ports);
  const serviceRequirements = parseServiceRequirements(
    options.serviceRequirements,
  );
  const packageRegistries =
    options.packageRegistries !== undefined
      ? parsePackageRegistries(options.packageRegistries)
      : (existingConfig?.packageSources.registries ?? {});
  const docsContract = resolveWorkspaceDocsContract(tree, options);
  const docsRoot = docsContract.root;
  const docsStructureArtifacts = [
    ['docs.structure.specs', `${docsRoot}/specs/.gitkeep`],
    ['docs.structure.plans', `${docsRoot}/plans/.gitkeep`],
    ['docs.structure.decisions', `${docsRoot}/decisions/.gitkeep`],
    ['docs.structure.audits', `${docsRoot}/audits/.gitkeep`],
    ['docs.structure.research', `${docsRoot}/research/.gitkeep`],
    ['docs.structure.reports', `${docsRoot}/reports/.gitkeep`],
    ['docs.structure.archives-specs', `${docsRoot}/archives/specs/.gitkeep`],
    ['docs.structure.archives-plans', `${docsRoot}/archives/plans/.gitkeep`],
    [
      'docs.structure.archives-research',
      `${docsRoot}/archives/research/.gitkeep`,
    ],
  ] as const;
  if (options.report && !isSafeWorkspaceRelativePath(options.report)) {
    throw new WorkspaceInitError(
      'options',
      'report must be a safe workspace-relative path.',
    );
  }
  const created = {
    config: !tree.exists('megamono.json'),
    project: !tree.exists('.megamono/project.json'),
    docsProject: !tree.exists(`${docsRoot}/project.json`),
    docsLoader:
      docsContract.loaderMode === 'create' && !tree.exists(docsContract.loader),
    docsIndex: !tree.exists(`${docsRoot}/INDEX.md`),
    docsArchiveIndex: !tree.exists(`${docsRoot}/archives/INDEX.md`),
    design: !tree.exists(`${docsRoot}/DESIGN.md`),
    eslint: lintCanWire && !tree.exists('eslint.config.mjs'),
    agents: !tree.exists('AGENTS.md'),
    claude: !tree.exists('CLAUDE.md'),
    ci: ciShouldGenerate && !tree.exists(ciTarget),
    releaseWorkflow: !tree.exists('.github/workflows/megamono-release.yml'),
    yalcPublisher: !tree.exists('.megamono/publish-yalc.mjs'),
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
    docsContract.loaderMode === 'create' &&
    tree.exists(docsContract.loader)
  ) {
    throw new Error(
      `${docsContract.loader} already exists. Adopt a compatible loader or select separate docs loader/module/output paths before running workspace-init.`,
    );
  }
  for (const [path, enabled] of [
    [ciTarget, ciShouldGenerate],
    ['.github/workflows/megamono-health.yml', modules.has('health')],
  ] as const) {
    if (!existingConfig && enabled && tree.exists(path)) {
      throw new Error(
        `${path} already exists without Megamono ownership metadata.`,
      );
    }
  }
  if (modules.has('release') && configuredReleaseProjects.length > 0) {
    for (const [id, path] of [
      ['release.workflow', '.github/workflows/megamono-release.yml'],
      ['release.yalc-publisher', '.megamono/publish-yalc.mjs'],
    ] as const) {
      if (!existingConfig && tree.exists(path) && !artifactEntry(tree, id)) {
        throw new Error(
          `${path} already exists without Megamono ownership metadata.`,
        );
      }
    }
    try {
      const manifest = JSON.parse(
        tree.read('package.json', 'utf8') ?? '{}',
      ) as { scripts?: Record<string, unknown> };
      const current = manifest.scripts?.['megamono:yalc-publish'];
      if (
        current !== undefined &&
        current !== 'node .megamono/publish-yalc.mjs'
      ) {
        throw new Error(
          'package.json script megamono:yalc-publish is already repository-owned with a different command.',
        );
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('package.json is not valid JSON.', { cause: error });
      }
      throw error;
    }
  }
  const defaultScope = options.defaultScope ?? 'shared';
  const projects = getProjects(tree);
  const lintAdoptionRatchets: Array<{
    readonly rule: (typeof ADOPTION_STRUCTURAL_RULES)[number];
    readonly initialCount: number;
    readonly targetSeverity: 'error';
  }> = [];
  if (
    modules.has('lint') &&
    !options.bootstrap &&
    !existingConfig?.adoption.modules.includes('lint')
  ) {
    const graph =
      tree.root === '/virtual'
        ? projectGraphFromTree(
            tree,
            readProjectAdoptionResolutions(tree, options.adoptionMap),
            defaultPlatform,
          )
        : await createProjectGraphAsync({ exitOnError: false });
    const diagnostics = await checkWorkspaceStructure(
      tree.root,
      graph,
      existingConfig ?? DEFAULT_MEGAMONO_CONFIG,
    );
    for (const rule of ADOPTION_STRUCTURAL_RULES) {
      lintAdoptionRatchets.push({
        rule,
        initialCount: diagnostics.filter(({ code }) => code === rule).length,
        targetSeverity: 'error',
      });
    }
  }
  const configuredPlatforms = new Set<string>();
  const adoptionResolutions = readProjectAdoptionResolutions(
    tree,
    options.adoptionMap,
  );
  const projectClassifications = new Map(
    [...projects.entries()].map(([name, project]) => [
      name,
      classifyProjectForAdoption(
        tree,
        name,
        project,
        adoptionResolutions,
        defaultPlatform,
        projects,
      ),
    ]),
  );
  const isApplication = (name: string) =>
    projectClassifications.get(name)?.kind === 'application';
  const projectsNeedingPlatform = [...projects.entries()].filter(
    ([name, project]) =>
      name !== 'megamono' &&
      name !== 'megamono-docs' &&
      isApplication(name) &&
      !projectClassifications.get(name)?.platform &&
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
      tags.add(
        `type:${
          projectClassifications.get(name)?.type ??
          (isApplication(name) ? 'app' : 'util')
        }`,
      );
    }
    if (
      modules.has('lint') &&
      ![...tags].some((tag) => tag.startsWith('scope:'))
    ) {
      tags.add(`scope:${defaultScope}`);
    }
    if (modules.has('lint') && isApplication(name)) {
      if (![...tags].some((tag) => tag.startsWith('platform:'))) {
        tags.add(
          `platform:${projectClassifications.get(name)?.platform ?? defaultPlatform}`,
        );
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
    planConfirmed,
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
            ...packagePolicyInputs,
            { env: 'CI' },
            '{workspaceRoot}/nx.json',
            '{workspaceRoot}/docs/**/*.md',
            '{workspaceRoot}/**/package.json',
            '{workspaceRoot}/.agents/skills/**/*',
          ],
        },
        import: importTarget(tree),
        'verify-runtime': verifyRuntimeTarget,
        'verify-dependencies': verifyDependenciesTarget,
        'verify-container': verifyContainerTarget,
        ...(modules.has('health') && !modules.has('docs')
          ? { health: healthTarget }
          : {}),
      },
    });
  } else if (coreProjectCanUpdate) {
    ensureCheckInputs(tree);
    ensureImportTarget(tree);
    ensureVerifyRuntimeTarget(tree);
    ensureVerifyDependenciesTarget(tree);
    ensureVerifyContainerTarget(tree);
    if (modules.has('health') && !modules.has('docs')) ensureHealthTarget(tree);
  } else {
    logger.warn(
      'Megamono artifact core.project is modified or repository-owned; left .megamono/project.json unchanged. Review megamono:check inputs for all package-manager lockfiles, package-policy configuration, and CI before using cached checks. Restore managed ownership explicitly before retrying automatic updates.',
    );
  }
  if (!tree.exists('.megamono/artifacts.json')) {
    writeArtifactRegistry(tree, readArtifactRegistry(tree));
  }
  const docsProjectCanUpdate =
    modules.has('docs') &&
    managedArtifactCanUpdate(
      tree,
      'docs.project',
      `${docsRoot}/project.json`,
      planConfirmed,
    );
  if (modules.has('docs') && docsProjectCanUpdate) {
    if (getProjects(tree).has('megamono-docs')) {
      updateProjectConfiguration(
        tree,
        'megamono-docs',
        docsProjectConfiguration(
          docsRoot,
          modules.has('health'),
          docsContract.loader,
          docsContract.output,
        ),
      );
    } else {
      addProjectConfiguration(
        tree,
        'megamono-docs',
        docsProjectConfiguration(
          docsRoot,
          modules.has('health'),
          docsContract.loader,
          docsContract.output,
        ),
      );
    }
  } else if (modules.has('docs') && artifactEntry(tree, 'docs.project')) {
    logger.warn(
      `Megamono artifact docs.project is modified; left ${docsRoot}/project.json unchanged. Run workspace-eject to make it repository-owned.`,
    );
  }

  const inferenceSupported = nxWorkspaceCapabilities(tree).major >= 18;
  const inference = inferenceSupported
    ? {
        ...(workspaceSurvey.manifests.extension.length > 0
          ? {
              extension: {
                plugin: '@megamono/nx-extension' as const,
                manifests: workspaceSurvey.manifests.extension,
              },
            }
          : {}),
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
        ...(workspaceSurvey.manifests.cloudflare.length > 0
          ? {
              cloudflare: {
                plugin: '@megamono/nx-cloudflare' as const,
                manifests: workspaceSurvey.manifests.cloudflare,
              },
            }
          : {}),
        ...(workspaceSurvey.manifests.render.length > 0
          ? {
              render: {
                plugin: '@megamono/nx-render' as const,
                manifests: workspaceSurvey.manifests.render,
              },
            }
          : {}),
      }
    : {};
  const renderServiceProjects = options.renderServiceProjects
    ? parseRenderServiceProjects(
        tree,
        options.renderServiceProjects,
        workspaceSurvey.inventory,
      )
    : {};
  if (modules.has('inference') && Object.keys(inference).length > 0) {
    updateJson(tree, 'nx.json', (value) => {
      const plugins: unknown[] = Array.isArray(value.plugins)
        ? value.plugins
        : [];
      const renderPlugin =
        Object.keys(renderServiceProjects).length > 0
          ? {
              plugin: '@megamono/nx-render',
              options: { serviceProjects: renderServiceProjects },
            }
          : '@megamono/nx-render';
      const configuredPlugins = plugins.map((plugin) => {
        const name =
          typeof plugin === 'string'
            ? plugin
            : plugin && typeof plugin === 'object' && 'plugin' in plugin
              ? String(plugin.plugin)
              : null;
        return name === '@megamono/nx-render' &&
          Object.keys(renderServiceProjects).length > 0
          ? renderPlugin
          : plugin;
      });
      const pluginNames = new Set(
        configuredPlugins.flatMap((plugin) =>
          typeof plugin === 'string'
            ? [plugin]
            : plugin && typeof plugin === 'object' && 'plugin' in plugin
              ? [String(plugin.plugin)]
              : [],
        ),
      );
      const additions = Object.values(inference)
        .filter(({ plugin }) => !pluginNames.has(plugin))
        .map(({ plugin }) =>
          plugin === '@megamono/nx-render' ? renderPlugin : plugin,
        );
      return { ...value, plugins: [...configuredPlugins, ...additions] };
    });
    if ('apple' in inference) configuredPlatforms.add('apple');
    if ('cargo' in inference) configuredPlatforms.add('rust');
    if ('cloudflare' in inference) configuredPlatforms.add('worker');
    if ('extension' in inference) configuredPlatforms.add('extension');
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
  const ratchets = new Map(
    (existingConfig?.adoption.ratchets ?? []).map((ratchet) => [
      ratchet.rule,
      ratchet,
    ]),
  );
  for (const ratchet of lintAdoptionRatchets) {
    if (!ratchets.has(ratchet.rule)) ratchets.set(ratchet.rule, ratchet);
  }
  const lintWarningRules = Object.fromEntries(
    lintAdoptionRatchets.map(({ rule }) => [rule, { severity: 'warning' }]),
  );
  const config = megamonoConfigSchema.parse({
    ...(existingConfig ?? DEFAULT_MEGAMONO_CONFIG),
    conventions: {
      ...(existingConfig?.conventions ?? DEFAULT_MEGAMONO_CONFIG.conventions),
      packageManager,
      rules: {
        ...(existingConfig?.conventions.rules ??
          DEFAULT_MEGAMONO_CONFIG.conventions.rules),
        ...lintWarningRules,
      },
    },
    scaffolding: existingConfig?.scaffolding ?? {
      web: { styling: detectWebStyling(tree) },
    },
    platforms: [...configuredPlatforms].sort(),
    ports:
      options.ports !== undefined
        ? configuredPorts
        : (existingConfig?.ports ?? {}),
    docs: {
      ...(existingConfig?.docs ?? DEFAULT_MEGAMONO_CONFIG.docs),
      root: docsRoot,
      loader: docsContract.loader,
      module: docsContract.module,
      output: docsContract.output,
      loaderMode: docsContract.loaderMode,
    },
    adoption: {
      ...(existingConfig?.adoption ?? DEFAULT_MEGAMONO_CONFIG.adoption),
      modules: parseWorkspaceInitModules([...adoptedModules]),
      reductions,
      ratchets: ADOPTION_STRUCTURAL_RULES.flatMap((rule) => {
        const ratchet = ratchets.get(rule);
        return ratchet ? [ratchet] : [];
      }),
      inference: modules.has('inference')
        ? inferenceSupported
          ? inference
          : (existingConfig?.adoption.inference ?? {})
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
    packageSources: {
      ...(existingConfig?.packageSources ??
        DEFAULT_MEGAMONO_CONFIG.packageSources),
      registries: packageRegistries,
    },
  });
  updateJson(tree, 'package.json', (manifest) => ({
    ...manifest,
    ...(typeof manifest.packageManager === 'string'
      ? { packageManager: manifest.packageManager }
      : options.bootstrap
        ? {
            packageManager: `${packageManager}@${compatibility.packageManagers[packageManager]}`,
          }
        : {}),
    ...(configuredReleaseProjects.length > 0
      ? {
          scripts: {
            ...(manifest.scripts ?? {}),
            ...(!manifest.scripts?.['megamono:yalc-publish']
              ? {
                  'megamono:yalc-publish': 'node .megamono/publish-yalc.mjs',
                }
              : {}),
          },
        }
      : {}),
  }));
  if (options.toolchainPin && options.toolchainPin !== 'none') {
    if (!options.toolchainNode) {
      throw new WorkspaceInitError(
        'decision-required',
        `toolchainNode is required when toolchainPin=${options.toolchainPin}.`,
      );
    }
    if (options.toolchainPin === 'nvmrc' || options.toolchainPin === 'both')
      tree.write('.nvmrc', `${options.toolchainNode}\n`);
    if (
      options.toolchainPin === 'node-version' ||
      options.toolchainPin === 'both'
    )
      tree.write('.node-version', `${options.toolchainNode}\n`);
  }
  if (configuredReleaseProjects.length > 0) {
    updateJson(tree, 'nx.json', (nx) => {
      const namedInputs = nx.namedInputs ?? {};
      const sharedGlobals = new Set<string>(namedInputs.sharedGlobals ?? []);
      sharedGlobals.add('{workspaceRoot}/.yalc/**/*');
      return {
        ...nx,
        namedInputs: {
          ...namedInputs,
          sharedGlobals: [...sharedGlobals].sort(),
        },
        ...(nx.release === undefined
          ? {
              release: {
                groups: {
                  workspace: {
                    projects: configuredReleaseProjects.map(({ name }) => name),
                    projectsRelationship: 'fixed',
                    releaseTag: { pattern: 'workspace@{version}' },
                  },
                },
              },
            }
          : {}),
      };
    });
  }
  tree.write('megamono.json', `${JSON.stringify(config, null, 2)}\n`);
  await applyDocsAdoptionMap(tree, docsAdoptionEntries);
  const eslintWiring =
    modules.has('lint') && lintCanWire
      ? wireEslintConfig(tree)
      : { imports: false, rules: false };
  const docsLoaderTemplate = renderContentCollectionsConfig(docsRoot);
  const docsLoaderCanUpdate =
    modules.has('docs') && docsContract.loaderMode === 'create'
      ? applyManagedFileTemplate(
          tree,
          'docs.loader',
          docsContract.loader,
          docsLoaderTemplate,
          planConfirmed,
        )
      : false;
  const ignored = [
    ...(modules.has('docs') ? [`${docsContract.output}/`] : []),
    '.megamono/graph.json',
    ...(modules.has('health') ? ['.megamono/health.json'] : []),
    ...(configuredReleaseProjects.length > 0 ? ['.yalc/', 'yalc.lock'] : []),
  ];
  const ignoreTemplate = `\n${ignored.join('\n')}\n`;
  const gitignoreCanUpdate = applyManagedSectionTemplate(
    tree,
    'core.gitignore',
    '.gitignore',
    ignoreTemplate,
    IGNORE_SECTION_START,
    IGNORE_SECTION_END,
  );
  const prettierignoreCanUpdate = applyManagedSectionTemplate(
    tree,
    'core.prettierignore',
    '.prettierignore',
    `\n${[
      ...new Set([
        ...ignored,
        '.yalc/',
        'yalc.lock',
        'pnpm-lock.yaml',
        'package-lock.json',
        'npm-shrinkwrap.json',
        'yarn.lock',
        'bun.lock',
        'bun.lockb',
      ]),
    ].join('\n')}\n`,
    IGNORE_SECTION_START,
    IGNORE_SECTION_END,
  );
  const registryTemplate = renderPackageRegistrySection(packageRegistries);
  const registryCanUpdate =
    options.packageRegistries !== undefined
      ? applyManagedSectionTemplate(
          tree,
          'core.package-registries',
          '.npmrc',
          registryTemplate,
          REGISTRY_SECTION_START,
          REGISTRY_SECTION_END,
        )
      : false;
  if (modules.has('docs')) {
    const docsTsconfig = tree.exists('tsconfig.base.json')
      ? 'tsconfig.base.json'
      : 'tsconfig.json';
    updateJson(tree, docsTsconfig, (value) => {
      const compilerOptions = value.compilerOptions ?? {};
      const paths = compilerOptions.paths ?? {};
      const generatedPaths = {
        [docsContract.module]: [`./${docsContract.output}/index.js`],
        [`${docsContract.module}/*`]: [`./${docsContract.output}/*.js`],
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
  }
  const files: Readonly<Record<string, string>> = {
    ...(modules.has('docs')
      ? {
          [`${docsRoot}/INDEX.md`]: '# Repository documentation index\n',
          [`${docsRoot}/archives/INDEX.md`]: '# Archived documentation index\n',
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
  if (modules.has('docs')) {
    for (const [, path] of docsStructureArtifacts) tree.write(path, '');
  }
  if (modules.has('skills')) logManagedSkills(applyManagedSkillTemplates(tree));
  const healthWorkflow = renderHealthWorkflow(
    config.health.cadence === 'disabled' ? 'weekly' : config.health.cadence,
    modules.has('docs') ? 'megamono-docs:health' : 'megamono:health',
    packageManager,
    workflowToolchain(tree, packageManager),
  );
  const healthCanUpdate =
    modules.has('health') && config.health.cadence !== 'disabled'
      ? applyManagedFileTemplate(
          tree,
          'health.workflow',
          '.github/workflows/megamono-health.yml',
          healthWorkflow,
          planConfirmed,
        )
      : false;
  const ciWorkflow = renderCiWorkflow(
    configuredWorkspacePlatforms(tree, defaultPlatform),
    packageManager,
    workflowToolchain(tree, packageManager),
    config.adoption.modules.includes('docs'),
    ciMode === 'reusable',
  );
  const ciCanUpdate = ciShouldGenerate
    ? applyManagedFileTemplate(
        tree,
        'ci.affected',
        ciTarget,
        ciWorkflow,
        planConfirmed,
      )
    : false;
  const releaseWorkflow = renderReleaseWorkflow(
    configuredReleaseProjects,
    packageManager,
    workflowToolchain(tree, packageManager),
  );
  const releaseWorkflowCanUpdate =
    configuredReleaseProjects.length > 0
      ? applyManagedFileTemplate(
          tree,
          'release.workflow',
          '.github/workflows/megamono-release.yml',
          releaseWorkflow,
          planConfirmed,
        )
      : false;
  const yalcPublisher = renderYalcPublisher(
    configuredReleaseProjects,
    packageManager,
  );
  const yalcPublisherCanUpdate =
    configuredReleaseProjects.length > 0
      ? applyManagedFileTemplate(
          tree,
          'release.yalc-publisher',
          '.megamono/publish-yalc.mjs',
          yalcPublisher,
          planConfirmed,
        )
      : false;
  if (
    modules.has('agents') &&
    !artifactIsEjected(tree, 'agents.instructions') &&
    !tree.exists('AGENTS.md')
  ) {
    const documentationGuidance = tree.exists(`${docsRoot}/INDEX.md`)
      ? `Read ${docsRoot}/INDEX.md, accepted specs, decisions, and in-progress plans`
      : `Read ${docsRoot}/DESIGN.md and existing repository guidance`;
    tree.write(
      'AGENTS.md',
      `# Repository instructions\n\n${documentationGuidance} before changing the repository. Use Megamono generators instead of hand-rolling repository structure.\n`,
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
  const dependencyAssessments = workspaceInitDependencyAssessments(
    tree,
    modules,
  );
  const developmentDependencies = {
    ...(modules.has('inference') && 'extension' in inference
      ? {
          '@megamono/nx-extension': inferenceDependencyVersion(
            tree,
            '@megamono/nx-extension',
            pluginVersion,
          ),
        }
      : {}),
    ...Object.fromEntries(
      dependencyAssessments
        .filter(({ action }) => action === 'add')
        .map(({ name, range }) => [name, range]),
    ),
    ...(modules.has('inference') && 'apple' in inference
      ? {
          '@megamono/nx-apple': inferenceDependencyVersion(
            tree,
            '@megamono/nx-apple',
            pluginVersion,
          ),
        }
      : {}),
    ...(modules.has('inference') && 'cargo' in inference
      ? {
          '@megamono/nx-cargo': inferenceDependencyVersion(
            tree,
            '@megamono/nx-cargo',
            pluginVersion,
          ),
        }
      : {}),
    ...(modules.has('inference') && 'cloudflare' in inference
      ? {
          '@megamono/nx-cloudflare': inferenceDependencyVersion(
            tree,
            '@megamono/nx-cloudflare',
            pluginVersion,
          ),
        }
      : {}),
    ...(modules.has('inference') && 'render' in inference
      ? {
          '@megamono/nx-render': inferenceDependencyVersion(
            tree,
            '@megamono/nx-render',
            pluginVersion,
          ),
        }
      : {}),
  };
  Object.assign(developmentDependencies, localInference?.dependencies);
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
  for (const [id, target, allowManagedUpdate] of [
    ['core.gitignore', '.gitignore', gitignoreCanUpdate],
    ['core.prettierignore', '.prettierignore', prettierignoreCanUpdate],
  ] as const) {
    registerFileArtifact(
      tree,
      {
        id,
        module: 'baseline',
        mode: 'managed-section',
        target,
        ejectable: true,
        startDelimiter: IGNORE_SECTION_START,
        endDelimiter: IGNORE_SECTION_END,
        templateContent: ignoreTemplate,
        claimExisting: allowManagedUpdate,
        allowManagedUpdate,
      },
      pluginVersion,
    );
  }
  if (registryCanUpdate || artifactEntry(tree, 'core.package-registries')) {
    registerFileArtifact(
      tree,
      {
        id: 'core.package-registries',
        module: 'baseline',
        mode: 'managed-section',
        target: '.npmrc',
        ejectable: true,
        startDelimiter: REGISTRY_SECTION_START,
        endDelimiter: REGISTRY_SECTION_END,
        templateContent: registryTemplate,
        claimExisting: registryCanUpdate,
        allowManagedUpdate: registryCanUpdate,
      },
      pluginVersion,
    );
  }
  if (modules.has('lint')) {
    for (const [id, startDelimiter, endDelimiter, updated] of [
      [
        'lint.eslint-imports',
        ESLINT_IMPORTS_START,
        ESLINT_IMPORTS_END,
        eslintWiring.imports,
      ],
      [
        'lint.eslint-rules',
        ESLINT_RULES_START,
        ESLINT_RULES_END,
        eslintWiring.rules,
      ],
    ] as const) {
      if (!updated && !artifactEntry(tree, id)) continue;
      registerFileArtifact(
        tree,
        {
          id,
          module: 'lint',
          mode: 'managed-section',
          target: 'eslint.config.mjs',
          ejectable: true,
          startDelimiter,
          endDelimiter,
          claimExisting: updated,
          allowManagedUpdate: updated,
        },
        pluginVersion,
      );
    }
    if (created.eslint) {
      registerFileArtifact(
        tree,
        {
          id: 'lint.eslint-config-file',
          module: 'lint',
          mode: 'seeded',
          target: 'eslint.config.mjs',
          ejectable: false,
          claimExisting: true,
        },
        pluginVersion,
      );
    }
  }
  if (modules.has('docs')) {
    registerFileArtifact(
      tree,
      {
        id: 'docs.project',
        module: 'docs',
        mode: 'managed',
        target: `${docsRoot}/project.json`,
        ejectable: true,
        claimExisting: created.docsProject,
        allowManagedUpdate: docsProjectCanUpdate,
      },
      pluginVersion,
    );
    if (docsContract.loaderMode === 'create') {
      registerFileArtifact(
        tree,
        {
          id: 'docs.loader',
          module: 'docs',
          mode: 'managed',
          target: docsContract.loader,
          ejectable: true,
          templateContent: docsLoaderTemplate,
          claimExisting: created.docsLoader,
          allowManagedUpdate: docsLoaderCanUpdate,
        },
        pluginVersion,
      );
    }
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
    for (const [id, target] of docsStructureArtifacts) {
      registerFileArtifact(
        tree,
        {
          id,
          module: 'docs',
          mode: 'derived',
          target,
          ejectable: false,
          claimExisting: true,
          allowManagedUpdate: true,
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
  if (ciShouldGenerate) {
    registerFileArtifact(
      tree,
      {
        id: 'ci.affected',
        module: 'ci',
        mode: 'managed',
        target: ciTarget,
        ejectable: true,
        templateContent: ciWorkflow,
        claimExisting: created.ci,
        allowManagedUpdate: ciCanUpdate,
      },
      pluginVersion,
    );
  }
  if (configuredReleaseProjects.length > 0) {
    registerFileArtifact(
      tree,
      {
        id: 'release.workflow',
        module: 'release',
        mode: 'managed',
        target: '.github/workflows/megamono-release.yml',
        ejectable: true,
        templateContent: releaseWorkflow,
        claimExisting: created.releaseWorkflow,
        allowManagedUpdate: releaseWorkflowCanUpdate,
      },
      pluginVersion,
    );
    registerFileArtifact(
      tree,
      {
        id: 'release.yalc-publisher',
        module: 'release',
        mode: 'managed',
        target: '.megamono/publish-yalc.mjs',
        ejectable: true,
        templateContent: yalcPublisher,
        claimExisting: created.yalcPublisher,
        allowManagedUpdate: yalcPublisherCanUpdate,
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
    ...(localInference
      ? [
          {
            id: 'install-inferred-yalc-closure',
            retry: `yalc add ${localInference.packages.join(' ')} --dev --no-pure`,
            run: localInference.install,
          },
        ]
      : []),
    ...(hasDependencies
      ? [
          {
            id: 'install-dependencies',
            retry: `${packageManager} install`,
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
        linkSkillsCallback(tree.root, pluginVersion, planConfirmed),
      )
    : externalCommands;
}

export default workspaceInitGenerator;
