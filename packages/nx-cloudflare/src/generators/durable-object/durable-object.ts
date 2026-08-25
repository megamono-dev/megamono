import {
  names,
  normalizePath,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import type { DurableObjectGeneratorSchema } from './schema';
import {
  assertFileCanWrite,
  CloudflareGeneratorError,
  createPostFlushCallback,
  printCloudflareGeneratorPlan,
  readTreeText,
  relativeModulePath,
  resolveWorkerConfig,
  safeWorkspacePath,
  typegenTask,
  updateConfigPath,
  type CloudflareGeneratorPlanOperation,
} from '../shared';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function array(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  throw new CloudflareGeneratorError('conflict', `${label} is not an array.`);
}

function defaultBinding(className: string): string {
  return className
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
}

function classSource(className: string): string {
  return `export class ${className} {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(_request: Request): Promise<Response> {
    void this.state;
    return new Response('${className}');
  }
}
`;
}

export async function durableObjectGenerator(
  tree: Tree,
  options: DurableObjectGeneratorSchema,
): Promise<GeneratorCallback | void> {
  const project = options.project?.trim();
  if (!project)
    throw new CloudflareGeneratorError(
      'options',
      'Project name cannot be empty.',
    );
  const className = names(options.className?.trim() ?? '').className;
  if (!className || !/^[A-Z][A-Za-z0-9]*$/.test(className))
    throw new CloudflareGeneratorError(
      'options',
      'Durable Object class name must contain letters or numbers.',
    );
  const binding = options.binding?.trim() || defaultBinding(className);
  if (!/^[A-Z][A-Z0-9_]*$/.test(binding))
    throw new CloudflareGeneratorError(
      'options',
      'Durable Object binding must use uppercase letters, numbers, and underscores.',
    );
  const migrationTag = options.migrationTag?.trim() || 'v1';
  if (!migrationTag)
    throw new CloudflareGeneratorError(
      'options',
      'Migration tag cannot be empty.',
    );

  const current = resolveWorkerConfig(tree, project, options.configPath);
  const main =
    typeof current.config.main === 'string' ? current.config.main : undefined;
  if (!main)
    throw new CloudflareGeneratorError(
      'preflight',
      `${current.configPath} must declare main before adding a Durable Object.`,
    );
  const mainPath = safeWorkspacePath(`${current.root}/${main}`);
  const mainSource = readTreeText(tree, mainPath);
  if (mainSource === undefined)
    throw new CloudflareGeneratorError(
      'preflight',
      `Worker main file ${mainPath} does not exist.`,
    );
  const classPath = normalizePath(
    `${current.root}/src/durable-objects/${names(className).fileName}.ts`,
  );
  const generatedClass = classSource(className);
  const classAction = assertFileCanWrite(tree, classPath, generatedClass);
  const exportLine = `export { ${className} } from '${relativeModulePath(mainPath, classPath)}';`;
  const mainChanged = !mainSource.split(/\r?\n/).includes(exportLine);
  const plannedMain = mainChanged
    ? `${mainSource.trimEnd()}\n\n${exportLine}\n`
    : mainSource;

  const durableObjects = record(current.config.durable_objects) ?? {};
  const bindings = array(durableObjects.bindings, 'durable_objects.bindings');
  const bindingEntry = { name: binding, class_name: className };
  const matchingBindings = bindings.filter(
    (value) => record(value)?.name === binding,
  );
  const bindingExists = matchingBindings.some(
    (value) => JSON.stringify(value) === JSON.stringify(bindingEntry),
  );
  if (matchingBindings.length > 0 && !bindingExists)
    throw new CloudflareGeneratorError(
      'conflict',
      `Durable Object binding ${binding} already exists with different configuration.`,
    );

  const migrations = array(current.config.migrations, 'migrations');
  const migrationEntry = {
    tag: migrationTag,
    new_sqlite_classes: [className],
  };
  const matchingMigrations = migrations.filter(
    (value) => record(value)?.tag === migrationTag,
  );
  const migrationExists = matchingMigrations.some((value) => {
    const candidate = record(value);
    return (
      candidate &&
      Array.isArray(candidate.new_sqlite_classes) &&
      candidate.new_sqlite_classes.includes(className)
    );
  });
  if (matchingMigrations.length > 0 && !migrationExists)
    throw new CloudflareGeneratorError(
      'conflict',
      `Migration tag ${migrationTag} already exists without ${className}.`,
    );

  let plannedConfig = current;
  if (!bindingExists)
    plannedConfig = updateConfigPath(
      plannedConfig,
      ['durable_objects', 'bindings'],
      [...bindings, bindingEntry],
    );
  if (!migrationExists)
    plannedConfig = updateConfigPath(
      plannedConfig,
      ['migrations'],
      [...migrations, migrationEntry],
    );
  const configChanged = !bindingExists || !migrationExists;
  const changed = classAction === 'add' || mainChanged || configChanged;
  const operations: CloudflareGeneratorPlanOperation[] = [
    {
      action: classAction,
      target: classPath,
      detail: `${classAction === 'add' ? 'Add' : 'Retain'} the ${className} class.`,
    },
    {
      action: mainChanged ? 'modify' : 'retain',
      target: mainPath,
      detail: `${mainChanged ? 'Export' : 'Retain the export of'} ${className}.`,
    },
    {
      action: configChanged ? 'modify' : 'retain',
      target: current.configPath,
      detail: `${configChanged ? 'Add' : 'Retain'} the binding and migration as one config mutation.`,
    },
    ...(changed
      ? [
          {
            action: 'run-last' as const,
            target: 'wrangler types',
            detail: 'Regenerate Worker types after all files are flushed.',
          },
        ]
      : []),
  ];
  printCloudflareGeneratorPlan({ generator: 'durable-object', operations });
  if (options.dryRun || !changed) return;
  if (classAction === 'add') tree.write(classPath, generatedClass);
  if (mainChanged) tree.write(mainPath, plannedMain);
  if (configChanged) tree.write(current.configPath, plannedConfig.source);
  return createPostFlushCallback(tree.root, [
    typegenTask(tree.root, current.configPath),
  ]);
}

export default durableObjectGenerator;
