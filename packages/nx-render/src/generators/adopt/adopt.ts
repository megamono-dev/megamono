import {
  formatFiles,
  getProjects,
  logger,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { stringify } from 'yaml';

export interface RenderAdoptGeneratorSchema {
  readonly procfile?: string;
  readonly inventory?: string;
  readonly serviceProjects?: string;
  readonly output?: string;
  readonly force?: boolean;
}

interface ServiceMapping {
  readonly project?: string;
  readonly root?: string;
}

interface ProposedService extends Record<string, unknown> {
  readonly type: 'web' | 'worker' | 'cron' | 'pserv';
  readonly name: string;
  readonly runtime?: string;
  readonly rootDir?: string;
  readonly buildCommand?: string;
  readonly startCommand?: string;
  readonly healthCheckPath?: string;
}

function normalizedPath(value: string, option: string): string {
  const path = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').includes('..')
  )
    throw new Error(`${option} must be a safe workspace-relative path.`);
  return path;
}

function readJson(tree: Tree, path: string): Record<string, unknown> {
  const source = tree.read(path, 'utf8');
  if (!source) throw new Error(`${path} does not exist.`);
  try {
    const value = JSON.parse(source) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // Use the stable shape error below.
  }
  throw new Error(`${path} must contain a JSON object.`);
}

function mappings(tree: Tree, path?: string): Record<string, ServiceMapping> {
  if (!path) return {};
  const value = readJson(tree, normalizedPath(path, '--serviceProjects'));
  const services = value.services;
  if (!services || typeof services !== 'object' || Array.isArray(services))
    throw new Error(`${path} must contain a services object.`);
  return services as Record<string, ServiceMapping>;
}

function commandProject(command: string): string | null {
  return (
    command.match(/\bnx\s+run\s+([^:\s]+)(?::|\s|$)/)?.[1] ??
    command.match(/\bnx\s+(?:build|serve|start)\s+([^:\s]+)(?::|\s|$)/)?.[1] ??
    null
  );
}

function procfileServices(source: string): ProposedService[] {
  return source
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
      if (!match?.[1] || !match[2]) return [];
      const name = match[1];
      return [
        {
          type: name === 'web' ? ('web' as const) : ('worker' as const),
          name,
          runtime: 'node',
          startCommand: match[2],
        },
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function inventoryServices(value: Record<string, unknown>): ProposedService[] {
  if (!Array.isArray(value.services))
    throw new Error('render.services.json must contain a services array.');
  return value.services.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(`render.services.json services[${index}] must be an object.`);
    const service = raw as Record<string, unknown>;
    if (typeof service.name !== 'string' || typeof service.type !== 'string')
      throw new Error(
        `render.services.json services[${index}] requires name and type.`,
      );
    if (!['web', 'worker', 'cron', 'pserv'].includes(service.type))
      throw new Error(
        `render.services.json service ${service.name} has unsupported type ${service.type}.`,
      );
    return service as ProposedService;
  });
}

export async function renderAdoptGenerator(
  tree: Tree,
  options: RenderAdoptGeneratorSchema,
): Promise<GeneratorCallback> {
  const procfile = normalizedPath(options.procfile ?? 'Procfile', '--procfile');
  const inventory = normalizedPath(
    options.inventory ?? 'render.services.json',
    '--inventory',
  );
  const output = normalizedPath(
    options.output ?? 'render.proposed.yaml',
    '--output',
  );
  if (output === 'render.yaml')
    throw new Error(
      'Render adoption writes a review proposal; use --output=render.proposed.yaml and promote it explicitly after review.',
    );
  if (tree.exists(output) && !options.force)
    throw new Error(`${output} already exists; pass --force to replace it.`);

  const fromInventory = tree.exists(inventory);
  if (!fromInventory && !tree.exists(procfile))
    throw new Error(
      `Neither ${inventory} nor ${procfile} exists. Commit a dashboard service inventory or select a Procfile.`,
    );
  const services = fromInventory
    ? inventoryServices(readJson(tree, inventory))
    : procfileServices(tree.read(procfile, 'utf8') ?? '');
  const serviceMappings = mappings(tree, options.serviceProjects);
  const projects = getProjects(tree);
  const proposed = services.map((service) => {
    const mapping = serviceMappings[service.name];
    const inferredProject = service.startCommand
      ? commandProject(service.startCommand)
      : null;
    const projectName = mapping?.project ?? inferredProject;
    const project = projectName ? projects.get(projectName) : undefined;
    const root = mapping?.root ?? project?.root ?? service.rootDir;
    if (!root || root === '.')
      throw new Error(
        `Render service ${service.name} needs an explicit serviceProjects mapping before a Blueprint can be proposed.`,
      );
    if (projectName && !project && !mapping?.root)
      throw new Error(
        `Render service ${service.name} references unknown Nx project ${projectName}.`,
      );
    const next = { ...service, rootDir: root };
    if (service.type === 'web' && !service.healthCheckPath)
      logger.warn(
        `Render service ${service.name} has no verified health endpoint; the proposal intentionally omits healthCheckPath.`,
      );
    return next;
  });
  tree.write(
    output,
    `# Review this proposal before promoting it to render.yaml.\n${stringify({ services: proposed })}`,
  );
  await formatFiles(tree);
  return () => undefined;
}

export default renderAdoptGenerator;
