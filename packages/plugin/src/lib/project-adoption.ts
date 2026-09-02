import type { ProjectConfiguration, Tree } from '@nx/devkit';
import { isSafeWorkspaceRelativePath } from './config';

export const PROJECT_ADOPTION_TYPES = [
  'app',
  'feature',
  'ui',
  'data',
  'util',
] as const;

export const PROJECT_ADOPTION_PLATFORMS = [
  'web',
  'node',
  'worker',
  'mobile',
  'apple',
  'rust',
  'php',
  'extension',
] as const;

export type ProjectAdoptionType = (typeof PROJECT_ADOPTION_TYPES)[number];
export type ProjectAdoptionPlatform =
  (typeof PROJECT_ADOPTION_PLATFORMS)[number];

export interface ProjectAdoptionResolution {
  readonly type?: ProjectAdoptionType;
  readonly platform?: ProjectAdoptionPlatform;
}

export type ProjectAdoptionResolutions = Readonly<
  Record<string, ProjectAdoptionResolution>
>;

export interface ProjectAdoptionClassification {
  readonly kind: 'application' | 'library' | 'ambiguous';
  readonly type?: ProjectAdoptionType;
  readonly platform?: ProjectAdoptionPlatform;
  readonly evidence: readonly string[];
}

function readJsonObject(tree: Tree, path: string): Record<string, unknown> {
  const source = tree.read(path, 'utf8');
  if (!source) return {};
  try {
    const parsed = JSON.parse(source) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function projectTag(
  project: ProjectConfiguration,
  prefix: string,
): string | undefined {
  return project.tags
    ?.find((tag) => tag.startsWith(prefix))
    ?.slice(prefix.length);
}

function commandText(project: ProjectConfiguration): string {
  return Object.values(project.targets ?? {})
    .map((target) => {
      const options = target.options as Record<string, unknown> | undefined;
      return [target.executor, options?.command, options?.cwd]
        .filter((value): value is string => typeof value === 'string')
        .join(' ');
    })
    .join('\n');
}

function inferKind(
  tree: Tree,
  project: ProjectConfiguration,
): {
  readonly kind: ProjectAdoptionClassification['kind'];
  readonly evidence: string[];
} {
  const applications: string[] = [];
  const libraries: string[] = [];
  const add = (kind: 'application' | 'library', reason: string) =>
    (kind === 'application' ? applications : libraries).push(reason);

  if (project.projectType === 'application')
    add('application', 'Nx projectType=application');
  if (project.projectType === 'library')
    add('library', 'Nx projectType=library');

  const taggedType = projectTag(project, 'type:');
  if (taggedType === 'app') add('application', 'type:app tag');
  if (
    taggedType &&
    PROJECT_ADOPTION_TYPES.includes(taggedType as ProjectAdoptionType) &&
    taggedType !== 'app'
  )
    add('library', `type:${taggedType} tag`);

  if (tree.exists(`${project.root}/tsconfig.app.json`))
    add('application', 'tsconfig.app.json');
  if (tree.exists(`${project.root}/tsconfig.lib.json`))
    add('library', 'tsconfig.lib.json');

  const firstRootSegment = project.root.replace(/^\.\//, '').split('/')[0];
  if (firstRootSegment === 'apps') add('application', 'apps/ project root');
  if (firstRootSegment === 'libs' || firstRootSegment === 'packages')
    add('library', `${firstRootSegment}/ project root`);

  const commands = commandText(project);
  if (/\b(?:next|nest|webpack-cli)\s+(?:dev|start|serve)\b/.test(commands))
    add('application', 'executable framework target');
  if (
    Object.keys(project.targets ?? {}).some((name) =>
      ['serve', 'start', 'dev', 'e2e'].includes(name),
    )
  )
    add('application', 'application lifecycle target');

  const evidence = [...applications, ...libraries];
  if (applications.length > 0 && libraries.length > 0)
    return { kind: 'ambiguous', evidence };
  if (applications.length > 0) return { kind: 'application', evidence };
  if (libraries.length > 0) return { kind: 'library', evidence };
  return {
    kind: 'ambiguous',
    evidence: ['no reliable application/library evidence'],
  };
}

function inferPlatform(
  tree: Tree,
  project: ProjectConfiguration,
): {
  readonly platform?: ProjectAdoptionPlatform;
  readonly evidence: string[];
} {
  const candidates = new Map<ProjectAdoptionPlatform, string[]>();
  const add = (platform: ProjectAdoptionPlatform, reason: string) =>
    candidates.set(platform, [...(candidates.get(platform) ?? []), reason]);
  const root = project.root;
  const commands = commandText(project);
  const manifest = readJsonObject(tree, `${root}/package.json`);
  const dependencies = {
    ...((manifest.dependencies as Record<string, unknown> | undefined) ?? {}),
    ...((manifest.devDependencies as Record<string, unknown> | undefined) ??
      {}),
  };

  if (
    ['next.config.js', 'next.config.mjs', 'next.config.ts'].some((name) =>
      tree.exists(`${root}/${name}`),
    ) ||
    typeof dependencies.next === 'string' ||
    /\bnext\s+(?:build|dev|start)\b/.test(commands)
  )
    add('web', 'Next.js project');
  if (
    tree.exists(`${root}/nest-cli.json`) ||
    typeof dependencies['@nestjs/core'] === 'string' ||
    /\b(?:node|nest|webpack-cli)\b/.test(commands)
  )
    add('node', 'Node/Nest executable target');
  if (
    tree.exists(`${root}/app.json`) ||
    typeof dependencies.expo === 'string' ||
    typeof dependencies['react-native'] === 'string' ||
    /\bexpo\s+(?:start|export|run:android|run:ios)\b/.test(commands)
  )
    add('mobile', 'Expo/React Native project');
  if (
    ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'].some((name) =>
      tree.exists(`${root}/${name}`),
    )
  )
    add('worker', 'Wrangler configuration');
  if (
    tree.exists(`${root}/Package.swift`) ||
    tree
      .children(root)
      .some(
        (name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'),
      )
  )
    add('apple', 'Apple manifest');
  if (tree.exists(`${root}/Cargo.toml`)) add('rust', 'Cargo manifest');
  if (tree.exists(`${root}/composer.json`)) add('php', 'Composer manifest');

  if (candidates.size !== 1)
    return {
      evidence: [...candidates.entries()].flatMap(([platform, reasons]) =>
        reasons.map((reason) => `${platform}: ${reason}`),
      ),
    };
  const [platform, reasons] = [...candidates.entries()][0];
  return { platform, evidence: reasons };
}

export function classifyProjectForAdoption(
  tree: Tree,
  name: string,
  project: ProjectConfiguration,
  resolutions: ProjectAdoptionResolutions = {},
  defaultPlatform?: ProjectAdoptionPlatform,
): ProjectAdoptionClassification {
  const resolution = resolutions[name];
  const inferredKind = inferKind(tree, project);
  const inferredPlatform = inferPlatform(tree, project);
  const existingType = projectTag(project, 'type:') as
    ProjectAdoptionType | undefined;
  const existingPlatform = projectTag(project, 'platform:') as
    ProjectAdoptionPlatform | undefined;
  const type = resolution?.type ?? existingType;
  const kind = type
    ? type === 'app'
      ? 'application'
      : 'library'
    : inferredKind.kind;
  return {
    kind,
    ...(type ? { type } : {}),
    ...((resolution?.platform ??
    existingPlatform ??
    inferredPlatform.platform ??
    (kind === 'application' ? defaultPlatform : undefined))
      ? {
          platform:
            resolution?.platform ??
            existingPlatform ??
            inferredPlatform.platform ??
            defaultPlatform,
        }
      : {}),
    evidence: [
      ...(resolution?.type
        ? [`adoption map type=${resolution.type}`]
        : inferredKind.evidence),
      ...(resolution?.platform
        ? [`adoption map platform=${resolution.platform}`]
        : inferredPlatform.evidence),
    ],
  };
}

export function readProjectAdoptionResolutions(
  tree: Tree,
  path?: string,
): ProjectAdoptionResolutions {
  if (!path) return {};
  const normalized = path.replace(/^\.\//, '').replace(/\/$/, '');
  if (!isSafeWorkspaceRelativePath(normalized) || !tree.exists(normalized))
    throw new Error(
      `adoptionMap must name an existing workspace-relative JSON file; received ${path}.`,
    );
  let value: unknown;
  try {
    value = JSON.parse(tree.read(normalized, 'utf8') ?? '');
  } catch {
    throw new Error(`${normalized} is not valid JSON.`);
  }
  const projects = (value as { projects?: unknown } | null)?.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects))
    throw new Error(`${normalized} must contain a projects object.`);
  for (const [name, raw] of Object.entries(projects)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(`${normalized} projects.${name} must be an object.`);
    const resolution = raw as { type?: unknown; platform?: unknown };
    if (
      resolution.type !== undefined &&
      !PROJECT_ADOPTION_TYPES.includes(resolution.type as ProjectAdoptionType)
    )
      throw new Error(`${normalized} projects.${name}.type is unsupported.`);
    if (
      resolution.platform !== undefined &&
      !PROJECT_ADOPTION_PLATFORMS.includes(
        resolution.platform as ProjectAdoptionPlatform,
      )
    )
      throw new Error(
        `${normalized} projects.${name}.platform is unsupported.`,
      );
    if (resolution.type === undefined && resolution.platform === undefined)
      throw new Error(
        `${normalized} projects.${name} must set type or platform.`,
      );
  }
  return projects as ProjectAdoptionResolutions;
}
