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
    readonly unsupported: readonly string[];
  };
  readonly documentation: {
    readonly roots: readonly string[];
    readonly markdown: readonly string[];
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
  const markdown = files.filter((path) => path.endsWith('.md'));
  const roots = new Set(
    markdown
      .map((path) => path.split('/')[0])
      .filter((root) => root === 'docs' || root === 'documentation'),
  );
  const workflows = files.filter((path) =>
    /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path),
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
      unsupported: files.filter((path) =>
        /(?:^|\/)(?:build\.gradle(?:\.kts)?|go\.mod|pom\.xml)$/.test(path),
      ),
    },
    documentation: { roots: [...roots].sort(compare), markdown },
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
      ].filter((path) => files.includes(path)),
      contentCollections: [
        'content-collections.ts',
        'content-collections.js',
      ].filter((path) => files.includes(path)),
      megamono: ['megamono.json', '.megamono/artifacts.json'].filter((path) =>
        files.includes(path),
      ),
    },
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
      'add',
      `${docsRoot}/project.json`,
      'Add documentation lifecycle targets.',
    );
    operation(
      operations,
      'docs',
      'add',
      `${docsRoot}/INDEX.md`,
      'Generate the repository documentation index.',
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
    operation(
      operations,
      'lint',
      survey.existing.eslint.length ? 'modify' : 'add',
      survey.existing.eslint[0] ?? 'eslint.config.mjs',
      'Wire Megamono structural rules.',
    );
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
  }
  if (modules.includes('skills')) {
    operation(
      operations,
      'skills',
      'add',
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
    }
  }
  operation(
    operations,
    'baseline',
    'run-last',
    'npm install',
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

## Non-JavaScript manifests

### Apple

${values(survey.manifests.apple)}

### Cargo

${values(survey.manifests.cargo)}

### Unsupported

${values(survey.manifests.unsupported)}

## Documentation

- Roots: ${survey.documentation.roots.join(', ') || 'none'}
- Markdown files: ${survey.documentation.markdown.length}

## Agent surfaces

${values([...survey.agents.files, ...survey.agents.skillRoots])}

## Existing governance

- CI: ${survey.existing.ci.join(', ') || 'none'}
- Health: ${survey.existing.health.join(', ') || 'none'}
- ESLint: ${survey.existing.eslint.join(', ') || 'none'}
- Content Collections: ${survey.existing.contentCollections.join(', ') || 'none'}
- Megamono: ${survey.existing.megamono.join(', ') || 'none'}
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
