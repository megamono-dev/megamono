import {
  normalizePath,
  type CreateNodes,
  type ProjectConfiguration,
} from '@nx/devkit';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  collectWranglerConfigs,
  type CloudflareDiagnostic,
  type WranglerConfig,
  type WranglerConfigRecord,
  type WranglerConfigSelection,
} from './wrangler-config';

const PROJECT_PREFLIGHT_METADATA_KEY = 'megamono:preflight';
const CLOUDFLARE_METADATA_KEY = 'megamono:cloudflare';

const RESOURCE_FAMILIES = {
  kv_namespaces: ['id'],
  r2_buckets: ['bucket_name'],
  d1_databases: ['database_name', 'database_id'],
  hyperdrive: ['id'],
  vectorize: ['index_name'],
  ai: [],
  ai_search: ['catalog_name'],
  workflows: ['name'],
  analytics_engine_datasets: ['dataset'],
  browser: [],
  images: [],
  mtls_certificates: ['certificate_id'],
  dispatch_namespaces: ['namespace'],
  assets: ['directory'],
} as const;

const BINDING_FAMILIES = [
  'services',
  'durable_objects',
  'tail_consumers',
  'queues',
  ...Object.keys(RESOURCE_FAMILIES),
] as const;

export interface CloudflarePluginOptions extends WranglerConfigSelection {
  externalWorkers?: string[];
  scope?: string;
  devTargetName?: string;
  deployTargetName?: string;
  typegenTargetName?: string;
  tailTargetName?: string;
  typegenOutput?: string;
}

export interface CloudflareWorkerReference {
  kind: 'service' | 'durable-object' | 'workflow' | 'tail';
  worker: string;
  binding?: string;
}

export interface ResolvedCloudflareWorkerReference extends CloudflareWorkerReference {
  project: string;
  configPath: string;
}

export interface CloudflareResourceBinding {
  binding?: string;
  resource?: string;
  remote?: boolean;
  experimental?: boolean;
}

export interface CloudflareEnvironmentMetadata {
  name: string;
  workerName?: string;
  bindingFamilies: string[];
  bindingDifferences: string[];
}

export interface CloudflareProjectMetadata {
  schemaVersion: 1;
  configPath: string;
  workerName?: string;
  main?: string;
  compatibilityDate?: string;
  compatibilityFlags: string[];
  workerReferences: CloudflareWorkerReference[];
  resolvedWorkers: ResolvedCloudflareWorkerReference[];
  unresolvedWorkers: CloudflareWorkerReference[];
  externalWorkers: CloudflareWorkerReference[];
  resources: Record<string, CloudflareResourceBinding[]>;
  queues: { producers: string[]; consumers: string[] };
  environments: CloudflareEnvironmentMetadata[];
  routes: unknown[];
  workersDev?: boolean;
  devPort?: number;
}

interface PreparedRecord {
  record: WranglerConfigRecord;
  projectName: string;
}

let lastRecords:
  | {
      workspaceRoot: string;
      records: WranglerConfigRecord[];
      options: CloudflarePluginOptions;
    }
  | undefined;
let diagnostics: CloudflareDiagnostic[] = [];

export function getCloudflareDiagnostics(): readonly CloudflareDiagnostic[] {
  return diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function command(parts: readonly string[]): string {
  return parts.map(quote).join(' ');
}

function workspaceOutput(path: string): string {
  return `{workspaceRoot}/${normalizePath(path).replace(/^\.\//, '')}`;
}

function projectNameFromManifest(path: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      name?: unknown;
      nx?: { name?: unknown };
    };
    return stringValue(manifest.nx?.name) ?? stringValue(manifest.name);
  } catch {
    return undefined;
  }
}

function projectNameForRoot(
  record: WranglerConfigRecord,
  workspaceRoot: string,
): string {
  const absoluteRoot = resolve(workspaceRoot, record.root);
  return (
    (existsSync(resolve(absoluteRoot, 'project.json'))
      ? projectNameFromManifest(resolve(absoluteRoot, 'project.json'))
      : undefined) ??
    (existsSync(resolve(absoluteRoot, 'package.json'))
      ? projectNameFromManifest(resolve(absoluteRoot, 'package.json'))
      : undefined) ??
    (record.root === '.' ? 'worker' : basename(record.root))
  );
}

function workerReferences(config: WranglerConfig): CloudflareWorkerReference[] {
  const references: CloudflareWorkerReference[] = [];
  for (const service of recordArray(config.services)) {
    const worker = stringValue(service.service);
    if (worker)
      references.push({
        kind: 'service',
        worker,
        ...(stringValue(service.binding)
          ? { binding: stringValue(service.binding) }
          : {}),
      });
  }
  const durableObjects = isRecord(config.durable_objects)
    ? recordArray(config.durable_objects.bindings)
    : [];
  for (const binding of durableObjects) {
    const worker = stringValue(binding.script_name);
    if (worker)
      references.push({
        kind: 'durable-object',
        worker,
        ...(stringValue(binding.name)
          ? { binding: stringValue(binding.name) }
          : {}),
      });
  }
  for (const workflow of recordArray(config.workflows)) {
    const worker = stringValue(workflow.script_name);
    if (worker)
      references.push({
        kind: 'workflow',
        worker,
        ...(stringValue(workflow.binding)
          ? { binding: stringValue(workflow.binding) }
          : {}),
      });
  }
  for (const consumer of recordArray(config.tail_consumers)) {
    const worker = stringValue(consumer.service);
    if (worker) references.push({ kind: 'tail', worker });
  }
  return references.sort((left, right) =>
    `${left.kind}:${left.worker}:${left.binding ?? ''}`.localeCompare(
      `${right.kind}:${right.worker}:${right.binding ?? ''}`,
    ),
  );
}

function resourceBindings(
  config: WranglerConfig,
): Record<string, CloudflareResourceBinding[]> {
  const resources: Record<string, CloudflareResourceBinding[]> = {};
  for (const [family, resourceKeys] of Object.entries(RESOURCE_FAMILIES)) {
    const value = config[family];
    const entries = Array.isArray(value)
      ? recordArray(value)
      : isRecord(value)
        ? [value]
        : [];
    if (entries.length === 0) continue;
    resources[family] = entries.map((entry) => ({
      ...(stringValue(entry.binding)
        ? { binding: stringValue(entry.binding) }
        : {}),
      ...(() => {
        const resource = resourceKeys
          .map((key) => stringValue(entry[key]))
          .find(Boolean);
        return resource ? { resource } : {};
      })(),
      ...(typeof entry.remote === 'boolean' ? { remote: entry.remote } : {}),
      ...(typeof entry.experimental === 'boolean'
        ? { experimental: entry.experimental }
        : {}),
    }));
  }
  return resources;
}

function queueNames(config: WranglerConfig): {
  producers: string[];
  consumers: string[];
} {
  const queues = isRecord(config.queues) ? config.queues : {};
  const names = (value: unknown) =>
    [
      ...new Set(
        recordArray(value).flatMap((entry) => stringValue(entry.queue) ?? []),
      ),
    ].sort();
  return {
    producers: names(queues.producers),
    consumers: names(queues.consumers),
  };
}

function environmentMetadata(
  config: WranglerConfig,
): CloudflareEnvironmentMetadata[] {
  if (!isRecord(config.env)) return [];
  return Object.entries(config.env)
    .filter((entry): entry is [string, Record<string, unknown>] =>
      isRecord(entry[1]),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, environment]) => {
      const bindingFamilies = BINDING_FAMILIES.filter(
        (family) => environment[family] !== undefined,
      );
      return {
        name,
        ...(stringValue(environment.name)
          ? { workerName: stringValue(environment.name) }
          : {}),
        bindingFamilies: [...bindingFamilies],
        bindingDifferences: bindingFamilies.filter(
          (family) =>
            JSON.stringify(environment[family]) !==
            JSON.stringify(config[family]),
        ),
      };
    });
}

function routes(config: WranglerConfig): unknown[] {
  if (Array.isArray(config.routes)) return config.routes;
  return config.route === undefined ? [] : [config.route];
}

function projectDiagnostics(
  prepared: PreparedRecord,
  workers: Map<string, PreparedRecord[]>,
  externalWorkers: Set<string>,
): CloudflareDiagnostic[] {
  const result = [...prepared.record.diagnostics];
  const config = prepared.record.config;
  if (!config) return result;
  if (!stringValue(config.name)) {
    result.push({
      severity: 'warning',
      code: 'cloudflare-worker-name',
      message: `${prepared.record.configPath} has no top-level Worker name, so other Workers cannot resolve it as a local binding.`,
      path: prepared.record.configPath,
    });
  } else if ((workers.get(config.name as string)?.length ?? 0) > 1) {
    result.push({
      severity: 'error',
      code: 'cloudflare-worker-name-duplicate',
      message: `Worker name ${String(config.name)} is declared by more than one top-level Wrangler config. Local references to that name are ambiguous.`,
      path: prepared.record.configPath,
    });
  }
  for (const reference of workerReferences(config)) {
    if (
      !externalWorkers.has(reference.worker) &&
      (workers.get(reference.worker)?.length ?? 0) !== 1
    ) {
      result.push({
        severity: 'warning',
        code: 'cloudflare-worker-unresolved',
        message: `${reference.kind} reference ${reference.worker} does not resolve to exactly one local Worker. Add it to externalWorkers when it is intentionally external.`,
        path: prepared.record.configPath,
      });
    }
  }
  return result;
}

function metadataForProject(
  prepared: PreparedRecord,
  workers: Map<string, PreparedRecord[]>,
  options: CloudflarePluginOptions,
): CloudflareProjectMetadata {
  const config = prepared.record.config ?? {};
  const references = workerReferences(config);
  const externalNames = new Set(options.externalWorkers ?? []);
  const resolvedWorkers: ResolvedCloudflareWorkerReference[] = [];
  const unresolvedWorkers: CloudflareWorkerReference[] = [];
  const externalWorkers: CloudflareWorkerReference[] = [];
  for (const reference of references) {
    if (externalNames.has(reference.worker)) {
      externalWorkers.push(reference);
      continue;
    }
    const candidates = workers.get(reference.worker) ?? [];
    if (candidates.length === 1) {
      resolvedWorkers.push({
        ...reference,
        project: candidates[0].projectName,
        configPath: candidates[0].record.configPath,
      });
    } else {
      unresolvedWorkers.push(reference);
    }
  }
  const dev = isRecord(config.dev) ? config.dev : undefined;
  return {
    schemaVersion: 1,
    configPath: prepared.record.configPath,
    ...(stringValue(config.name) ? { workerName: config.name as string } : {}),
    ...(stringValue(config.main) ? { main: config.main as string } : {}),
    ...(stringValue(config.compatibility_date)
      ? { compatibilityDate: config.compatibility_date as string }
      : {}),
    compatibilityFlags: Array.isArray(config.compatibility_flags)
      ? config.compatibility_flags.filter(
          (flag): flag is string => typeof flag === 'string',
        )
      : [],
    workerReferences: references,
    resolvedWorkers,
    unresolvedWorkers,
    externalWorkers,
    resources: resourceBindings(config),
    queues: queueNames(config),
    environments: environmentMetadata(config),
    routes: routes(config),
    ...(typeof config.workers_dev === 'boolean'
      ? { workersDev: config.workers_dev }
      : {}),
    ...(typeof dev?.port === 'number' ? { devPort: dev.port } : {}),
  };
}

function targetConfigurations(
  environments: readonly CloudflareEnvironmentMetadata[],
  baseParts: readonly string[],
): Record<string, { command: string }> {
  return Object.fromEntries(
    environments.map(({ name }) => [
      name,
      { command: command([...baseParts, `--env=${name}`]) },
    ]),
  );
}

function createTargets(
  prepared: PreparedRecord,
  metadata: CloudflareProjectMetadata,
  options: CloudflarePluginOptions,
): ProjectConfiguration['targets'] {
  if (!prepared.record.executable) return {};
  const configParts = ['--config', prepared.record.configPath];
  const inputs = ['default', workspaceOutput(prepared.record.configPath)];
  const typegenInputs = [
    ...inputs,
    ...new Set(
      metadata.resolvedWorkers.map((worker) =>
        workspaceOutput(worker.configPath),
      ),
    ),
  ];
  const typegenOutput = normalizePath(
    `${prepared.record.root}/${options.typegenOutput ?? 'worker-configuration.d.ts'}`,
  ).replace(/^\.\//, '');
  const targets: NonNullable<ProjectConfiguration['targets']> = {};
  for (const target of [
    {
      name: options.devTargetName ?? 'dev',
      wrangler: 'dev',
      cache: false,
      continuous: true,
      inputs,
    },
    {
      name: options.deployTargetName ?? 'deploy',
      wrangler: 'deploy',
      cache: false,
      continuous: false,
      inputs,
    },
    {
      name: options.typegenTargetName ?? 'typegen',
      wrangler: 'types',
      cache: true,
      continuous: false,
      inputs: typegenInputs,
      outputs: [workspaceOutput(typegenOutput)],
    },
    {
      name: options.tailTargetName ?? 'tail',
      wrangler: 'tail',
      cache: false,
      continuous: true,
      inputs,
    },
  ] as const) {
    const parts = ['wrangler', target.wrangler, ...configParts];
    targets[target.name] = {
      executor: 'nx:run-commands',
      cache: target.cache,
      inputs: [...target.inputs],
      ...('outputs' in target && target.outputs !== undefined
        ? { outputs: [...target.outputs] }
        : {}),
      ...(target.continuous ? { continuous: true } : {}),
      options: {
        command: command(parts),
        cwd: '{workspaceRoot}',
      },
      configurations: targetConfigurations(metadata.environments, parts),
      metadata: {
        description: `${target.wrangler === 'types' ? 'Generate types for' : `Run wrangler ${target.wrangler} for`} ${prepared.projectName}.`,
      },
    };
  }
  return targets;
}

export function projectsFromWranglerConfigs(
  records: readonly WranglerConfigRecord[],
  workspaceRoot: string,
  options: CloudflarePluginOptions = {},
): Array<
  readonly [string, { projects: Record<string, ProjectConfiguration> }]
> {
  const prepared = records.map((record) => ({
    record,
    projectName: projectNameForRoot(record, workspaceRoot),
  }));
  const workers = new Map<string, PreparedRecord[]>();
  for (const item of prepared) {
    const name = stringValue(item.record.config?.name);
    if (name) workers.set(name, [...(workers.get(name) ?? []), item]);
  }
  const externalWorkers = new Set(options.externalWorkers ?? []);
  return prepared.map((item) => {
    const metadata = metadataForProject(item, workers, options);
    const preflightDiagnostics = projectDiagnostics(
      item,
      workers,
      externalWorkers,
    );
    return [
      item.record.configPath,
      {
        projects: {
          [item.record.root]: {
            name: item.projectName,
            root: item.record.root,
            sourceRoot: normalizePath(`${item.record.root}/src`),
            projectType: 'application',
            tags: [
              'platform:worker',
              `scope:${options.scope ?? 'shared'}`,
              'type:app',
              'visibility:internal',
            ],
            targets: createTargets(item, metadata, options),
            metadata: {
              technologies: ['cloudflare-workers', 'wrangler'],
              [CLOUDFLARE_METADATA_KEY]: metadata,
              [PROJECT_PREFLIGHT_METADATA_KEY]: {
                diagnostics: preflightDiagnostics,
                requiredTools: item.record.executable
                  ? [
                      {
                        executable: 'wrangler',
                        reason: 'Cloudflare Worker inferred targets',
                      },
                    ]
                  : [],
              },
            },
          },
        },
      },
    ] as const;
  });
}

export const createNodes: CreateNodes<CloudflarePluginOptions> = [
  '**/{wrangler.jsonc,wrangler.json,wrangler.toml}',
  async (configFiles, options = {}, context) => {
    const records = await collectWranglerConfigs(
      configFiles,
      context.workspaceRoot,
      options,
    );
    lastRecords = { workspaceRoot: context.workspaceRoot, records, options };
    const results = projectsFromWranglerConfigs(
      records,
      context.workspaceRoot,
      options,
    );
    diagnostics = results.flatMap(([, result]) =>
      Object.values(result.projects).flatMap((project) => {
        const preflight = project.metadata?.[PROJECT_PREFLIGHT_METADATA_KEY] as
          { diagnostics?: CloudflareDiagnostic[] } | undefined;
        return preflight?.diagnostics ?? [];
      }),
    );
    return results;
  },
];

export function getLastCloudflareRecords():
  | {
      workspaceRoot: string;
      records: readonly WranglerConfigRecord[];
      options: CloudflarePluginOptions;
    }
  | undefined {
  return lastRecords;
}
