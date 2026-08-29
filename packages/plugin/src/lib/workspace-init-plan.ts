import { getProjects, type ProjectConfiguration, type Tree } from '@nx/devkit';
import { readArtifactRegistry } from './managed-artifacts';
import { MANAGED_SKILL_NAMES } from './managed-skills';

export const WORKSPACE_INIT_MODULES = [
  'docs',
  'agents',
  'ci',
  'lint',
  'skills',
  'health',
  'inference',
] as const;

export type WorkspaceInitModule = (typeof WORKSPACE_INIT_MODULES)[number];
export type WorkspaceInitOutputFormat = 'markdown' | 'json';
export type WorkspaceInitErrorKind =
  | 'options'
  | 'preflight'
  | 'conflict'
  | 'decision-required'
  | 'external-command';

const ERROR_DETAILS: Readonly<
  Record<
    WorkspaceInitErrorKind,
    { readonly exitCode: number; readonly code: string }
  >
> = {
  options: { exitCode: 2, code: 'workspace-init-options' },
  preflight: { exitCode: 3, code: 'workspace-init-preflight' },
  conflict: { exitCode: 3, code: 'workspace-init-conflict' },
  'decision-required': {
    exitCode: 4,
    code: 'workspace-init-decision-required',
  },
  'external-command': {
    exitCode: 1,
    code: 'workspace-init-external-command',
  },
};

export class WorkspaceInitError extends Error {
  readonly exitCode: number;
  readonly diagnosticCode: string;

  constructor(
    readonly kind: WorkspaceInitErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    const details = ERROR_DETAILS[kind];
    super(`${details.code}: ${message}`, options);
    this.name = 'WorkspaceInitError';
    this.exitCode = details.exitCode;
    this.diagnosticCode = details.code;
  }
}

export interface WorkspaceInitSurveyProject {
  readonly name: string;
  readonly root: string;
  readonly type: 'application' | 'library';
  readonly targets: readonly string[];
  readonly tags: readonly string[];
}

export interface WorkspaceInitDocumentationClassification {
  readonly path: string;
  readonly type: 'spec' | 'plan' | 'decision' | 'audit' | 'research' | 'report';
  readonly proposedId: string | null;
  readonly basis:
    'lifecycle-metadata' | 'decision-directory' | 'research-directory';
}

export interface WorkspaceInitSurvey {
  readonly schemaVersion: 1;
  readonly baseline: {
    readonly packageManager: string | null;
    readonly node: string | null;
    readonly nx: string | null;
    readonly typescript: string | null;
    readonly lockfiles: readonly string[];
  };
  readonly projects: readonly WorkspaceInitSurveyProject[];
  readonly manifests: {
    readonly apple: readonly string[];
    readonly cargo: readonly string[];
    readonly cloudflare: readonly string[];
    readonly unsupported: readonly string[];
  };
  readonly documentation: {
    readonly roots: readonly string[];
    readonly corpusDirectories: readonly string[];
    readonly markdown: readonly string[];
    readonly classifications: readonly WorkspaceInitDocumentationClassification[];
    readonly unclassified: readonly string[];
  };
  readonly agents: {
    readonly files: readonly string[];
    readonly skillRoots: readonly string[];
  };
  readonly existing: {
    readonly ci: readonly string[];
    readonly health: readonly string[];
    readonly eslint: readonly string[];
    readonly contentCollections: readonly string[];
    readonly megamono: readonly string[];
  };
  readonly recommendations: readonly WorkspaceInitSurveyRecommendation[];
}

export interface WorkspaceInitSurveyRecommendation {
  readonly module: WorkspaceInitModule;
  readonly action: 'skip';
  readonly paths: readonly string[];
  readonly reason: string;
}

export interface WorkspaceInitReduction {
  readonly module: WorkspaceInitModule;
  readonly capability: string;
  readonly reason: string;
}

export interface WorkspaceInitPlanOperation {
  readonly order: number;
  readonly module: 'baseline' | WorkspaceInitModule;
  readonly action: 'add' | 'modify' | 'retain' | 'skip' | 'run-last';
  readonly target: string;
  readonly detail: string;
}

export interface WorkspaceInitPlan {
  readonly schemaVersion: 1;
  readonly modules: readonly WorkspaceInitModule[];
  readonly operations: readonly WorkspaceInitPlanOperation[];
  readonly reductions: readonly WorkspaceInitReduction[];
  readonly conflicts: readonly string[];
  readonly decisions: readonly string[];
}

export interface WorkspaceInitPlanOptions {
  readonly only?: string | readonly WorkspaceInitModule[];
  readonly docsRoot?: string;
  readonly defaultScope?: string;
  readonly defaultPlatform?: string;
  readonly yes?: boolean;
  readonly packageManager?: 'pnpm' | 'npm';
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJsonObject(tree: Tree, path: string): Record<string, unknown> {
  const source = tree.read(path, 'utf8');
  if (!source) return {};
  try {
    const value = JSON.parse(source) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function dependencyVersion(
  manifest: Record<string, unknown>,
  name: string,
): string | null {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const dependencies = manifest[field];
    if (
      dependencies &&
      typeof dependencies === 'object' &&
      !Array.isArray(dependencies) &&
      typeof (dependencies as Record<string, unknown>)[name] === 'string'
    ) {
      return (dependencies as Record<string, string>)[name];
    }
  }
  return null;
}

function listFiles(tree: Tree): readonly string[] {
  const files: string[] = [];
  const ignored = new Set([
    '.git',
    '.nx',
    '.content-collections',
    'coverage',
    'dist',
    'node_modules',
    'tmp',
  ]);
  const visit = (directory: string) => {
    for (const child of tree.children(directory).sort(compare)) {
      if (ignored.has(child)) continue;
      const path = directory ? `${directory}/${child}` : child;
      if (tree.isFile(path)) files.push(path);
      else visit(path);
    }
  };
  visit('');
  return files;
}

function projectType(
  project: ProjectConfiguration,
): WorkspaceInitSurveyProject['type'] {
  return project.projectType === 'library' ? 'library' : 'application';
}

const DOCUMENT_TYPES = new Set([
  'spec',
  'plan',
  'decision',
  'audit',
  'research',
  'report',
]);
const DECISION_DIRECTORIES = new Set(['adr', 'adrs', 'decision', 'decisions']);
const RESEARCH_DIRECTORIES = new Set(['rfc', 'rfcs', 'research']);

function frontmatterField(source: string, field: string): string | undefined {
  const newline = source.indexOf('\n');
  if (newline < 0 || source.slice(0, newline).trim() !== '---')
    return undefined;
  const end = source.indexOf('\n---', newline + 1);
  if (end < 0) return undefined;
  const match = new RegExp(
    `^${field}:\\s*["']?([^\\n"']+)["']?\\s*$`,
    'm',
  ).exec(source.slice(newline + 1, end));
  return match?.[1].trim();
}

function classifyDocumentation(
  tree: Tree,
  markdown: readonly string[],
): {
  readonly corpusDirectories: readonly string[];
  readonly classifications: readonly WorkspaceInitDocumentationClassification[];
  readonly unclassified: readonly string[];
} {
  const corpusDirectories = new Set<string>();
  const classifications: WorkspaceInitDocumentationClassification[] = [];
  const classified = new Set<string>();
  for (const path of markdown) {
    const segments = path.split('/');
    const directories = segments.slice(0, -1);
    const source = tree.read(path, 'utf8') ?? '';
    const metadataType = frontmatterField(source, 'type');
    const metadataId = frontmatterField(source, 'id');
    let type: WorkspaceInitDocumentationClassification['type'] | undefined;
    let basis: WorkspaceInitDocumentationClassification['basis'] | undefined;
    if (metadataType && DOCUMENT_TYPES.has(metadataType)) {
      type = metadataType as WorkspaceInitDocumentationClassification['type'];
      basis = 'lifecycle-metadata';
    } else if (
      directories.some((directory) =>
        DECISION_DIRECTORIES.has(directory.toLowerCase()),
      )
    ) {
      type = 'decision';
      basis = 'decision-directory';
    } else if (
      directories.some((directory) =>
        RESEARCH_DIRECTORIES.has(directory.toLowerCase()),
      )
    ) {
      type = 'research';
      basis = 'research-directory';
    }
    for (let index = 0; index < directories.length; index += 1) {
      const directory = directories[index].toLowerCase();
      if (
        DECISION_DIRECTORIES.has(directory) ||
        RESEARCH_DIRECTORIES.has(directory) ||
        DOCUMENT_TYPES.has(directory)
      ) {
        corpusDirectories.add(directories.slice(0, index + 1).join('/'));
      }
    }
    if (!type || !basis) continue;
    classifications.push({
      path,
      type,
      proposedId: metadataId ?? null,
      basis,
    });
    classified.add(path);
  }
  return {
    corpusDirectories: [...corpusDirectories].sort(compare),
    classifications: classifications.sort((left, right) =>
      compare(left.path, right.path),
    ),
    unclassified: markdown.filter((path) => !classified.has(path)),
  };
}

function detectsAffectedCi(source: string): boolean {
  const invokesAffected = /\bnx\s+(?:--\s+)?affected\b/.test(source);
  const establishesBase =
    /\bnx-set-shas(?:@|\b)/.test(source) ||
    (/\bNX_BASE\b/.test(source) && /\bNX_HEAD\b/.test(source));
  const checksLifecycleTargets = ['lint', 'test', 'build'].every((target) =>
    new RegExp(`\\b${target}\\b`).test(source),
  );
  return invokesAffected && establishesBase && checksLifecycleTargets;
}

export function parseWorkspaceInitModules(
  only?: string | readonly WorkspaceInitModule[],
): readonly WorkspaceInitModule[] {
  if (only === undefined) return WORKSPACE_INIT_MODULES;
  const requested: string[] =
    typeof only === 'string'
      ? only
          .split(',')
          .map((module) => module.trim())
          .filter(Boolean)
      : [...only];
  const unknown = requested.filter(
    (module) => !WORKSPACE_INIT_MODULES.includes(module as WorkspaceInitModule),
  );
  if (unknown.length > 0) {
    throw new WorkspaceInitError(
      'options',
      `Unknown module selection: ${[...new Set(unknown)].sort(compare).join(', ')}.`,
    );
  }
  const selected = new Set(requested as WorkspaceInitModule[]);
  if (selected.size === 0) {
    throw new WorkspaceInitError(
      'options',
      'Select at least one module with --only.',
    );
  }
  return WORKSPACE_INIT_MODULES.filter((module) => selected.has(module));
}

export function surveyWorkspaceInit(tree: Tree): WorkspaceInitSurvey {
  const files = listFiles(tree);
  const manifest = readJsonObject(tree, 'package.json');
  const engines =
    manifest.engines &&
    typeof manifest.engines === 'object' &&
    !Array.isArray(manifest.engines)
      ? (manifest.engines as Record<string, unknown>)
      : {};
  const packageManager =
    typeof manifest.packageManager === 'string'
      ? manifest.packageManager
      : typeof engines.pnpm === 'string'
        ? `pnpm@${engines.pnpm}`
        : typeof engines.npm === 'string'
          ? `npm@${engines.npm}`
          : null;
  const projects = [...getProjects(tree).entries()]
    .map(([name, project]) => ({
      name,
      root: project.root,
      type: projectType(project),
      targets: Object.keys(project.targets ?? {}).sort(compare),
      tags: [...(project.tags ?? [])].sort(compare),
    }))
    .sort((left, right) => compare(left.name, right.name));
  const markdown = files.filter(
    (path) =>
      path.endsWith('.md') &&
      !['AGENTS.md', 'CLAUDE.md'].includes(path) &&
      !path.startsWith('.agents/skills/') &&
      !path.startsWith('.claude/skills/'),
  );
  const documentation = classifyDocumentation(tree, markdown);
  const roots = new Set(
    markdown
      .map((path) => path.split('/')[0])
      .filter((root) => root === 'docs' || root === 'documentation'),
  );
  const workflows = files.filter((path) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path),
  );
  const equivalentAffectedCi = workflows.filter(
    (path) =>
      path !== '.github/workflows/megamono-ci.yml' &&
      detectsAffectedCi(tree.read(path, 'utf8') ?? ''),
  );
  return {
    schemaVersion: 1,
    baseline: {
      packageManager,
      node: typeof engines.node === 'string' ? engines.node : null,
      nx: dependencyVersion(manifest, 'nx'),
      typescript: dependencyVersion(manifest, 'typescript'),
      lockfiles: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].filter(
        (path) => files.includes(path),
      ),
    },
    projects,
    manifests: {
      apple: files.filter((path) => path.endsWith('Package.swift')),
      cargo: files.filter((path) => path.endsWith('Cargo.toml')),
      cloudflare: files.filter((path) =>
        /(?:^|\/)wrangler\.(?:jsonc?|toml)$/.test(path),
      ),
      unsupported: files.filter((path) =>
        /(?:^|\/)(?:build\.gradle(?:\.kts)?|go\.mod|pom\.xml)$/.test(path),
      ),
    },
    documentation: {
      roots: [...roots].sort(compare),
      markdown,
      ...documentation,
    },
    agents: {
      files: ['AGENTS.md', 'CLAUDE.md', '.cursorrules'].filter((path) =>
        files.includes(path),
      ),
      skillRoots: ['.agents/skills', '.claude/skills'].filter((path) =>
        files.some((file) => file.startsWith(`${path}/`)),
      ),
    },
    existing: {
      ci: workflows.filter((path) => !/health/i.test(path)),
      health: workflows.filter((path) => /health/i.test(path)),
      eslint: [
        'eslint.config.js',
        'eslint.config.mjs',
        'eslint.config.cjs',
        '.eslintrc',
        '.eslintrc.json',
        '.eslintrc.js',
        '.eslintrc.cjs',
        '.eslintrc.yml',
        '.eslintrc.yaml',
      ].filter((path) => files.includes(path)),
      contentCollections: [
        'content-collections.ts',
        'content-collections.js',
      ].filter((path) => files.includes(path)),
      megamono: ['megamono.json', '.megamono/artifacts.json'].filter((path) =>
        files.includes(path),
      ),
    },
    recommendations:
      equivalentAffectedCi.length > 0
        ? [
            {
              module: 'ci',
              action: 'skip',
              paths: equivalentAffectedCi,
              reason:
                'Existing workflows establish an affected base/head and run lint, test, and build through Nx affected.',
            },
          ]
        : [],
  };
}

function operation(
  operations: WorkspaceInitPlanOperation[],
  module: WorkspaceInitPlanOperation['module'],
  action: WorkspaceInitPlanOperation['action'],
  target: string,
  detail: string,
): void {
  operations.push({
    order: operations.length + 1,
    module,
    action,
    target,
    detail,
  });
}

export function createWorkspaceInitPlan(
  tree: Tree,
  options: WorkspaceInitPlanOptions = {},
): WorkspaceInitPlan {
  const modules = parseWorkspaceInitModules(options.only);
  const survey = surveyWorkspaceInit(tree);
  const packageManager =
    options.packageManager ??
    (survey.baseline.packageManager?.startsWith('npm') ? 'npm' : 'pnpm');
  const docsRoot = options.docsRoot ?? 'docs';
  const operations: WorkspaceInitPlanOperation[] = [];
  const reductions: WorkspaceInitReduction[] = [];
  const conflicts: string[] = [];
  const decisions: string[] = [];
  let ownedArtifacts = new Map<
    string,
    { readonly target: string; readonly state: string }
  >();
  if (tree.exists('.megamono/artifacts.json')) {
    try {
      ownedArtifacts = new Map(
        readArtifactRegistry(tree).artifacts.map((artifact) => [
          artifact.id,
          { target: artifact.target, state: artifact.state },
        ]),
      );
    } catch (error) {
      conflicts.push(
        `.megamono/artifacts.json is invalid: ${(error as Error).message}`,
      );
    }
  }
  const owned = (id: string, target: string) => {
    const artifact = ownedArtifacts.get(id);
    return artifact?.target === target && artifact.state !== 'ejected';
  };
  const ejected = (id: string, target: string) => {
    const artifact = ownedArtifacts.get(id);
    return artifact?.target === target && artifact.state === 'ejected';
  };
  const managedAction = (
    id: string,
    target: string,
  ): WorkspaceInitPlanOperation['action'] =>
    tree.exists(target) || ejected(id, target) ? 'retain' : 'add';
  operation(
    operations,
    'baseline',
    tree.exists('megamono.json') ? 'retain' : 'add',
    'megamono.json',
    'Record Megamono conventions and selected adoption modules.',
  );
  operation(
    operations,
    'baseline',
    survey.baseline.packageManager ? 'retain' : 'modify',
    'package.json#packageManager',
    `Record ${packageManager} as the workspace package manager.`,
  );
  operation(
    operations,
    'baseline',
    managedAction('core.project', '.megamono/project.json'),
    '.megamono/project.json',
    'Configure the megamono check and import targets.',
  );
  if (
    tree.exists('.megamono/project.json') &&
    !owned('core.project', '.megamono/project.json') &&
    !ejected('core.project', '.megamono/project.json')
  ) {
    conflicts.push(
      '.megamono/project.json is occupied without Megamono ownership metadata.',
    );
  }
  operation(
    operations,
    'baseline',
    tree.exists('.megamono/artifacts.json') ? 'modify' : 'add',
    '.megamono/artifacts.json',
    'Record deterministic artifact ownership.',
  );
  for (const [id, target] of [
    ['core.gitignore', '.gitignore'],
    ['core.prettierignore', '.prettierignore'],
  ] as const) {
    operation(
      operations,
      'baseline',
      ejected(id, target) ? 'retain' : tree.exists(target) ? 'modify' : 'add',
      target,
      'Maintain bounded ignore entries for generated Megamono state.',
    );
  }
  if (modules.includes('docs')) {
    operation(
      operations,
      'docs',
      managedAction('docs.loader', 'content-collections.ts'),
      'content-collections.ts',
      'Configure the repository docs loader.',
    );
    operation(
      operations,
      'docs',
      managedAction('docs.project', `${docsRoot}/project.json`),
      `${docsRoot}/project.json`,
      'Add documentation lifecycle targets.',
    );
    operation(
      operations,
      'docs',
      tree.exists(`${docsRoot}/INDEX.md`) ? 'retain' : 'add',
      `${docsRoot}/INDEX.md`,
      'Generate the repository documentation index.',
    );
    operation(
      operations,
      'docs',
      tree.exists(`${docsRoot}/archives/INDEX.md`) ? 'retain' : 'add',
      `${docsRoot}/archives/INDEX.md`,
      'Generate the archived-documentation index.',
    );
    for (const path of [
      `${docsRoot}/specs/.gitkeep`,
      `${docsRoot}/plans/.gitkeep`,
      `${docsRoot}/decisions/.gitkeep`,
      `${docsRoot}/audits/.gitkeep`,
      `${docsRoot}/research/.gitkeep`,
      `${docsRoot}/reports/.gitkeep`,
      `${docsRoot}/archives/specs/.gitkeep`,
      `${docsRoot}/archives/plans/.gitkeep`,
      `${docsRoot}/archives/research/.gitkeep`,
    ]) {
      operation(
        operations,
        'docs',
        tree.exists(path) ? 'retain' : 'add',
        path,
        'Keep the canonical documentation directory in the repository.',
      );
    }
    for (const key of ['content-collections', 'content-collections/*']) {
      operation(
        operations,
        'docs',
        'modify',
        `tsconfig.base.json#compilerOptions.paths.${key}`,
        'Map generated Content Collections modules for TypeScript.',
      );
    }
    operation(
      operations,
      'docs',
      'modify',
      'package.json#devDependencies',
      'Add @content-collections/core and zod at their compatibility-pinned ranges.',
    );
    if (
      survey.existing.contentCollections.includes('content-collections.ts') &&
      !owned('docs.loader', 'content-collections.ts') &&
      !ejected('docs.loader', 'content-collections.ts')
    ) {
      conflicts.push(
        'content-collections.ts is occupied by a repository-owned configuration.',
      );
    }
  }
  if (modules.includes('agents')) {
    operation(
      operations,
      'agents',
      tree.exists('AGENTS.md') ? 'modify' : 'add',
      'AGENTS.md',
      'Add the bounded Megamono repository-instructions section.',
    );
    operation(
      operations,
      'agents',
      tree.exists('CLAUDE.md') ? 'retain' : 'add',
      'CLAUDE.md',
      'Create the supported AGENTS.md pointer when the path is free.',
    );
    operation(
      operations,
      'agents',
      tree.exists(`${docsRoot}/DESIGN.md`) ? 'retain' : 'add',
      `${docsRoot}/DESIGN.md`,
      'Seed repository-owned design direction for agents and maintainers.',
    );
  }
  if (modules.includes('ci')) {
    const target = '.github/workflows/megamono-ci.yml';
    operation(
      operations,
      'ci',
      managedAction('ci.affected', target),
      target,
      'Add dedicated affected CI.',
    );
    if (
      tree.exists(target) &&
      !owned('ci.affected', target) &&
      !ejected('ci.affected', target)
    ) {
      conflicts.push(
        `${target} is occupied without Megamono ownership metadata.`,
      );
    }
  }
  if (modules.includes('lint')) {
    const flatEslint = survey.existing.eslint.find((path) =>
      path.startsWith('eslint.config.'),
    );
    const legacyEslint = survey.existing.eslint.find((path) =>
      path.startsWith('.eslintrc'),
    );
    const lintTarget = flatEslint ?? legacyEslint ?? 'eslint.config.mjs';
    const legacyOnly = Boolean(legacyEslint && !flatEslint);
    operation(
      operations,
      'lint',
      legacyOnly ? 'skip' : flatEslint ? 'modify' : 'add',
      lintTarget,
      legacyOnly
        ? 'Retain legacy ESLint configuration; Megamono tags and structural checks remain available.'
        : 'Wire Megamono structural rules.',
    );
    if (legacyOnly) {
      reductions.push({
        module: 'lint',
        capability: 'eslint-rule-wiring',
        reason: `${legacyEslint} uses the legacy ESLint configuration contract; migrate to flat config before enabling the Megamono ESLint plugin.`,
      });
    }
    const untaggedApplications = survey.projects.filter(
      (project) =>
        project.type === 'application' &&
        !project.tags.some((tag) => tag.startsWith('platform:')),
    );
    if (untaggedApplications.length > 0 && !options.defaultPlatform) {
      decisions.push(
        `defaultPlatform is required for: ${untaggedApplications.map(({ name }) => name).join(', ')}.`,
      );
    }
    for (const project of survey.projects) {
      if (project.name === 'megamono' || project.name === 'megamono-docs')
        continue;
      const additions = [
        ...(project.tags.some((tag) => tag.startsWith('type:'))
          ? []
          : [`type:${project.type === 'application' ? 'app' : 'util'}`]),
        ...(project.tags.some((tag) => tag.startsWith('scope:'))
          ? []
          : [`scope:${options.defaultScope ?? 'shared'}`]),
        ...(project.type === 'application' &&
        !project.tags.some((tag) => tag.startsWith('platform:'))
          ? [`platform:${options.defaultPlatform ?? '<required>'}`]
          : []),
        ...(project.type === 'application' &&
        !project.tags.some((tag) => tag.startsWith('visibility:'))
          ? ['visibility:internal']
          : []),
      ];
      if (additions.length === 0) continue;
      operation(
        operations,
        'lint',
        'modify',
        `nx-project:${project.name}#tags`,
        `Add missing tags without changing existing vocabulary: ${additions.join(', ')}.`,
      );
    }
  }
  if (modules.includes('skills')) {
    operation(
      operations,
      'skills',
      survey.agents.skillRoots.includes('.agents/skills') ? 'retain' : 'add',
      '.agents/skills',
      'Install managed portable skill file sets.',
    );
    operation(
      operations,
      'skills',
      'run-last',
      '.claude/skills',
      'Create the portable skill projection after tree flush.',
    );
    for (const name of MANAGED_SKILL_NAMES) {
      const target = `.agents/skills/${name}`;
      const occupied = tree.children(target).length > 0 || tree.exists(target);
      if (
        occupied &&
        !owned(`skill.${name}`, target) &&
        !ejected(`skill.${name}`, target)
      ) {
        conflicts.push(
          `${target} is occupied without Megamono ownership metadata.`,
        );
      }
    }
  }
  if (modules.includes('health')) {
    const healthTarget = '.github/workflows/megamono-health.yml';
    operation(
      operations,
      'health',
      managedAction('health.workflow', healthTarget),
      healthTarget,
      'Add deterministic scheduled health reporting.',
    );
    if (
      tree.exists(healthTarget) &&
      !owned('health.workflow', healthTarget) &&
      !ejected('health.workflow', healthTarget)
    ) {
      conflicts.push(
        `${healthTarget} is occupied without Megamono ownership metadata.`,
      );
    }
    if (!modules.includes('docs')) {
      for (const capability of ['spec-drift', 'stale-plans']) {
        reductions.push({
          module: 'health',
          capability,
          reason: 'The docs module is not selected.',
        });
      }
    }
  }
  if (modules.includes('inference')) {
    for (const [platform, manifests] of [
      ['apple', survey.manifests.apple],
      ['cargo', survey.manifests.cargo],
      ['cloudflare', survey.manifests.cloudflare],
    ] as const) {
      operation(
        operations,
        'inference',
        manifests.length > 0 ? 'add' : 'skip',
        platform,
        manifests.length > 0
          ? `Register the supported ${platform} inference plugin for ${manifests.join(', ')}.`
          : `No ${platform} manifests were detected.`,
      );
      if (manifests.length > 0) {
        const plugin =
          platform === 'apple'
            ? '@megamono/nx-apple'
            : platform === 'cargo'
              ? '@megamono/nx-cargo'
              : '@megamono/nx-cloudflare';
        operation(
          operations,
          'inference',
          'modify',
          'nx.json#plugins',
          `Register ${plugin} for detected ${platform} manifests.`,
        );
        operation(
          operations,
          'inference',
          'modify',
          'package.json#devDependencies',
          `Add ${plugin} at the installed Megamono plugin version.`,
        );
      }
    }
  }
  operation(
    operations,
    'baseline',
    'run-last',
    `${packageManager} install`,
    'Install required dependencies after all file preflights and tree writes.',
  );

  if (options.yes && options.only === undefined) {
    decisions.unshift(
      'Non-interactive initialization requires an explicit --only selection.',
    );
  }
  if (options.yes && decisions.length > 0) {
    throw new WorkspaceInitError('decision-required', decisions.join(' '));
  }
  return {
    schemaVersion: 1,
    modules,
    operations,
    reductions,
    conflicts,
    decisions,
  };
}

export function renderWorkspaceInitSurvey(
  survey: WorkspaceInitSurvey,
  format: WorkspaceInitOutputFormat = 'markdown',
): string {
  if (format === 'json') return `${JSON.stringify(survey, null, 2)}\n`;
  const values = (items: readonly string[]) =>
    items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- None';
  return `# Megamono workspace survey

## Baseline

- Package manager: ${survey.baseline.packageManager ?? 'unknown'}
- Node: ${survey.baseline.node ?? 'unknown'}
- Nx: ${survey.baseline.nx ?? 'unknown'}
- TypeScript: ${survey.baseline.typescript ?? 'unknown'}
- Lockfiles: ${survey.baseline.lockfiles.join(', ') || 'none'}

## Projects

${values(survey.projects.map((project) => `${project.name} — ${project.type} at ${project.root}; targets: ${project.targets.join(', ') || 'none'}; tags: ${project.tags.join(', ') || 'none'}`))}

## Inference manifests

### Apple

${values(survey.manifests.apple)}

### Cargo

${values(survey.manifests.cargo)}

### Cloudflare

${values(survey.manifests.cloudflare)}

### Unsupported

${values(survey.manifests.unsupported)}

## Documentation

- Roots: ${survey.documentation.roots.join(', ') || 'none'}
- Corpus-like directories: ${survey.documentation.corpusDirectories.join(', ') || 'none'}
- Markdown files: ${survey.documentation.markdown.length}

### High-confidence classification proposals

${values(
  survey.documentation.classifications.map(
    ({ path, type, proposedId, basis }) =>
      `${path} — ${type}; stable ID: ${proposedId ?? 'requires reviewed migration'}; basis: ${basis}`,
  ),
)}

### Unclassified Markdown

${values(survey.documentation.unclassified)}

## Agent surfaces

${values([...survey.agents.files, ...survey.agents.skillRoots])}

## Existing governance

- CI: ${survey.existing.ci.join(', ') || 'none'}
- Health: ${survey.existing.health.join(', ') || 'none'}
- ESLint: ${survey.existing.eslint.join(', ') || 'none'}
- Content Collections: ${survey.existing.contentCollections.join(', ') || 'none'}
- Megamono: ${survey.existing.megamono.join(', ') || 'none'}

## Adoption recommendations

${values(
  survey.recommendations.map(
    ({ module, action, paths, reason }) =>
      `${module}: ${action}; retain ${paths.join(', ')} — ${reason}`,
  ),
)}
`;
}

export function renderWorkspaceInitPlan(
  plan: WorkspaceInitPlan,
  format: WorkspaceInitOutputFormat = 'markdown',
): string {
  if (format === 'json') return `${JSON.stringify(plan, null, 2)}\n`;
  const lines = plan.operations.map(
    ({ order, module, action, target, detail }) =>
      `${order}. **${module} / ${action} / ${target}** — ${detail}`,
  );
  const reductions =
    plan.reductions.length > 0
      ? plan.reductions.map(
          ({ module, capability, reason }) =>
            `- ${module}.${capability}: ${reason}`,
        )
      : ['- None'];
  const conflicts = plan.conflicts.length
    ? plan.conflicts.map((conflict) => `- ${conflict}`)
    : ['- None'];
  const decisions = plan.decisions.length
    ? plan.decisions.map((decision) => `- ${decision}`)
    : ['- None'];
  return `# Megamono workspace initialization plan

- Modules: ${plan.modules.join(', ')}

## Ordered operations

${lines.join('\n')}

## Capability reductions

${reductions.join('\n')}

## Conflicts

${conflicts.join('\n')}

## Decisions required

${decisions.join('\n')}
`;
}

export function renderWorkspaceInitCompletion(plan: WorkspaceInitPlan): string {
  const skippedModules = WORKSPACE_INIT_MODULES.filter(
    (module) => !plan.modules.includes(module),
  );
  const changed = plan.operations.filter(({ action }) =>
    ['add', 'modify'].includes(action),
  );
  const retained = plan.operations.filter(({ action }) => action === 'retain');
  const confidenceGaps = [
    ...plan.reductions.map(
      ({ module, capability, reason }) => `${module}.${capability}: ${reason}`,
    ),
    ...plan.operations
      .filter(({ action }) => action === 'skip')
      .map(({ module, target, detail }) => `${module}.${target}: ${detail}`),
  ];
  const packageManager = plan.operations.some(
    ({ action, target }) => action === 'run-last' && target === 'npm install',
  )
    ? 'npm'
    : 'pnpm';
  const nx = `${packageManager} exec nx`;
  const followUps = [
    `${nx} run megamono:check`,
    ...(plan.modules.includes('docs')
      ? [`${nx} run megamono-docs:validate`]
      : []),
    ...(plan.modules.includes('health')
      ? [
          plan.modules.includes('docs')
            ? `${nx} run megamono-docs:health`
            : `${nx} run megamono:health`,
        ]
      : []),
  ];
  const lines = (values: readonly string[]) =>
    values.length > 0
      ? values.map((value) => `- ${value}`).join('\n')
      : '- None';
  return `# Megamono workspace initialization complete

## Modules adopted

${lines(plan.modules)}

## Modules skipped

${lines(skippedModules)}

## Paths added or modified

${lines(changed.map(({ action, target }) => `${action}: ${target}`))}

## Conventions retained

${lines(retained.map(({ target }) => target))}

## Confidence gaps and capability reductions

${lines(confidenceGaps)}

## Follow-up commands

${lines(followUps.map((command) => `\`${command}\``))}
`;
}
