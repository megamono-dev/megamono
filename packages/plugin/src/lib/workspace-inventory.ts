import type { ProjectConfiguration, Tree } from '@nx/devkit';

export type WorkspaceFramework =
  'nest' | 'next' | 'expo' | 'react-native' | 'vite';
export type WorkspaceServiceKind = 'cache' | 'queue';

export interface WorkspaceInventoryEvidence {
  readonly value: string;
  readonly evidence: readonly string[];
}

export interface WorkspaceInventoryProject {
  readonly name: string;
  readonly root: string;
  readonly frameworks: readonly WorkspaceInventoryEvidence[];
  readonly nextRouter?: 'app' | 'mixed' | 'pages';
  readonly externalPackages: readonly string[];
  readonly environmentNames: readonly string[];
  readonly serviceKinds: readonly WorkspaceServiceKind[];
}

export interface WorkspaceInventoryDatabase {
  readonly name: string | null;
  readonly adapter: 'prisma';
  readonly schema: string;
  readonly provider: string | null;
  readonly project: string | null;
  readonly migrations: string | null;
}

export interface WorkspaceInventoryService {
  readonly kind: WorkspaceServiceKind;
  readonly provider: 'bullmq' | 'redis';
  readonly projects: readonly string[];
  readonly evidence: readonly string[];
}

export interface WorkspaceInventoryDeployment {
  readonly provider: 'docker' | 'render';
  readonly authority: 'manifest' | 'partial-marker';
  readonly paths: readonly string[];
  readonly services: readonly string[];
}

export interface WorkspaceInventory {
  readonly schemaVersion: 1;
  readonly projects: readonly WorkspaceInventoryProject[];
  readonly databases: readonly WorkspaceInventoryDatabase[];
  readonly services: readonly WorkspaceInventoryService[];
  readonly deployments: readonly WorkspaceInventoryDeployment[];
  readonly ambiguities: readonly string[];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function dependencyMap(
  manifest: Record<string, unknown>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const dependencies = manifest[field];
    if (
      !dependencies ||
      typeof dependencies !== 'object' ||
      Array.isArray(dependencies)
    )
      continue;
    for (const [name, version] of Object.entries(dependencies))
      if (typeof version === 'string') result[name] = version;
  }
  return result;
}

function underRoot(path: string, root: string): boolean {
  const normalized = root.replace(/^\.\//, '').replace(/\/$/, '');
  return path === normalized || path.startsWith(`${normalized}/`);
}

function sourceFiles(files: readonly string[], root: string): string[] {
  return files.filter(
    (path) =>
      underRoot(path, root) &&
      !/(?:^|\/)(?:generated|vendor)(?:\/|$)/.test(path) &&
      /\.(?:[cm]?[jt]sx?|json|mjs|cjs)$/.test(path),
  );
}

function sourceCorpus(tree: Tree, files: readonly string[]): string {
  return files
    .map((path) => tree.read(path, 'utf8') ?? '')
    .filter((source) => source.length <= 1_000_000)
    .join('\n');
}

function packageImports(source: string): string[] {
  const packages = new Set<string>();
  const pattern =
    /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^.'"][^'"]*)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const requested = match[1];
    if (!requested) continue;
    packages.add(
      requested.startsWith('@')
        ? requested.split('/').slice(0, 2).join('/')
        : (requested.split('/')[0] ?? requested),
    );
  }
  return [...packages].sort(compare);
}

function environmentNames(source: string): string[] {
  const names = new Set<string>();
  for (const pattern of [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  ])
    for (const match of source.matchAll(pattern))
      if (match[1]) names.add(match[1]);
  return [...names].sort(compare);
}

function frameworkEvidence(options: {
  readonly tree: Tree;
  readonly root: string;
  readonly files: readonly string[];
  readonly targets: Record<string, unknown>;
  readonly source: string;
}): WorkspaceInventoryEvidence[] {
  const targetSource = JSON.stringify(options.targets);
  const relativeFiles = options.files.filter((path) =>
    underRoot(path, options.root),
  );
  const result: WorkspaceInventoryEvidence[] = [];
  const add = (value: WorkspaceFramework, evidence: readonly string[]) => {
    if (evidence.length > 0)
      result.push({ value, evidence: [...evidence].sort(compare) });
  };
  const marker = (pattern: RegExp) =>
    relativeFiles.filter((path) => pattern.test(path));
  add('next', [
    ...marker(/(?:^|\/)next\.config\.(?:[cm]?[jt]s)$/),
    ...(targetSource.includes('@nx/next') ||
    /\bnext (?:build|dev|start)\b/.test(targetSource)
      ? ['nx-target:next']
      : []),
  ]);
  add('nest', [
    ...marker(/(?:^|\/)nest-cli\.json$/),
    ...(targetSource.includes('@nx/nest') || options.source.includes('@nestjs/')
      ? ['source-or-target:@nestjs']
      : []),
  ]);
  add('expo', [
    ...marker(/(?:^|\/)(?:app\.json|app\.config\.[cm]?[jt]s)$/).filter(
      (path) => {
        const source = options.tree.read(path, 'utf8') ?? '';
        return source.includes('expo');
      },
    ),
    ...(targetSource.includes('@nx/expo') || /\bexpo\b/.test(targetSource)
      ? ['source-or-target:expo']
      : []),
  ]);
  add('react-native', [
    ...(options.source.includes('react-native') ||
    targetSource.includes('react-native')
      ? ['source-or-target:react-native']
      : []),
  ]);
  add('vite', [
    ...marker(/(?:^|\/)vite\.config\.[cm]?[jt]s$/),
    ...(targetSource.includes('@nx/vite') ? ['nx-target:@nx/vite'] : []),
  ]);
  return result.sort((left, right) => compare(left.value, right.value));
}

function configuredDatabaseNames(tree: Tree): Map<string, string> {
  const config = readJsonObject(tree, 'megamono.json');
  const databases = config.databases;
  const names = new Map<string, string>();
  if (!databases || typeof databases !== 'object' || Array.isArray(databases))
    return names;
  for (const [name, value] of Object.entries(databases)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const schema = (value as Record<string, unknown>).schema;
    if (typeof schema === 'string')
      names.set(schema.replace(/^\.\//, ''), name);
  }
  return names;
}

function ownerProject(
  schema: string,
  projects: ReadonlyMap<string, ProjectConfiguration>,
): string | null {
  return (
    [...projects.entries()]
      .filter(([, project]) => underRoot(schema, project.root))
      .sort(
        (left, right) => right[1].root.length - left[1].root.length,
      )[0]?.[0] ?? null
  );
}

function prismaProvider(source: string): string | null {
  const datasource = source.match(/datasource\s+\w+\s*\{([\s\S]*?)\}/)?.[1];
  return datasource?.match(/provider\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
}

function procfileServices(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z0-9_-]+)\s*:/)?.[1])
    .filter((value): value is string => Boolean(value))
    .sort(compare);
}

export function createWorkspaceInventory(
  tree: Tree,
  projects: ReadonlyMap<string, ProjectConfiguration>,
  files: readonly string[],
): WorkspaceInventory {
  const rootDependencies = dependencyMap(readJsonObject(tree, 'package.json'));
  const inventoryProjects = [...projects.entries()]
    .map(([name, project]): WorkspaceInventoryProject => {
      const localDependencies = dependencyMap(
        readJsonObject(tree, `${project.root}/package.json`),
      );
      const dependencies = { ...rootDependencies, ...localDependencies };
      const scopedFiles = sourceFiles(files, project.root);
      const source = sourceCorpus(tree, scopedFiles);
      const frameworks = frameworkEvidence({
        tree,
        root: project.root,
        files,
        targets: project.targets ?? {},
        source,
      });
      const appRouter =
        files.some((path) => underRoot(path, `${project.root}/app`)) ||
        files.some((path) => underRoot(path, `${project.root}/src/app`));
      const pagesRouter =
        files.some((path) => underRoot(path, `${project.root}/pages`)) ||
        files.some((path) => underRoot(path, `${project.root}/src/pages`));
      const imported = packageImports(source).filter(
        (dependency) => dependencies[dependency],
      );
      const serviceKinds = [
        ...(source.includes('bullmq') || source.includes('@nestjs/bullmq')
          ? (['queue'] as const)
          : []),
        ...(source.includes("from 'redis'") ||
        source.includes('from "redis"') ||
        source.includes('ioredis')
          ? (['cache'] as const)
          : []),
      ];
      return {
        name,
        root: project.root,
        frameworks,
        ...(frameworks.some(({ value }) => value === 'next') &&
        (appRouter || pagesRouter)
          ? {
              nextRouter:
                appRouter && pagesRouter
                  ? 'mixed'
                  : appRouter
                    ? 'app'
                    : 'pages',
            }
          : {}),
        externalPackages: imported,
        environmentNames: environmentNames(source),
        serviceKinds: [...new Set(serviceKinds)].sort(compare),
      };
    })
    .sort((left, right) => compare(left.name, right.name));

  const names = configuredDatabaseNames(tree);
  const schemas = files
    .filter((path) => path.endsWith('.prisma'))
    .sort(compare);
  const databases = schemas
    .filter((path) => /(?:^|\/)schema\.prisma$/.test(path))
    .map((schema): WorkspaceInventoryDatabase => {
      const directory = schema.slice(0, schema.lastIndexOf('/'));
      const migrations = files.some((path) =>
        underRoot(path, `${directory}/migrations`),
      )
        ? `${directory}/migrations`
        : null;
      return {
        name: names.get(schema) ?? null,
        adapter: 'prisma',
        schema,
        provider: prismaProvider(tree.read(schema, 'utf8') ?? ''),
        project: ownerProject(schema, projects),
        migrations,
      };
    });

  const services: WorkspaceInventoryService[] = [];
  const redisProjects = inventoryProjects
    .filter(
      ({ externalPackages }) =>
        externalPackages.includes('redis') ||
        externalPackages.includes('ioredis'),
    )
    .map(({ name }) => name);
  if (redisProjects.length > 0)
    services.push({
      kind: 'cache',
      provider: 'redis',
      projects: redisProjects,
      evidence: redisProjects.map((name) => `project:${name}:package-import`),
    });
  const bullProjects = inventoryProjects
    .filter(
      ({ externalPackages }) =>
        externalPackages.includes('bullmq') ||
        externalPackages.includes('@nestjs/bullmq'),
    )
    .map(({ name }) => name);
  if (bullProjects.length > 0)
    services.push({
      kind: 'queue',
      provider: 'bullmq',
      projects: bullProjects,
      evidence: bullProjects.map((name) => `project:${name}:package-import`),
    });

  const renderManifests = files.filter((path) =>
    /(?:^|\/)render\.ya?ml$/.test(path),
  );
  const procfiles = files.filter((path) => /(?:^|\/)Procfile$/.test(path));
  const dockerfiles = files.filter((path) =>
    /(?:^|\/)Dockerfile(?:\.[^/]+)?$/.test(path),
  );
  const deployments: WorkspaceInventoryDeployment[] = [];
  if (renderManifests.length > 0 || procfiles.length > 0)
    deployments.push({
      provider: 'render',
      authority: renderManifests.length > 0 ? 'manifest' : 'partial-marker',
      paths: [...renderManifests, ...procfiles].sort(compare),
      services: procfiles.flatMap((path) =>
        procfileServices(tree.read(path, 'utf8') ?? ''),
      ),
    });
  if (dockerfiles.length > 0)
    deployments.push({
      provider: 'docker',
      authority: 'manifest',
      paths: dockerfiles,
      services: [],
    });

  const ambiguities = [
    ...(procfiles.length > 0 && renderManifests.length === 0
      ? [
          `Render has only a Procfile marker (${procfiles.join(', ')}); dashboard-owned services cannot be inventoried without an explicit adoption map or render.yaml.`,
        ]
      : []),
    ...(databases.length > 1 && databases.some(({ name }) => name === null)
      ? [
          `Multiple Prisma schemas require stable logical names: ${databases
            .filter(({ name }) => name === null)
            .map(({ schema }) => schema)
            .join(', ')}.`,
        ]
      : []),
  ];

  return {
    schemaVersion: 1,
    projects: inventoryProjects,
    databases,
    services,
    deployments,
    ambiguities,
  };
}
