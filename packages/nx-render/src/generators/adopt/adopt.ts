import {
  formatFiles,
  getProjects,
  updateProjectConfiguration,
  logger,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { stringify } from 'yaml';
import { invokesNxBuild, prismaDeployment } from './prisma';

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
  readonly databases?: readonly string[];
}

interface ProposedService extends Record<string, unknown> {
  readonly type: 'web' | 'worker' | 'cron' | 'pserv';
  readonly name: string;
  readonly runtime?: string;
  readonly rootDir?: string;
  readonly buildCommand?: string;
  readonly startCommand?: string;
  readonly healthCheckPath?: string;
  readonly preDeployCommand?: string;
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
      throw new Error(
        `render.services.json services[${index}] must be an object.`,
      );
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
  const buildUpdates = new Map<string, ReturnType<typeof prismaDeployment>>();
  const proposed = services.map((service) => {
    const mapping = serviceMappings[service.name];
    const inferredProject = service.startCommand
      ? commandProject(service.startCommand)
      : null;
    const rootMatches = [...projects].filter(
      ([, entry]) => entry.root === (mapping?.root ?? service.rootDir),
    );
    const projectName =
      mapping?.project ??
      inferredProject ??
      (rootMatches.length === 1 ? rootMatches[0][0] : undefined);
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
    const databaseNames = mapping?.databases;
    if (
      databaseNames !== undefined &&
      (!Array.isArray(databaseNames) ||
        databaseNames.some((name) => typeof name !== 'string'))
    )
      throw new Error(
        `Render service ${service.name} databases must be an array of logical database names.`,
      );
    const prisma = prismaDeployment(
      tree,
      projects,
      projectName ?? undefined,
      databaseNames,
    );
    const next = { ...service, rootDir: root };
    if (prisma) {
      if (
        (service.runtime && service.runtime !== 'node') ||
        service.type === 'cron' ||
        service.plan === 'free'
      )
        throw new Error(
          `Render service ${service.name} requires a reviewed Prisma deployment strategy: generated pre-deploy support is limited to paid Node web/private/worker services.`,
        );
      if (service.rootDir && service.rootDir !== '.')
        throw new Error(
          `Render Prisma service ${service.name} must build from the workspace root; review rootDir and command paths before adoption.`,
        );
      if (
        service.buildCommand &&
        !invokesNxBuild(service.buildCommand, prisma.projectName)
      )
        throw new Error(
          `Render service ${service.name} buildCommand must invoke ${prisma.projectName}:build so its Prisma generation dependencies run; custom build commands require review.`,
        );
      if (
        service.preDeployCommand &&
        service.preDeployCommand !== prisma.migration
      )
        throw new Error(
          `Render service ${service.name} already owns preDeployCommand. Review and compose the required migrations explicitly: ${prisma.migration}`,
        );
      next.rootDir = '.';
      next.buildCommand = service.buildCommand ?? prisma.build;
      next.preDeployCommand = prisma.migration;
      const previous = buildUpdates.get(prisma.projectName);
      buildUpdates.set(
        prisma.projectName,
        previous
          ? {
              ...prisma,
              dependencies: [...previous.dependencies, ...prisma.dependencies],
              databases: [...previous.databases, ...prisma.databases],
            }
          : prisma,
      );
    }
    if (service.type === 'web' && !service.healthCheckPath)
      logger.warn(
        `Render service ${service.name} has no verified health endpoint; the proposal intentionally omits healthCheckPath.`,
      );
    return next;
  });
  for (const prisma of buildUpdates.values()) {
    if (!prisma) continue;
    const build = prisma.project.targets?.build;
    if (!build)
      throw new Error(`Missing build target for ${prisma.projectName}.`);
    const dependencies = [...(build.dependsOn ?? [])];
    for (const dependency of prisma.dependencies) {
      if (
        !dependencies.some(
          (entry) => JSON.stringify(entry) === JSON.stringify(dependency),
        )
      )
        dependencies.push(dependency);
    }
    updateProjectConfiguration(tree, prisma.projectName, {
      ...prisma.project,
      implicitDependencies: [
        ...new Set([
          ...(prisma.project.implicitDependencies ?? []),
          ...prisma.databases
            .map(({ project }) => project)
            .filter((project) => project !== prisma.projectName),
        ]),
      ],
      targets: {
        ...prisma.project.targets,
        build: { ...build, dependsOn: dependencies },
      },
    });
  }
  tree.write(
    output,
    `# Review this proposal before promoting it to render.yaml.\n# Prisma: review and commit migrations, confirm backups and release approval.\n# Keep the Prisma CLI, config and migrations available in the pre-deploy environment.\n${stringify({ services: proposed })}`,
  );
  await formatFiles(tree);
  return () => undefined;
}

export default renderAdoptGenerator;
