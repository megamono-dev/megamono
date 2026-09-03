import { getProjects, type Tree } from '@nx/devkit';
import ignore = require('ignore');
import { readArtifactRegistry } from './managed-artifacts';
import { MANAGED_SKILL_NAMES } from './managed-skills';
import { nxWorkspaceCapabilities } from './workspace-compatibility';
import { readDocsAdoptionMap } from './docs-adoption';
import { parsePackageRegistries } from './package-sources';
import {
  classifyProjectForAdoption,
  readProjectAdoptionResolutions,
  type ProjectAdoptionPlatform,
  type ProjectAdoptionResolutions,
} from './project-adoption';
import {
  isPackageManager,
  lockfileManagers,
  packageManagerAdapter,
  type PackageManager,
} from './package-manager';
import { workspaceInitDependencyAssessments } from './dependency-compatibility';
import {
  createWorkspaceInventory,
  type WorkspaceInventory,
} from './workspace-inventory';

export const WORKSPACE_INIT_MODULES = [
  'docs',
  'agents',
  'ci',
  'release',
  'lint',
  'skills',
  'health',
  'inference',
] as const;

export type WorkspaceInitModule = (typeof WORKSPACE_INIT_MODULES)[number];
export const WORKSPACE_INIT_PROFILES = {
  minimal: ['lint', 'health'],
  pilot: ['lint', 'health', 'inference'],
  platform: ['ci', 'release', 'lint', 'health', 'inference'],
  full: WORKSPACE_INIT_MODULES,
} as const satisfies Readonly<Record<string, readonly WorkspaceInitModule[]>>;
export type WorkspaceInitProfile = keyof typeof WORKSPACE_INIT_PROFILES;
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
  readonly type: 'application' | 'library' | 'ambiguous';
  readonly tagType: string | null;
  readonly platform: string | null;
  readonly evidence: readonly string[];
  readonly targets: readonly string[];
  readonly tags: readonly string[];
}

export interface WorkspaceInitDocumentationClassification {
  readonly path: string;
  readonly type: 'spec' | 'plan' | 'decision' | 'audit' | 'research' | 'report';
  readonly proposedId: string | null;
  readonly basis:
    | 'lifecycle-metadata'
    | 'decision-directory'
    | 'research-directory'
    | 'numbered-corpus';
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
  readonly host: WorkspaceInitHostReadiness | null;
  readonly projects: readonly WorkspaceInitSurveyProject[];
  readonly inventory: WorkspaceInventory;
  readonly manifests: {
    readonly apple: readonly string[];
    readonly cargo: readonly string[];
    readonly cloudflare: readonly string[];
    readonly render: readonly string[];
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
  readonly adoptionTemplates: {
    readonly projects: {
      readonly projects: Readonly<
        Record<
          string,
          {
            readonly type: string;
            readonly platform?: string;
          }
        >
      >;
    };
    readonly documentation: {
      readonly documents: Readonly<
        Record<string, Readonly<Record<string, unknown>>>
      >;
    };
    readonly render: {
      readonly serviceProjects: Readonly<
        Record<
          string,
          {
            readonly project: string;
            readonly root: string;
          }
        >
      >;
    };
  };
}

export interface WorkspaceInitHostReadiness {
  readonly platform: NodeJS.Platform;
  readonly active: {
    readonly node: string;
    readonly npm?: string;
    readonly pnpm?: string;
    readonly yarn?: string;
    readonly bun?: string;
  };
  readonly selectedPackageManager: PackageManager | null;
  readonly ready: boolean;
  readonly issues: readonly string[];
  readonly activation: readonly string[];
}

export interface WorkspaceInitSurveyRecommendation {
  readonly module: WorkspaceInitModule;
  readonly action: 'skip' | 'configure';
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
  readonly packageManager: PackageManager;
  readonly modules: readonly WorkspaceInitModule[];
  readonly operations: readonly WorkspaceInitPlanOperation[];
  readonly reductions: readonly WorkspaceInitReduction[];
  readonly conflicts: readonly string[];
  readonly decisions: readonly string[];
  readonly suggestedCommitBatches: readonly WorkspaceInitCommitBatch[];
}

export interface WorkspaceInitCommitBatch {
  readonly id: string;
  readonly modules: readonly ('baseline' | WorkspaceInitModule)[];
  readonly targets: readonly string[];
  readonly suggestedCommit: string;
}

export interface WorkspaceInitPlanOptions {
  readonly bootstrap?: boolean;
  readonly only?: string | readonly WorkspaceInitModule[];
  readonly profile?: WorkspaceInitProfile;
  readonly docsRoot?: string;
  readonly docsLoader?: string;
  readonly docsModule?: string;
  readonly docsOutput?: string;
  readonly docsLoaderMode?: 'create' | 'adopt';
  readonly docsAdoptionMap?: string;
  readonly defaultScope?: string;
  readonly defaultPlatform?: string;
  readonly adoptionMap?: string;
  readonly toolchainPin?: 'none' | 'nvmrc' | 'node-version' | 'both';
  readonly toolchainNode?: string;
  readonly yes?: boolean;
  readonly packageManager?: PackageManager;
  readonly ciMode?: 'auto' | 'standalone' | 'reusable';
  readonly packageRegistries?: string;
  readonly renderServiceProjects?: string;
  readonly host?: WorkspaceInitHostReadiness | null;
}

export type RenderServiceProjects = Readonly<
  Record<string, { readonly project: string; readonly root: string }>
>;

export interface WorkspaceDocsContract {
  readonly root: string;
  readonly loader: string;
  readonly module: string;
  readonly output: string;
  readonly loaderMode: 'create' | 'adopt';
}

export function resolveWorkspaceDocsContract(
  tree: Tree,
  options: Pick<
    WorkspaceInitPlanOptions,
    'docsRoot' | 'docsLoader' | 'docsModule' | 'docsOutput' | 'docsLoaderMode'
  > = {},
): WorkspaceDocsContract {
  const configured = readJsonObject(tree, 'megamono.json').docs as
    Record<string, unknown> | undefined;
  const contract = {
    root:
      options.docsRoot ??
      (typeof configured?.root === 'string' ? configured.root : 'docs'),
    loader:
      options.docsLoader ??
      (typeof configured?.loader === 'string'
        ? configured.loader
        : 'content-collections.ts'),
    module:
      options.docsModule ??
      (typeof configured?.module === 'string'
        ? configured.module
        : 'content-collections'),
    output:
      options.docsOutput ??
      (typeof configured?.output === 'string'
        ? configured.output
        : '.content-collections'),
    loaderMode:
      options.docsLoaderMode ??
      (configured?.loaderMode === 'adopt' ? 'adopt' : 'create'),
  } as const;
  for (const [name, value] of [
    ['docsRoot', contract.root],
    ['docsLoader', contract.loader],
    ['docsOutput', contract.output],
  ] as const) {
    if (
      !value ||
      value.startsWith('/') ||
      value.includes('\\') ||
      value.split('/').includes('..')
    )
      throw new WorkspaceInitError(
        'options',
        `${name} must be a safe workspace-relative path.`,
      );
  }
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(contract.module))
    throw new WorkspaceInitError(
      'options',
      'docsModule is not a valid import alias.',
    );
  return contract;
}

export function parseRenderServiceProjects(
  tree: Tree,
  value: string,
  inventory: WorkspaceInventory,
): RenderServiceProjects {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new WorkspaceInitError(
      'options',
      `renderServiceProjects must be valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new WorkspaceInitError(
      'options',
      'renderServiceProjects must be a JSON object keyed by Render service name.',
    );
  const knownServices = new Set(
    inventory.deployments.flatMap(
      (deployment) => deployment.renderServices?.map(({ name }) => name) ?? [],
    ),
  );
  const projects = getProjects(tree);
  const result: Record<string, { project: string; root: string }> = {};
  for (const [service, mapping] of Object.entries(parsed)) {
    if (!service.trim() || !knownServices.has(service))
      throw new WorkspaceInitError(
        'options',
        `renderServiceProjects references unknown Render service ${service || '<empty>'}.`,
      );
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
      throw new WorkspaceInitError(
        'options',
        `renderServiceProjects.${service} must contain project and root strings.`,
      );
    const entry = mapping as Record<string, unknown>;
    if (
      typeof entry.project !== 'string' ||
      !entry.project.trim() ||
      typeof entry.root !== 'string' ||
      !entry.root.trim() ||
      entry.root.startsWith('/') ||
      entry.root.includes('\\') ||
      entry.root.split('/').includes('..')
    )
      throw new WorkspaceInitError(
        'options',
        `renderServiceProjects.${service} must contain a known project and safe workspace-relative root.`,
      );
    const project = projects.get(entry.project);
    if (!project)
      throw new WorkspaceInitError(
        'options',
        `renderServiceProjects.${service} references unknown Nx project ${entry.project}.`,
      );
    const root = entry.root.replace(/^\.\//, '').replace(/\/$/, '');
    if (project.root !== root)
      throw new WorkspaceInitError(
        'options',
        `renderServiceProjects.${service} maps ${entry.project} to ${root}, but its Nx root is ${project.root}.`,
      );
    result[service] = { project: entry.project, root };
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => compare(left, right)),
  );
}

function configuredRenderServiceProjects(tree: Tree): string | undefined {
  const plugins = readJsonObject(tree, 'nx.json').plugins;
  if (!Array.isArray(plugins)) return undefined;
  const render = plugins.find(
    (plugin) =>
      plugin &&
      typeof plugin === 'object' &&
      !Array.isArray(plugin) &&
      (plugin as Record<string, unknown>).plugin === '@megamono/nx-render',
  ) as Record<string, unknown> | undefined;
  if (!render || !render.options || typeof render.options !== 'object')
    return undefined;
  const serviceProjects = (render.options as Record<string, unknown>)
    .serviceProjects;
  return serviceProjects &&
    typeof serviceProjects === 'object' &&
    !Array.isArray(serviceProjects)
    ? JSON.stringify(serviceProjects)
    : undefined;
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
  const ignoredDirectoryNames = new Set([
    '.build',
    '.git',
    '.nx',
    '.yalc',
    '.content-collections',
    '.next',
    'DerivedData',
    'coverage',
    'dist',
    'node_modules',
    'tmp',
  ]);
  const visit = (
    directory: string,
    inheritedRules: readonly {
      readonly directory: string;
      readonly matcher: ReturnType<typeof ignore>;
    }[] = [],
  ) => {
    const ignorePath = directory ? `${directory}/.gitignore` : '.gitignore';
    const rules = tree.isFile(ignorePath)
      ? [
          ...inheritedRules,
          {
            directory,
            matcher: ignore().add(tree.read(ignorePath, 'utf8') ?? ''),
          },
        ]
      : inheritedRules;
    for (const child of tree.children(directory).sort(compare)) {
      const path = directory ? `${directory}/${child}` : child;
      if (!tree.isFile(path) && ignoredDirectoryNames.has(child)) continue;
      let ignored = false;
      for (const rule of rules) {
        const relativePath = rule.directory
          ? path.slice(rule.directory.length + 1)
          : path;
        const result = rule.matcher.test(
          tree.isFile(path) ? relativePath : `${relativePath}/`,
        );
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
      if (ignored) continue;
      if (tree.isFile(path)) files.push(path);
      else visit(path, rules);
    }
  };
  visit('');
  return files;
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
const DOCUMENT_DIRECTORIES: Readonly<
  Record<string, WorkspaceInitDocumentationClassification['type']>
> = {
  specs: 'spec',
  plans: 'plan',
  decisions: 'decision',
  audits: 'audit',
  research: 'research',
  reports: 'report',
};

function workspaceDocumentScope(tree: Tree): string {
  try {
    const name = (
      JSON.parse(tree.read('package.json', 'utf8') ?? '{}') as {
        name?: unknown;
      }
    ).name;
    if (typeof name === 'string') {
      const candidate = name.startsWith('@')
        ? name.slice(1).split('/')[0]
        : name;
      const scope = candidate
        ?.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (scope) return scope;
    }
  } catch {
    // Invalid package manifests are diagnosed by the baseline preflight.
  }
  return 'repository';
}

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
  const workspaceScope = workspaceDocumentScope(tree);
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
    } else {
      const numbered = /^(\d{1,4})[-_ ].+\.md$/i.exec(segments.at(-1) ?? '');
      const directoryType = directories
        .map((directory) => DOCUMENT_DIRECTORIES[directory.toLowerCase()])
        .find(Boolean);
      if (numbered && directoryType) {
        type = directoryType;
        basis = 'numbered-corpus';
      }
    }
    for (let index = 0; index < directories.length; index += 1) {
      const directory = directories[index].toLowerCase();
      if (
        DECISION_DIRECTORIES.has(directory) ||
        RESEARCH_DIRECTORIES.has(directory) ||
        DOCUMENT_TYPES.has(directory) ||
        Boolean(DOCUMENT_DIRECTORIES[directory])
      ) {
        corpusDirectories.add(directories.slice(0, index + 1).join('/'));
      }
    }
    if (!type || !basis) continue;
    classifications.push({
      path,
      type,
      proposedId:
        metadataId ??
        (basis === 'numbered-corpus' && type === 'spec'
          ? `spec-${workspaceScope}-${(segments.at(-1)?.match(/^\d{1,4}/)?.[0] ?? '').padStart(4, '0')}`
          : null),
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

function documentTitle(tree: Tree, path: string): string {
  const source = tree.read(path, 'utf8') ?? '';
  return (
    /^#\s+(.+)$/m.exec(source)?.[1]?.trim() ??
    path
      .split('/')
      .at(-1)
      ?.replace(/\.md$/i, '')
      .replace(/^\d{1,8}[-_ ]*/, '')
      .replace(/[-_]+/g, ' ') ??
    path
  );
}

function documentDate(tree: Tree, path: string): string {
  const source = tree.read(path, 'utf8') ?? '';
  const existing = frontmatterField(source, 'date');
  if (existing) return existing;
  const match = /(?:^|[^0-9])(\d{4})-?(\d{2})-?(\d{2})(?:[^0-9]|$)/.exec(path);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '<review-date>';
}

function documentId(
  classification: WorkspaceInitDocumentationClassification,
  scope: string,
  date: string,
  title: string,
): string {
  if (classification.proposedId) return classification.proposedId;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return `<review-${classification.type}-id>`;
  const compactDate = date.replaceAll('-', '');
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'record';
  switch (classification.type) {
    case 'plan':
      return `plan-${scope}-${compactDate}-${slug}`;
    case 'decision':
      return `decision-${compactDate}-${slug}`;
    case 'audit':
      return `audit-${scope}-${compactDate}`;
    case 'research':
      return `research-${compactDate}-${slug}`;
    case 'report':
      return `report-${scope}-${compactDate}T000000Z`;
    case 'spec':
      return '<review-spec-id>';
  }
}

function adoptionTemplates(
  tree: Tree,
  projects: readonly WorkspaceInitSurveyProject[],
  documentation: ReturnType<typeof classifyDocumentation>,
  inventory: WorkspaceInventory,
): WorkspaceInitSurvey['adoptionTemplates'] {
  const projectEntries = projects.flatMap((project) => {
    const missingType = !project.tags.some((tag) => tag.startsWith('type:'));
    const missingPlatform =
      project.type !== 'library' &&
      !project.tags.some((tag) => tag.startsWith('platform:'));
    if (!missingType && !missingPlatform && project.type !== 'ambiguous')
      return [];
    return [
      [
        project.name,
        {
          type:
            project.tagType ??
            (project.type === 'application'
              ? 'app'
              : project.type === 'library'
                ? 'util'
                : '<review-type>'),
          ...(missingPlatform
            ? { platform: project.platform ?? '<review-platform>' }
            : {}),
        },
      ] as const,
    ];
  });
  const scope = workspaceDocumentScope(tree);
  const documentEntries = documentation.classifications.map(
    (classification) => {
      const title = documentTitle(tree, classification.path);
      const date = documentDate(tree, classification.path);
      return [
        classification.path,
        {
          id: documentId(classification, scope, date, title),
          type: classification.type,
          status: 'draft',
          visibility: 'internal',
          projects: [scope],
          topics: [],
          summary: title,
          date,
          supersedes: null,
          references: [],
          external_references: [],
        },
      ] as const;
    },
  );
  const nxProjects = getProjects(tree);
  const renderEntries = inventory.deployments.flatMap((deployment) =>
    (deployment.renderServices ?? []).flatMap((service) => {
      if (service.rootDir !== null) return [];
      const candidate =
        service.projectCandidates.length === 1
          ? service.projectCandidates[0]
          : null;
      return [
        [
          service.name,
          candidate
            ? {
                project: candidate,
                root: nxProjects.get(candidate)?.root ?? '<review-root>',
              }
            : { project: '<review-project>', root: '<review-root>' },
        ] as const,
      ];
    }),
  );
  return {
    projects: { projects: Object.fromEntries(projectEntries) },
    documentation: { documents: Object.fromEntries(documentEntries) },
    render: { serviceProjects: Object.fromEntries(renderEntries) },
  };
}

function detectsEquivalentCi(source: string): boolean {
  const invokesAffected = /\bnx\s+(?:--\s+)?affected\b/.test(source);
  const invokesRunMany = /\bnx\s+(?:--\s+)?run-many\b/.test(source);
  const establishesBase =
    /\bnx-set-shas(?:@|\b)/.test(source) ||
    (/\bNX_BASE\b/.test(source) && /\bNX_HEAD\b/.test(source));
  const checksLifecycleTargets = ['lint', 'test', 'build'].every((target) =>
    new RegExp(`\\b${target}\\b`).test(source),
  );
  return (
    checksLifecycleTargets &&
    ((invokesAffected && establishesBase) || invokesRunMany)
  );
}

function publishableWorkspaceProjects(tree: Tree): readonly string[] {
  return [...getProjects(tree).entries()]
    .flatMap(([name, project]) => {
      const manifest = readJsonObject(
        tree,
        project.root === '.' ? 'package.json' : `${project.root}/package.json`,
      );
      return classifyProjectForAdoption(tree, name, project).kind ===
        'library' &&
        typeof manifest.name === 'string' &&
        manifest.private !== true
        ? [name]
        : [];
    })
    .sort(compare);
}

export function parseWorkspaceInitModules(
  only?: string | readonly WorkspaceInitModule[],
  profile?: WorkspaceInitProfile,
): readonly WorkspaceInitModule[] {
  if (only !== undefined && profile !== undefined)
    throw new WorkspaceInitError(
      'options',
      'Select either --only or --profile, not both.',
    );
  if (profile !== undefined) return WORKSPACE_INIT_PROFILES[profile];
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

export function surveyWorkspaceInit(
  tree: Tree,
  options: {
    readonly adoptionMap?: string;
    readonly defaultPlatform?: string;
    readonly resolutions?: ProjectAdoptionResolutions;
    readonly host?: WorkspaceInitHostReadiness;
  } = {},
): WorkspaceInitSurvey {
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
  const resolutions =
    options.resolutions ??
    readProjectAdoptionResolutions(tree, options.adoptionMap);
  const workspaceProjects = getProjects(tree);
  const unknownResolutions = Object.keys(resolutions).filter(
    (name) => !workspaceProjects.has(name),
  );
  if (unknownResolutions.length > 0)
    throw new WorkspaceInitError(
      'options',
      `adoptionMap contains unknown Nx projects: ${unknownResolutions.sort(compare).join(', ')}.`,
    );
  const projects = [...workspaceProjects.entries()]
    .map(([name, project]) => {
      const classification = classifyProjectForAdoption(
        tree,
        name,
        project,
        resolutions,
        options.defaultPlatform as ProjectAdoptionPlatform | undefined,
      );
      return {
        name,
        root: project.root,
        type: classification.kind,
        tagType: classification.type ?? null,
        platform: classification.platform ?? null,
        evidence: classification.evidence,
        targets: Object.keys(project.targets ?? {}).sort(compare),
        tags: [...(project.tags ?? [])].sort(compare),
      };
    })
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
      ![
        '.github/workflows/megamono-ci.yml',
        '.github/workflows/megamono-ci-reusable.yml',
      ].includes(path) && detectsEquivalentCi(tree.read(path, 'utf8') ?? ''),
  );
  const contentCollections = files.filter((path) =>
    /(?:^|\/)content-collections\.(?:ts|js|mts|mjs)$/.test(path),
  );
  const configuredMegamono = readJsonObject(tree, 'megamono.json');
  const configuredDocs =
    configuredMegamono.docs &&
    typeof configuredMegamono.docs === 'object' &&
    !Array.isArray(configuredMegamono.docs)
      ? (configuredMegamono.docs as Record<string, unknown>)
      : undefined;
  let managedDocsLoader =
    typeof configuredDocs?.loader === 'string' ? configuredDocs.loader : null;
  if (!managedDocsLoader && tree.exists('.megamono/artifacts.json')) {
    try {
      const loaderArtifact = readArtifactRegistry(tree).artifacts.find(
        (artifact) =>
          artifact.id === 'docs.loader' && artifact.state !== 'ejected',
      );
      managedDocsLoader = loaderArtifact?.target ?? null;
    } catch {
      // Mutation preflight reports malformed ownership registries. Survey keeps
      // inventory available and treats an unreadable loader as repository-owned.
    }
  }
  const coexistingContentCollections = contentCollections.filter(
    (path) => path !== managedDocsLoader,
  );
  const inventory = createWorkspaceInventory(tree, workspaceProjects, files);
  const unmappedRenderServices = inventory.deployments.flatMap((deployment) =>
    (deployment.renderServices ?? []).filter(({ rootDir }) => rootDir === null),
  );
  return {
    schemaVersion: 1,
    baseline: {
      packageManager,
      node: typeof engines.node === 'string' ? engines.node : null,
      nx: dependencyVersion(manifest, 'nx'),
      typescript: dependencyVersion(manifest, 'typescript'),
      lockfiles: [
        'package-lock.json',
        'npm-shrinkwrap.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'bun.lock',
        'bun.lockb',
      ].filter((path) => files.includes(path)),
    },
    host: options.host ?? null,
    projects,
    inventory,
    manifests: {
      apple: files.filter((path) => path.endsWith('Package.swift')),
      cargo: files.filter((path) => path.endsWith('Cargo.toml')),
      cloudflare: files.filter((path) =>
        /(?:^|\/)wrangler\.(?:jsonc?|toml)$/.test(path),
      ),
      render: files.filter((path) => /(?:^|\/)render\.yaml$/.test(path)),
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
      contentCollections,
      megamono: ['megamono.json', '.megamono/artifacts.json'].filter((path) =>
        files.includes(path),
      ),
    },
    recommendations: [
      ...(equivalentAffectedCi.length > 0
        ? [
            {
              module: 'ci' as const,
              action: 'skip' as const,
              paths: equivalentAffectedCi,
              reason:
                'Existing repository-owned CI runs lint, test, and build through Nx affected or full-workspace run-many.',
            },
          ]
        : []),
      ...(coexistingContentCollections.length > 0
        ? [
            {
              module: 'docs' as const,
              action: 'configure' as const,
              paths: coexistingContentCollections,
              reason:
                'Keep the existing Content Collections setup separate by passing --docsLoader=.megamono/content-collections.ts --docsModule=megamono-docs --docsOutput=.megamono/content-collections, or explicitly adopt a compatible loader with --docsLoaderMode=adopt.',
            },
          ]
        : []),
      ...(unmappedRenderServices.length > 0
        ? [
            {
              module: 'inference' as const,
              action: 'configure' as const,
              paths: inventory.deployments
                .filter(({ provider }) => provider === 'render')
                .flatMap(({ paths }) => paths),
              reason:
                'Review the generated Render service project map and pass it with --renderServiceProjects; root-level Render commands must not be attached to guessed Nx projects.',
            },
          ]
        : []),
    ],
    adoptionTemplates: adoptionTemplates(
      tree,
      projects,
      documentation,
      inventory,
    ),
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
  const modules = parseWorkspaceInitModules(options.only, options.profile);
  const survey = surveyWorkspaceInit(tree, {
    adoptionMap: options.adoptionMap,
    defaultPlatform: options.defaultPlatform,
  });
  const declaredManager = survey.baseline.packageManager?.split('@')[0];
  const detectedManagers = lockfileManagers((path) => tree.exists(path));
  const packageManager =
    options.packageManager ??
    (declaredManager && isPackageManager(declaredManager)
      ? declaredManager
      : detectedManagers[0]) ??
    'npm';
  const docs = resolveWorkspaceDocsContract(tree, options);
  const docsRoot = docs.root;
  const operations: WorkspaceInitPlanOperation[] = [];
  const reductions: WorkspaceInitReduction[] = [];
  const conflicts: string[] = [];
  const decisions: string[] = [];
  if (options.host && !options.host.ready) {
    conflicts.push(...options.host.issues);
  }
  const dependencyAssessments = workspaceInitDependencyAssessments(
    tree,
    new Set(modules),
  );
  for (const assessment of dependencyAssessments) {
    if (assessment.action === 'conflict') {
      conflicts.push(assessment.message);
    }
  }
  let packageRegistries: Readonly<Record<string, string>> = {};
  if (options.packageRegistries !== undefined) {
    try {
      packageRegistries = parsePackageRegistries(options.packageRegistries);
    } catch (error) {
      conflicts.push(error instanceof Error ? error.message : String(error));
    }
  }
  let renderServiceProjects: RenderServiceProjects = {};
  let renderServiceProjectsValid = true;
  const renderServiceProjectsInput =
    options.renderServiceProjects ?? configuredRenderServiceProjects(tree);
  if (renderServiceProjectsInput !== undefined) {
    try {
      renderServiceProjects = parseRenderServiceProjects(
        tree,
        renderServiceProjectsInput,
        survey.inventory,
      );
    } catch (error) {
      renderServiceProjectsValid = false;
      conflicts.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (modules.includes('inference') && renderServiceProjectsValid) {
    const unmapped = survey.inventory.deployments.flatMap((deployment) =>
      (deployment.renderServices ?? [])
        .filter(
          ({ name, rootDir }) =>
            rootDir === null && !renderServiceProjects[name],
        )
        .map(({ name }) => name),
    );
    if (unmapped.length > 0)
      decisions.push(
        `Render services ${unmapped.join(', ')} have no rootDir; review survey.adoptionTemplates.render.serviceProjects and pass --renderServiceProjects='<json>'.`,
      );
  }
  let docsAdoptionEntries: ReturnType<typeof readDocsAdoptionMap> = [];
  if (modules.includes('docs') && options.docsAdoptionMap) {
    try {
      docsAdoptionEntries = readDocsAdoptionMap(tree, options.docsAdoptionMap);
    } catch (error) {
      conflicts.push(error instanceof Error ? error.message : String(error));
    }
  }
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
    survey.baseline.packageManager
      ? 'retain'
      : options.bootstrap
        ? 'modify'
        : 'retain',
    survey.baseline.packageManager || options.bootstrap
      ? 'package.json#packageManager'
      : 'package.json',
    survey.baseline.packageManager
      ? `Preserve the repository-owned ${survey.baseline.packageManager} declaration.`
      : options.bootstrap
        ? `Record ${packageManager} for the new workspace.`
        : `Infer ${packageManager} from the root lockfile without adding packageManager ownership.`,
  );
  const toolchainPin = options.toolchainPin ?? 'none';
  if (toolchainPin === 'none' && options.toolchainNode) {
    throw new WorkspaceInitError(
      'options',
      'toolchainNode requires --toolchainPin=nvmrc|node-version|both.',
    );
  }
  if (toolchainPin !== 'none') {
    if (!options.toolchainNode) {
      decisions.push(
        `toolchainNode is required when toolchainPin=${toolchainPin}.`,
      );
    } else {
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(options.toolchainNode);
      const major = match ? Number(match[1]) : -1;
      const minor = match ? Number(match[2]) : -1;
      if (!match || major < 18 || major >= 25 || (major === 18 && minor < 18)) {
        throw new WorkspaceInitError(
          'options',
          `toolchainNode ${options.toolchainNode} is unsupported; expected an exact version in >=18.18 <25.`,
        );
      }
      const pinPaths = [
        ...(toolchainPin === 'nvmrc' || toolchainPin === 'both'
          ? ['.nvmrc']
          : []),
        ...(toolchainPin === 'node-version' || toolchainPin === 'both'
          ? ['.node-version']
          : []),
      ];
      for (const path of pinPaths) {
        const current = tree.read(path, 'utf8')?.trim();
        operation(
          operations,
          'baseline',
          current === options.toolchainNode ? 'retain' : 'add',
          path,
          `Seed the selected Node ${options.toolchainNode} runtime pin.`,
        );
        if (current && current !== options.toolchainNode)
          conflicts.push(
            `${path} already pins repository-owned Node ${current}; requested ${options.toolchainNode}.`,
          );
      }
    }
  }
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
  if (options.packageRegistries !== undefined) {
    operation(
      operations,
      'baseline',
      tree.exists('.npmrc') ? 'modify' : 'add',
      '.npmrc',
      'Route configured package scopes to reproducible registries without storing authentication.',
    );
    const npmrc = tree.read('.npmrc', 'utf8') ?? '';
    for (const [scope, registry] of Object.entries(packageRegistries)) {
      const existing = new RegExp(
        `^${scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:registry=(.+)$`,
        'm',
      )
        .exec(npmrc)?.[1]
        ?.trim();
      if (existing && existing.replace(/\/+$/, '') !== registry) {
        conflicts.push(
          `.npmrc already routes ${scope} to ${existing}; requested ${registry}.`,
        );
      }
    }
    if (Object.keys(packageRegistries).length === 0) {
      conflicts.push('packageRegistries must contain at least one scope.');
    }
  }
  if (modules.includes('docs')) {
    for (const { path } of docsAdoptionEntries) {
      operation(
        operations,
        'docs',
        'modify',
        path,
        'Apply explicitly reviewed Megamono lifecycle metadata without moving the document.',
      );
    }
    operation(
      operations,
      'docs',
      docs.loaderMode === 'adopt'
        ? tree.exists(docs.loader)
          ? 'retain'
          : 'skip'
        : managedAction('docs.loader', docs.loader),
      docs.loader,
      docs.loaderMode === 'adopt'
        ? 'Retain the explicitly adopted repository-owned docs loader.'
        : 'Configure the repository docs loader.',
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
    for (const key of [docs.module, `${docs.module}/*`]) {
      operation(
        operations,
        'docs',
        'modify',
        `tsconfig.base.json#compilerOptions.paths.${key}`,
        'Map generated Content Collections modules for TypeScript.',
      );
    }
    for (const dependency of dependencyAssessments.filter(
      ({ name }) => name === '@content-collections/core' || name === 'zod',
    )) {
      if (dependency.action === 'absent' || dependency.action === 'conflict')
        continue;
      operation(
        operations,
        'docs',
        dependency.action === 'add' ? 'modify' : 'retain',
        dependency.action === 'add'
          ? `package.json#devDependencies.${dependency.name}`
          : `package.json#${dependency.section}.${dependency.name}`,
        dependency.message,
      );
    }
    if (
      docs.loaderMode === 'create' &&
      tree.exists(docs.loader) &&
      !owned('docs.loader', docs.loader) &&
      !ejected('docs.loader', docs.loader)
    ) {
      conflicts.push(
        `${docs.loader} is occupied by a repository-owned configuration. Select it with --docsLoaderMode=adopt when compatible, or choose a separate --docsLoader, --docsModule, and --docsOutput.`,
      );
    }
    if (docs.loaderMode === 'adopt') {
      const source = tree.read(docs.loader, 'utf8');
      if (!source) {
        conflicts.push(`${docs.loader} does not exist and cannot be adopted.`);
      } else if (
        !/name\s*:\s*['"]repoDocs['"]/.test(source) ||
        !/name\s*:\s*['"]archivedDocs['"]/.test(source)
      ) {
        conflicts.push(
          `${docs.loader} does not expose the repoDocs and archivedDocs collections required by Megamono. Choose a separate generated loader instead of adopting it.`,
        );
      }
    }
    const tsconfigPath = tree.exists('tsconfig.base.json')
      ? 'tsconfig.base.json'
      : 'tsconfig.json';
    const compilerOptions = readJsonObject(tree, tsconfigPath)
      .compilerOptions as Record<string, unknown> | undefined;
    const paths = compilerOptions?.paths as Record<string, unknown> | undefined;
    for (const [key, expected] of [
      [docs.module, [`./${docs.output}/index.js`]],
      [`${docs.module}/*`, [`./${docs.output}/*.js`]],
    ] as const) {
      const current = paths?.[key];
      if (current && JSON.stringify(current) !== JSON.stringify(expected))
        conflicts.push(
          `${tsconfigPath} already defines ${key} as ${JSON.stringify(current)}; requested ${JSON.stringify(expected)}.`,
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
    const ciMode = options.ciMode ?? 'auto';
    const equivalent = survey.recommendations.find(
      (recommendation) => recommendation.module === 'ci',
    );
    const target =
      ciMode === 'reusable'
        ? '.github/workflows/megamono-ci-reusable.yml'
        : '.github/workflows/megamono-ci.yml';
    if (ciMode === 'auto' && equivalent) {
      for (const path of equivalent.paths)
        operation(
          operations,
          'ci',
          'retain',
          path,
          'Retain equivalent repository-owned CI without adding a duplicate workflow.',
        );
    } else {
      operation(
        operations,
        'ci',
        managedAction('ci.affected', target),
        target,
        ciMode === 'reusable'
          ? 'Add a bounded reusable affected-CI workflow without editing callers.'
          : 'Add dedicated affected CI.',
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
  }
  if (modules.includes('release')) {
    const publishableProjects = publishableWorkspaceProjects(tree);
    if (publishableProjects.length === 0) {
      reductions.push({
        module: 'release',
        capability: 'package-publishing',
        reason:
          'No publishable library package manifests were detected; release artifacts will be deferred until one exists.',
      });
    } else {
      const existingNx = readJsonObject(tree, 'nx.json');
      operation(
        operations,
        'release',
        existingNx.release === undefined ? 'modify' : 'retain',
        'nx.json#release',
        existingNx.release === undefined
          ? `Configure a fixed workspace release group for: ${publishableProjects.join(', ')}.`
          : 'Retain the repository-owned Nx Release configuration.',
      );
      operation(
        operations,
        'release',
        'modify',
        'nx.json#namedInputs.sharedGlobals',
        'Invalidate Nx caches when yalc-linked package contents change.',
      );
      operation(
        operations,
        'release',
        managedAction('release.yalc-publisher', '.megamono/publish-yalc.mjs'),
        '.megamono/publish-yalc.mjs',
        'Build publishable projects and publish their dist outputs to yalc.',
      );
      operation(
        operations,
        'release',
        managedAction(
          'release.workflow',
          '.github/workflows/megamono-release.yml',
        ),
        '.github/workflows/megamono-release.yml',
        'Add a manually dispatched next-tag prerelease workflow.',
      );
      operation(
        operations,
        'release',
        'modify',
        'package.json#scripts.megamono:yalc-publish',
        'Expose the generated local-package publishing command.',
      );
      for (const [id, target] of [
        ['release.yalc-publisher', '.megamono/publish-yalc.mjs'],
        ['release.workflow', '.github/workflows/megamono-release.yml'],
      ] as const) {
        if (tree.exists(target) && !owned(id, target) && !ejected(id, target)) {
          conflicts.push(
            `${target} is occupied without Megamono ownership metadata.`,
          );
        }
      }
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
        !project.platform &&
        !project.tags.some((tag) => tag.startsWith('platform:')),
    );
    const ambiguousProjects = survey.projects.filter(
      (project) => project.type === 'ambiguous',
    );
    if (ambiguousProjects.length > 0) {
      decisions.push(
        `adoptionMap project type is required for: ${ambiguousProjects
          .map(({ name }) => name)
          .join(', ')}.`,
      );
    }
    if (untaggedApplications.length > 0 && !options.defaultPlatform) {
      decisions.push(
        `defaultPlatform is required for: ${untaggedApplications.map(({ name }) => name).join(', ')}.`,
      );
    }
    for (const project of survey.projects) {
      if (project.name === 'megamono' || project.name === 'megamono-docs')
        continue;
      const additions = [
        ...(project.tags.some((tag) => tag.startsWith('type:')) ||
        project.type === 'ambiguous'
          ? []
          : [
              `type:${
                project.tagType ??
                (project.type === 'application' ? 'app' : 'util')
              }`,
            ]),
        ...(project.tags.some((tag) => tag.startsWith('scope:'))
          ? []
          : [`scope:${options.defaultScope ?? 'shared'}`]),
        ...(project.type === 'application' &&
        !project.tags.some((tag) => tag.startsWith('platform:'))
          ? [`platform:${project.platform ?? '<required>'}`]
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
    const inferenceSupported = nxWorkspaceCapabilities(tree).major >= 18;
    for (const [platform, manifests] of [
      ['apple', survey.manifests.apple],
      ['cargo', survey.manifests.cargo],
      ['cloudflare', survey.manifests.cloudflare],
      ['render', survey.manifests.render],
    ] as const) {
      operation(
        operations,
        'inference',
        manifests.length > 0 && inferenceSupported ? 'add' : 'skip',
        platform,
        manifests.length > 0
          ? inferenceSupported
            ? `Register the supported ${platform} inference plugin for ${manifests.join(', ')}.`
            : `Nx 17 cannot load the async ${platform} inference plugin for ${manifests.join(', ')}; upgrade to Nx 18 or newer to enable it.`
          : `No ${platform} manifests were detected.`,
      );
      if (manifests.length > 0 && !inferenceSupported) {
        reductions.push({
          module: 'inference',
          capability: `${platform}-plugin`,
          reason: `Nx 17 uses a synchronous project-inference callback; @megamono/nx-${platform} requires Nx 18 or newer.`,
        });
      }
      if (manifests.length > 0 && inferenceSupported) {
        const plugin =
          platform === 'apple'
            ? '@megamono/nx-apple'
            : platform === 'cargo'
              ? '@megamono/nx-cargo'
              : platform === 'cloudflare'
                ? '@megamono/nx-cloudflare'
                : '@megamono/nx-render';
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
    packageManager,
    modules,
    operations,
    reductions,
    conflicts,
    decisions,
    suggestedCommitBatches: commitBatches(operations, modules),
  };
}

const MODULE_COMMIT_SUBJECTS: Readonly<Record<WorkspaceInitModule, string>> = {
  docs: 'adopt Megamono documentation governance',
  agents: 'add Megamono agent guidance',
  ci: 'integrate Megamono CI checks',
  release: 'configure Megamono release governance',
  lint: 'adopt Megamono project boundaries',
  skills: 'install Megamono workspace skills',
  health: 'add Megamono workspace health checks',
  inference: 'enable Megamono platform inference',
};

function commitBatches(
  operations: readonly WorkspaceInitPlanOperation[],
  modules: readonly WorkspaceInitModule[],
): readonly WorkspaceInitCommitBatch[] {
  return modules.map((module, index) => {
    const included = operations.filter(
      (entry) =>
        entry.module === module || (index === 0 && entry.module === 'baseline'),
    );
    return {
      id: index === 0 ? `baseline-${module}` : module,
      modules: index === 0 ? ['baseline', module] : [module],
      targets: [...new Set(included.map(({ target }) => target))],
      suggestedCommit: `chore: ${MODULE_COMMIT_SUBJECTS[module]}`,
    };
  });
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

## Active host readiness

${
  survey.host
    ? `- Platform: ${survey.host.platform}
- Active Node: ${survey.host.active.node}
- Selected package manager: ${survey.host.selectedPackageManager ?? 'unresolved'}
- Active package-manager version: ${survey.host.selectedPackageManager ? (survey.host.active[survey.host.selectedPackageManager] ?? 'unavailable') : 'unresolved'}
- Ready: ${survey.host.ready ? 'yes' : 'no'}

### Readiness issues

${values(survey.host.issues)}

### Activation guidance

${values(survey.host.activation)}`
    : '- Not collected by this caller.'
}

## Projects

${values(
  survey.projects.map(
    (project) =>
      `${project.name} — ${project.type}${project.platform ? ` (${project.platform})` : ''} at ${project.root}; targets: ${project.targets.join(', ') || 'none'}; tags: ${project.tags.join(', ') || 'none'}; evidence: ${project.evidence.join(', ')}`,
  ),
)}

## Integration inventory (schema v${survey.inventory.schemaVersion})

### Project technologies

${values(
  survey.inventory.projects.map(
    (project) =>
      `${project.name} — frameworks: ${project.frameworks.map(({ value }) => value).join(', ') || 'none'}${project.nextRouter ? `; Next router: ${project.nextRouter}` : ''}; services: ${project.serviceKinds.join(', ') || 'none'}; environment names: ${project.environmentNames.join(', ') || 'none'}`,
  ),
)}

### Databases

${values(
  survey.inventory.databases.map(
    (database) =>
      `${database.name ?? '<name-required>'} — ${database.adapter}/${database.provider ?? 'unknown'} at ${database.schema}; Nx project: ${database.project ?? 'unresolved'}; migrations: ${database.migrations ?? 'none detected'}`,
  ),
)}

### Runtime services

${values(
  survey.inventory.services.map(
    (service) =>
      `${service.kind}/${service.provider} — projects: ${service.projects.join(', ')}`,
  ),
)}

### Deployments

${values(
  survey.inventory.deployments.map(
    (deployment) =>
      `${deployment.provider} (${deployment.authority}) — ${deployment.paths.join(', ')}; services: ${deployment.services.join(', ') || 'not declared'}`,
  ),
)}

### Integration ambiguities

${values(survey.inventory.ambiguities)}

## Inference manifests

### Apple

${values(survey.manifests.apple)}

### Cargo

${values(survey.manifests.cargo)}

### Cloudflare

${values(survey.manifests.cloudflare)}

### Render

${values(survey.manifests.render)}

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
      `${module}: ${action}; ${action === 'skip' ? 'retain' : 'resolve around'} ${paths.join(', ')} — ${reason}`,
  ),
)}

## Copy-ready adoption maps

Review placeholder values before passing either map back to init.

### Project adoption map

\`\`\`json
${JSON.stringify(survey.adoptionTemplates.projects, null, 2)}
\`\`\`

### Documentation adoption map

\`\`\`json
${JSON.stringify(survey.adoptionTemplates.documentation, null, 2)}
\`\`\`

### Render service project map

Pass the reviewed \`serviceProjects\` value to \`--renderServiceProjects\`.

\`\`\`json
${JSON.stringify(survey.adoptionTemplates.render, null, 2)}
\`\`\`
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

- Package manager: ${plan.packageManager}
- Modules: ${plan.modules.join(', ')}

## Ordered operations

${lines.join('\n')}

## Capability reductions

${reductions.join('\n')}

## Conflicts

${conflicts.join('\n')}

## Decisions required

${decisions.join('\n')}

## Suggested commit batches

${plan.suggestedCommitBatches
  .map(
    ({ id, modules, targets, suggestedCommit }) =>
      `- **${id}** (${modules.join(', ')}): ${targets.join(', ') || 'no file changes'} — \`${suggestedCommit}\``,
  )
  .join('\n')}
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
  const nx = packageManagerAdapter(plan.packageManager).nx;
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
