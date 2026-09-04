import {
  normalizePath,
  type CreateNodes,
  type ProjectConfiguration,
} from '@nx/devkit';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { parse } from 'yaml';

const PREFLIGHT_KEY = 'megamono:preflight';
const RENDER_KEY = 'megamono:render';
const SERVICE_TYPES = new Set([
  'web',
  'pserv',
  'worker',
  'cron',
  'keyvalue',
  'redis',
]);

export interface RenderDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly service?: string;
}

export interface RenderPluginOptions {
  readonly scope?: string;
  readonly serviceProjects?: Readonly<
    Record<string, { readonly root: string; readonly project?: string }>
  >;
  readonly buildTargetName?: string | false;
  readonly startTargetName?: string | false;
  readonly preDeployTargetName?: string | false;
}

export interface RenderBlueprint extends Record<string, unknown> {
  readonly services?: readonly unknown[];
  readonly databases?: readonly unknown[];
  readonly projects?: readonly unknown[];
}

export interface RenderServiceMetadata {
  readonly name: string;
  readonly type: 'web' | 'pserv' | 'worker' | 'cron';
  readonly runtime: string | null;
  readonly rootDir: string;
  readonly buildCommand: string | null;
  readonly startCommand: string | null;
  readonly preDeployCommand: string | null;
  readonly healthCheckPath: string | null;
  readonly environmentNames: readonly string[];
  readonly serviceReferences: readonly string[];
  readonly databaseReferences: readonly string[];
  readonly buildFilter: {
    readonly paths: readonly string[];
    readonly ignoredPaths: readonly string[];
  };
  readonly instances: number | null;
}

export interface RenderResourceMetadata {
  readonly name: string;
  readonly type: 'postgres' | 'keyvalue';
  readonly maxmemoryPolicy?: string;
}

export interface RenderProjectMetadata {
  readonly schemaVersion: 1;
  readonly blueprintPath: string;
  readonly services: readonly RenderServiceMetadata[];
  readonly resources: readonly RenderResourceMetadata[];
}

interface ParsedBlueprint {
  readonly blueprint?: RenderBlueprint;
  readonly services: readonly RenderServiceMetadata[];
  readonly resources: readonly RenderResourceMetadata[];
  readonly diagnostics: readonly RenderDiagnostic[];
}

let diagnostics: RenderDiagnostic[] = [];

export function getRenderDiagnostics(): readonly RenderDiagnostic[] {
  return diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').sort()
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function diagnostic(
  path: string,
  code: string,
  message: string,
  severity: RenderDiagnostic['severity'] = 'error',
  service?: string,
): RenderDiagnostic {
  return { severity, code, message, path, ...(service ? { service } : {}) };
}

function allServiceRecords(
  blueprint: RenderBlueprint,
): Record<string, unknown>[] {
  const direct = records(blueprint.services);
  const nested = records(blueprint.projects).flatMap((project) =>
    records(project.environments).flatMap((environment) =>
      records(environment.services),
    ),
  );
  return [...direct, ...nested];
}

function allDatabaseRecords(
  blueprint: RenderBlueprint,
): Record<string, unknown>[] {
  const direct = records(blueprint.databases);
  const nested = records(blueprint.projects).flatMap((project) =>
    records(project.environments).flatMap((environment) =>
      records(environment.databases),
    ),
  );
  return [...direct, ...nested];
}

function references(envVars: unknown): {
  environmentNames: string[];
  serviceReferences: string[];
  databaseReferences: string[];
} {
  const names = new Set<string>();
  const services = new Set<string>();
  const databases = new Set<string>();
  for (const env of records(envVars)) {
    const key = stringValue(env.key);
    if (key) names.add(key);
    if (isRecord(env.fromService)) {
      const name = stringValue(env.fromService.name);
      if (name) services.add(name);
    }
    if (isRecord(env.fromDatabase)) {
      const name = stringValue(env.fromDatabase.name);
      if (name) databases.add(name);
    }
  }
  return {
    environmentNames: [...names].sort(),
    serviceReferences: [...services].sort(),
    databaseReferences: [...databases].sort(),
  };
}

export function parseRenderBlueprint(
  source: string,
  path = 'render.yaml',
): ParsedBlueprint {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch (error) {
    return {
      services: [],
      resources: [],
      diagnostics: [
        diagnostic(
          path,
          'render-blueprint-parse',
          `Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}.`,
        ),
      ],
    };
  }
  if (!isRecord(parsed)) {
    return {
      services: [],
      resources: [],
      diagnostics: [
        diagnostic(
          path,
          'render-blueprint-shape',
          `${path} must contain a YAML object.`,
        ),
      ],
    };
  }
  const blueprint = parsed as RenderBlueprint;
  const found: RenderDiagnostic[] = [];
  const resources: RenderResourceMetadata[] = [];
  for (const database of allDatabaseRecords(blueprint)) {
    const name = stringValue(database.name);
    if (name) resources.push({ name, type: 'postgres' });
  }
  const services: RenderServiceMetadata[] = [];
  for (const service of allServiceRecords(blueprint)) {
    const name = stringValue(service.name);
    const type = stringValue(service.type);
    if (!name || !type || !SERVICE_TYPES.has(type)) {
      found.push(
        diagnostic(
          path,
          'render-service-shape',
          'Every Render service requires a unique name and supported type.',
          'error',
          name ?? undefined,
        ),
      );
      continue;
    }
    if (type === 'keyvalue' || type === 'redis') {
      resources.push({
        name,
        type: 'keyvalue',
        ...(stringValue(service.maxmemoryPolicy)
          ? { maxmemoryPolicy: stringValue(service.maxmemoryPolicy) as string }
          : {}),
      });
      continue;
    }
    const rootDir = stringValue(service.rootDir) ?? '.';
    if (isAbsolute(rootDir) || rootDir.split('/').includes('..')) {
      found.push(
        diagnostic(
          path,
          'render-root-unsafe',
          `Service ${name} has unsafe rootDir ${rootDir}.`,
          'error',
          name,
        ),
      );
      continue;
    }
    const healthCheckPath = stringValue(service.healthCheckPath);
    if (healthCheckPath && (type !== 'web' || !healthCheckPath.startsWith('/')))
      found.push(
        diagnostic(
          path,
          'render-health-check-invalid',
          `Service ${name} has an invalid healthCheckPath; HTTP health paths apply to web services and start with '/'.`,
          'error',
          name,
        ),
      );
    if (type === 'web' && service.runtime !== 'static' && !healthCheckPath)
      found.push(
        diagnostic(
          path,
          'render-health-check-missing',
          `Web service ${name} has no application healthCheckPath.`,
          'warning',
          name,
        ),
      );
    const refs = references(service.envVars);
    const filter = isRecord(service.buildFilter) ? service.buildFilter : {};
    services.push({
      name,
      type: type as RenderServiceMetadata['type'],
      runtime: stringValue(service.runtime),
      rootDir: normalizePath(rootDir),
      buildCommand: stringValue(service.buildCommand),
      startCommand: stringValue(service.startCommand),
      preDeployCommand: stringValue(service.preDeployCommand),
      healthCheckPath,
      ...refs,
      buildFilter: {
        paths: strings(filter.paths),
        ignoredPaths: strings(filter.ignoredPaths),
      },
      instances:
        typeof service.numInstances === 'number' ? service.numInstances : null,
    });
  }
  const duplicateNames = services
    .map(({ name }) => name)
    .filter((name, index, names) => names.indexOf(name) !== index);
  for (const name of [...new Set(duplicateNames)].sort())
    found.push(
      diagnostic(
        path,
        'render-service-duplicate',
        `Render service ${name} is declared more than once.`,
        'error',
        name,
      ),
    );
  const resourceNames = new Set(resources.map(({ name }) => name));
  const serviceNames = new Set(services.map(({ name }) => name));
  for (const service of services) {
    for (const reference of service.serviceReferences)
      if (!serviceNames.has(reference) && !resourceNames.has(reference))
        found.push(
          diagnostic(
            path,
            'render-service-reference',
            `${service.name} references unknown Render service ${reference}.`,
            'error',
            service.name,
          ),
        );
    for (const reference of service.databaseReferences)
      if (!resourceNames.has(reference))
        found.push(
          diagnostic(
            path,
            'render-database-reference',
            `${service.name} references unknown Render database ${reference}.`,
            'error',
            service.name,
          ),
        );
  }
  return {
    blueprint,
    services: services.sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    resources: resources.sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    diagnostics: found.sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        left.message.localeCompare(right.message),
    ),
  };
}

function manifestName(workspaceRoot: string, root: string): string | undefined {
  for (const path of [`${root}/project.json`, `${root}/package.json`]) {
    try {
      const value = JSON.parse(
        readFileSync(resolve(workspaceRoot, path), 'utf8'),
      ) as {
        name?: unknown;
        nx?: { name?: unknown };
      };
      if (typeof value.nx?.name === 'string') return value.nx.name;
      if (typeof value.name === 'string') return value.name;
    } catch {
      // A missing or repository-owned malformed manifest is diagnosed elsewhere.
    }
  }
  return undefined;
}

function targetName(
  base: string | false | undefined,
  fallback: string,
): string | false {
  return base === false ? false : base?.trim() || fallback;
}

function buildFilterCoversRoot(
  paths: readonly string[],
  root: string,
): boolean {
  if (paths.length === 0) return true;
  return paths.some((path) => {
    const normalized = normalizePath(path).replace(/^\.\//, '');
    const prefix = normalized.split(/[*?[{]/, 1)[0]?.replace(/\/$/, '') ?? '';
    return normalized === '**' || prefix === '' || root.startsWith(prefix);
  });
}

function nextConfigPaths(root: string): string[] {
  return ['js', 'mjs', 'cjs', 'ts'].map(
    (extension) => `${root}/next.config.${extension}`,
  );
}

function hasSharedNextCache(workspaceRoot: string, root: string): boolean {
  return nextConfigPaths(root).some((path) => {
    try {
      return /\bcacheHandler\b/.test(
        readFileSync(resolve(workspaceRoot, path), 'utf8'),
      );
    } catch {
      return false;
    }
  });
}

function commandTarget(
  command: string | null,
  cwd: string,
  blueprintPath: string,
  continuous = false,
): NonNullable<ProjectConfiguration['targets']>[string] | undefined {
  if (!command) return undefined;
  return {
    executor: 'nx:run-commands',
    cache: false,
    inputs: ['default', `{workspaceRoot}/${blueprintPath}`],
    ...(continuous ? { continuous: true } : {}),
    options: {
      command,
      cwd: cwd === '.' ? '{workspaceRoot}' : `{workspaceRoot}/${cwd}`,
    },
  };
}

export function projectsFromRenderBlueprint(
  parsed: ParsedBlueprint,
  blueprintPath: string,
  workspaceRoot: string,
  options: RenderPluginOptions = {},
  capabilities: { readonly continuousTargets: boolean } = {
    continuousTargets: true,
  },
): Record<string, ProjectConfiguration> {
  const grouped = new Map<string, RenderServiceMetadata[]>();
  for (const service of parsed.services) {
    const mapping = options.serviceProjects?.[service.name];
    const root = normalizePath(mapping?.root ?? service.rootDir).replace(
      /^\.\//,
      '',
    );
    if (root === '.' && !mapping) {
      diagnostics.push(
        diagnostic(
          blueprintPath,
          'render-service-project-ambiguous',
          `Service ${service.name} has no rootDir or explicit serviceProjects mapping; Megamono will not attach it to a guessed Nx project.`,
          'warning',
          service.name,
        ),
      );
      continue;
    }
    if (!existsSync(resolve(workspaceRoot, root))) {
      diagnostics.push(
        diagnostic(
          blueprintPath,
          'render-service-root-missing',
          `Service ${service.name} resolves to missing workspace root ${root}.`,
          'error',
          service.name,
        ),
      );
      continue;
    }
    if (!buildFilterCoversRoot(service.buildFilter.paths, root)) {
      diagnostics.push(
        diagnostic(
          blueprintPath,
          'render-build-filter-root',
          `Service ${service.name} has a buildFilter that does not include its Nx project root ${root}.`,
          'warning',
          service.name,
        ),
      );
    }
    const nextConfigs = nextConfigPaths(root);
    if (
      service.type === 'web' &&
      (service.instances ?? 0) > 1 &&
      nextConfigs.some((path) => existsSync(resolve(workspaceRoot, path))) &&
      !hasSharedNextCache(workspaceRoot, root)
    ) {
      diagnostics.push(
        diagnostic(
          blueprintPath,
          'render-next-isr-shared-cache',
          `Multi-instance Next service ${service.name} has no detectable shared cacheHandler configuration.`,
          'warning',
          service.name,
        ),
      );
    }
    grouped.set(root, [...(grouped.get(root) ?? []), service]);
  }
  const result: Record<string, ProjectConfiguration> = {};
  for (const [root, services] of [...grouped.entries()].sort()) {
    const multiple = services.length > 1;
    const targets: NonNullable<ProjectConfiguration['targets']> = {};
    for (const service of services) {
      const suffix = multiple ? `-${service.name}` : '';
      for (const [base, command, continuous] of [
        [
          targetName(options.buildTargetName, 'render-build'),
          service.buildCommand,
          false,
        ],
        [
          targetName(options.startTargetName, 'render-start'),
          service.startCommand,
          true,
        ],
        [
          targetName(options.preDeployTargetName, 'render-pre-deploy'),
          service.preDeployCommand,
          false,
        ],
      ] as const) {
        if (base === false) continue;
        const target = commandTarget(
          command,
          service.rootDir,
          blueprintPath,
          continuous && capabilities.continuousTargets,
        );
        if (target) targets[`${base}${suffix}`] = target;
      }
    }
    const serviceNames = new Set(services.map(({ name }) => name));
    const preflight = [
      ...parsed.diagnostics.filter(
        (entry) => !entry.service || serviceNames.has(entry.service),
      ),
      ...diagnostics.filter(
        (entry) =>
          entry.path === blueprintPath &&
          entry.service &&
          serviceNames.has(entry.service),
      ),
    ];
    const mappedName = services
      .map(({ name }) => options.serviceProjects?.[name]?.project)
      .find((value): value is string => Boolean(value));
    result[root] = {
      name:
        mappedName ?? manifestName(workspaceRoot, root) ?? services[0]?.name,
      root,
      projectType: 'application',
      targets,
      metadata: {
        technologies: ['render'],
        [RENDER_KEY]: {
          schemaVersion: 1,
          blueprintPath,
          services,
          resources: parsed.resources,
        } satisfies RenderProjectMetadata,
        [PREFLIGHT_KEY]: { diagnostics: preflight, requiredTools: [] },
      },
    };
  }
  return result;
}

function workspacePath(workspaceRoot: string, path: string): string {
  return normalizePath(relative(workspaceRoot, path)) || '.';
}

export const createNodes: CreateNodes<RenderPluginOptions> = [
  '**/{render.yaml,render.yml,render.services.json}',
  async (
    configFiles: readonly string[] | string,
    options: RenderPluginOptions = {},
    context: { readonly workspaceRoot: string },
  ) => {
    diagnostics = [];
    const singleFileContract = typeof configFiles === 'string';
    const files: string[] = singleFileContract
      ? [configFiles]
      : [...configFiles];
    const results = files.sort().map((candidate) => {
      const blueprintPath = isAbsolute(candidate)
        ? workspacePath(context.workspaceRoot, candidate)
        : normalizePath(candidate).replace(/^\.\//, '');
      let parsed: ParsedBlueprint;
      try {
        parsed = parseRenderBlueprint(
          readFileSync(resolve(context.workspaceRoot, blueprintPath), 'utf8'),
          blueprintPath,
        );
      } catch (error) {
        parsed = {
          services: [],
          resources: [],
          diagnostics: [
            diagnostic(
              blueprintPath,
              'render-blueprint-read',
              `Cannot read ${blueprintPath}: ${error instanceof Error ? error.message : String(error)}.`,
            ),
          ],
        };
      }
      diagnostics.push(...parsed.diagnostics);
      const manifest = (() => {
        try {
          return JSON.parse(
            readFileSync(
              resolve(context.workspaceRoot, 'package.json'),
              'utf8',
            ),
          ) as Record<string, Record<string, unknown> | undefined>;
        } catch {
          return {};
        }
      })();
      const nxVersion = ['dependencies', 'devDependencies', 'peerDependencies']
        .map((field) => manifest[field]?.nx)
        .find((value): value is string => typeof value === 'string');
      const nxMajor = Number(nxVersion?.match(/(\d+)\./)?.[1] ?? 23);
      return [
        blueprintPath,
        {
          projects: projectsFromRenderBlueprint(
            parsed,
            blueprintPath,
            context.workspaceRoot,
            options,
            { continuousTargets: nxMajor >= 21 },
          ),
        },
      ] as const;
    });
    return singleFileContract
      ? {
          projects: Object.assign(
            {},
            ...results.map(([, value]) => value.projects),
          ),
        }
      : results;
  },
] as unknown as CreateNodes<RenderPluginOptions>;

export const createNodesV2 = createNodes;
