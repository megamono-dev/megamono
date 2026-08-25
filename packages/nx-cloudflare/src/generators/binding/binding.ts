import type { GeneratorCallback, Tree } from '@nx/devkit';
import type { WranglerConfig } from '../../lib/wrangler-config';
import type { BindingGeneratorSchema, CloudflareBindingType } from './schema';
import {
  CloudflareGeneratorError,
  createPostFlushCallback,
  printCloudflareGeneratorPlan,
  resolveWorkerConfig,
  typegenTask,
  updateConfigPath,
  type WorkerConfigDocument,
} from '../shared';

interface PlannedBinding {
  readonly path: readonly string[];
  readonly entry: Record<string, unknown>;
  readonly singular: boolean;
}

const optionalResourceTypes = new Set<CloudflareBindingType>([
  'ai',
  'browser',
  'images',
]);

function normalizedText(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function bindingPlan(options: BindingGeneratorSchema): PlannedBinding {
  const binding = normalizedText(options.binding);
  const resource = normalizedText(options.resource);
  if (!binding)
    throw new CloudflareGeneratorError(
      'options',
      'Binding name cannot be empty.',
    );
  if (!resource && !optionalResourceTypes.has(options.type))
    throw new CloudflareGeneratorError(
      'options',
      `--resource is required for ${options.type} bindings.`,
    );
  const flags = {
    ...(options.remote === undefined ? {} : { remote: options.remote }),
    ...(options.experimental === undefined
      ? {}
      : { experimental: options.experimental }),
  };
  const plans: Record<CloudflareBindingType, PlannedBinding> = {
    service: {
      path: ['services'],
      entry: { binding, service: resource, ...flags },
      singular: false,
    },
    kv: {
      path: ['kv_namespaces'],
      entry: { binding, id: resource, ...flags },
      singular: false,
    },
    r2: {
      path: ['r2_buckets'],
      entry: { binding, bucket_name: resource, ...flags },
      singular: false,
    },
    d1: {
      path: ['d1_databases'],
      entry: { binding, database_name: resource, ...flags },
      singular: false,
    },
    hyperdrive: {
      path: ['hyperdrive'],
      entry: { binding, id: resource, ...flags },
      singular: false,
    },
    'queue-producer': {
      path: ['queues', 'producers'],
      entry: { binding, queue: resource, ...flags },
      singular: false,
    },
    'queue-consumer': {
      path: ['queues', 'consumers'],
      entry: { queue: resource, ...flags },
      singular: false,
    },
    vectorize: {
      path: ['vectorize'],
      entry: { binding, index_name: resource, ...flags },
      singular: false,
    },
    ai: { path: ['ai'], entry: { binding, ...flags }, singular: true },
    'ai-search': {
      path: ['ai_search'],
      entry: { binding, catalog_name: resource, ...flags },
      singular: false,
    },
    workflow: {
      path: ['workflows'],
      entry: {
        binding,
        name: resource,
        ...(normalizedText(options.scriptName)
          ? { script_name: normalizedText(options.scriptName) }
          : {}),
        ...flags,
      },
      singular: false,
    },
    'analytics-engine': {
      path: ['analytics_engine_datasets'],
      entry: { binding, dataset: resource, ...flags },
      singular: false,
    },
    browser: {
      path: ['browser'],
      entry: { binding, ...flags },
      singular: true,
    },
    images: {
      path: ['images'],
      entry: { binding, ...flags },
      singular: true,
    },
    mtls: {
      path: ['mtls_certificates'],
      entry: { binding, certificate_id: resource, ...flags },
      singular: false,
    },
    'dispatch-namespace': {
      path: ['dispatch_namespaces'],
      entry: { binding, namespace: resource, ...flags },
      singular: false,
    },
    assets: {
      path: ['assets'],
      entry: { binding, directory: resource, ...flags },
      singular: true,
    },
  };
  return plans[options.type];
}

function valueAtPath(config: WranglerConfig, path: readonly string[]): unknown {
  let value: unknown = config;
  for (const segment of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function plannedDocument(
  document: WorkerConfigDocument,
  plan: PlannedBinding,
): { document: WorkerConfigDocument; changed: boolean } {
  const existing = valueAtPath(document.config, plan.path);
  if (plan.singular) {
    if (existing === undefined)
      return {
        document: updateConfigPath(document, plan.path, plan.entry),
        changed: true,
      };
    if (same(existing, plan.entry)) return { document, changed: false };
    throw new CloudflareGeneratorError(
      'conflict',
      `${plan.path.join('.')} already declares a different singular binding.`,
    );
  }
  const entries = existing === undefined ? [] : existing;
  if (!Array.isArray(entries))
    throw new CloudflareGeneratorError(
      'conflict',
      `${plan.path.join('.')} is not an array.`,
    );
  const identityKey = plan.entry.binding === undefined ? 'queue' : 'binding';
  const binding = plan.entry[identityKey];
  const matching = entries.filter(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      (entry as Record<string, unknown>)[identityKey] === binding,
  );
  if (matching.some((entry) => same(entry, plan.entry)))
    return { document, changed: false };
  if (matching.length > 0)
    throw new CloudflareGeneratorError(
      'conflict',
      `Binding ${String(binding)} already exists in ${plan.path.join('.')} with different configuration.`,
    );
  return {
    document: updateConfigPath(document, plan.path, [...entries, plan.entry]),
    changed: true,
  };
}

export async function bindingGenerator(
  tree: Tree,
  options: BindingGeneratorSchema,
): Promise<GeneratorCallback | void> {
  if (!normalizedText(options.project))
    throw new CloudflareGeneratorError(
      'options',
      'Project name cannot be empty.',
    );
  const current = resolveWorkerConfig(
    tree,
    options.project.trim(),
    options.configPath,
  );
  const mutation = plannedDocument(current, bindingPlan(options));
  printCloudflareGeneratorPlan({
    generator: 'binding',
    operations: [
      {
        action: mutation.changed ? 'modify' : 'retain',
        target: current.configPath,
        detail: `${mutation.changed ? 'Add' : 'Retain'} ${options.binding} as a ${options.type} binding.`,
      },
      ...(mutation.changed
        ? [
            {
              action: 'run-last' as const,
              target: 'wrangler types',
              detail:
                'Regenerate Worker types after the config mutation is flushed.',
            },
          ]
        : []),
    ],
  });
  if (options.dryRun || !mutation.changed) return;
  tree.write(current.configPath, mutation.document.source);
  return createPostFlushCallback(tree.root, [
    typegenTask(tree.root, current.configPath),
  ]);
}

export default bindingGenerator;
