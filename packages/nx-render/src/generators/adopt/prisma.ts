import type { ProjectConfiguration, Tree } from '@nx/devkit';

interface Database {
  adapter: string;
  project: string;
  schema?: string;
}

interface InputJson {
  databases?: Record<string, Database>;
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function json(tree: Tree, path: string): InputJson {
  const source = tree.read(path, 'utf8');
  return source ? JSON.parse(source) : {};
}

export function invokesNxBuild(command: string, project: string): boolean {
  if (/[;|`$\n]/.test(command)) return false;
  return command.split('&&').some((part) => {
    const tokens =
      part
        .trim()
        .match(/'[^']*'|"[^"]*"|[^\s]+/g)
        ?.map((token) => token.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
    if (tokens.some((token) => token.includes('excludeTaskDependencies')))
      return false;
    if (
      (['npm', 'pnpm', 'yarn'].includes(tokens[0]) && tokens[1] === 'exec') ||
      (tokens[0] === 'bun' && tokens[1] === 'run')
    )
      tokens.splice(0, 2);
    else if (tokens[0] === 'yarn' || tokens[0] === 'npx') tokens.shift();
    if (tokens[0] === '--') tokens.shift();
    return (
      tokens[0] === 'nx' &&
      ((tokens[1] === 'run' &&
        (tokens[2] === `${project}:build` ||
          tokens[2]?.startsWith(`${project}:build:`))) ||
        (tokens[1] === 'build' && tokens[2] === project))
    );
  });
}

function safePath(path: string): boolean {
  return (
    /^[a-zA-Z0-9_./ -]+$/.test(path) &&
    !path.startsWith('/') &&
    !path.split('/').some((part) => part === '..' || part === '')
  );
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function prismaDeployment(
  tree: Tree,
  projects: ReadonlyMap<string, ProjectConfiguration>,
  projectName: string | undefined,
  selected: readonly string[] | undefined,
) {
  const configured = (json(tree, 'megamono.json').databases ?? {}) as Record<
    string,
    Database
  >;
  const project = projectName ? projects.get(projectName) : undefined;
  const reachable = new Set<string>();
  function visit(name: string) {
    if (reachable.has(name)) return;
    reachable.add(name);
    const entry = projects.get(name);
    for (const dependency of entry?.implicitDependencies ?? [])
      visit(dependency);
    const manifest = entry ? json(tree, `${entry.root}/package.json`) : {};
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    for (const [candidate, data] of projects) {
      const packageName = json(tree, `${data.root}/package.json`).name;
      if (packageName && dependencies[packageName]) visit(candidate);
    }
  }
  if (projectName) visit(projectName);
  const inferred = Object.entries(configured)
    .filter(([, db]) => db.adapter === 'prisma' && reachable.has(db.project))
    .map(([name]) => name);
  if (selected && inferred.some((name) => !selected.includes(name)))
    throw new Error(
      `Prisma database mapping for ${projectName} omits a known dependency: ${inferred.join(', ')}.`,
    );
  const names = [...new Set([...(selected ?? inferred)])].sort();
  const manifest = project ? json(tree, `${project.root}/package.json`) : {};
  const hasPrisma = Boolean(
    manifest.dependencies?.['@prisma/client'] ||
    manifest.devDependencies?.prisma,
  );
  if (
    selected === undefined &&
    !names.length &&
    project?.tags?.includes('platform:node') &&
    Object.values(configured).some((db) => db.adapter === 'prisma')
  )
    throw new Error(
      `Render service ${projectName} needs a reviewed serviceProjects databases list (use [] only for a service that does not use Prisma). Source-inferred dependencies cannot be resolved safely from this generator Tree.`,
    );
  if (!names.length && hasPrisma)
    throw new Error(
      `Prisma consumer ${projectName} needs an explicit serviceProjects databases mapping to named megamono.json databases.`,
    );
  if (!names.length) return undefined;
  if (!project || !projectName || !project.targets?.build)
    throw new Error(
      'Prisma Render services require a mapped Nx project with a build target.',
    );
  const packageManager = String(
    json(tree, 'package.json').packageManager ?? '',
  ).split('@')[0];
  const manager =
    packageManager ||
    (tree.exists('pnpm-lock.yaml')
      ? 'pnpm'
      : tree.exists('yarn.lock')
        ? 'yarn'
        : tree.exists('bun.lock')
          ? 'bun'
          : 'npm');
  const exec =
    manager === 'npm'
      ? 'npm exec --'
      : manager === 'pnpm'
        ? 'pnpm exec'
        : manager === 'yarn'
          ? 'yarn exec'
          : manager === 'bun'
            ? 'bun run'
            : undefined;
  if (!exec)
    throw new Error(
      `Unsupported package manager ${manager} for Render Prisma deployment.`,
    );
  const install =
    manager === 'npm'
      ? 'npm ci'
      : manager === 'pnpm'
        ? 'pnpm install --frozen-lockfile'
        : manager === 'bun'
          ? 'bun install --frozen-lockfile'
          : /^yarn@1\./.test(json(tree, 'package.json').packageManager ?? '')
            ? 'yarn install --frozen-lockfile'
            : 'yarn install --immutable';
  const databases = names.map((name) => {
    const db = configured[name];
    const owner = db && projects.get(db.project);
    if (!db || db.adapter !== 'prisma' || !owner || !owner.targets?.generate)
      throw new Error(
        `Prisma database ${name} requires a registered project and generate target.`,
      );
    const schema = db.schema;
    if (
      !schema ||
      !safePath(schema) ||
      (!tree.exists(schema) && !tree.children(schema).length)
    )
      throw new Error(
        `Prisma database ${name} requires an existing, safe schema path in megamono.json.`,
      );
    const config = `${owner.root}/prisma.config.ts`;
    return {
      name,
      project: db.project,
      schema,
      config: tree.exists(config)
        ? config
        : tree.exists('prisma.config.ts')
          ? 'prisma.config.ts'
          : undefined,
    };
  });
  const migration = databases
    .map(
      ({ schema, config }) =>
        `${exec} prisma migrate deploy --schema ${quote(schema)}${config ? ` --config ${quote(config)}` : ''}`,
    )
    .join(' && ');
  return {
    projectName,
    project,
    databases,
    migration,
    build: `${install} && ${exec} nx run ${quote(`${projectName}:build`)}`,
    dependencies: databases.map(({ project }) => ({
      projects: [project],
      target: 'generate',
    })),
  };
}
