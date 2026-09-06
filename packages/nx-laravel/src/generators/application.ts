import {
  addProjectConfiguration,
  getProjects,
  readJson,
  writeJson,
  updateJson,
  type Tree,
} from '@nx/devkit';
import { commandTarget, ownedComposer } from '../lib/laravel';

export interface ApplicationOptions {
  name: string;
  directory?: string;
  scope?: string;
  laravelVersion?: string;
  runtime?: 'system' | 'herd';
  herdDomain?: string;
  phpVersion?: string;
}
export interface ScaffoldPlan {
  schemaVersion: 1;
  name: string;
  root: string;
  laravelVersion: string;
  runtime: 'system' | 'herd';
  native?: { platform: 'desktop' | 'mobile'; version: string; appId: string };
  completed?: boolean;
}
export function applicationPlan(options: ApplicationOptions): ScaffoldPlan {
  if (!/^[a-z][a-z0-9-]*$/.test(options.name))
    throw new Error('Name must be a lowercase project slug.');
  const root = options.directory ?? `apps/${options.name}`;
  if (
    !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(root) ||
    !ownedComposer(root)
  )
    throw new Error(
      'Directory must be a safe, non-root workspace-relative path.',
    );
  const laravelVersion = options.laravelVersion ?? '^13.0';
  if (!/^\^?(?:12|13)\.\d+(?:\.\d+)?$/.test(laravelVersion))
    throw new Error(
      'Select an explicit Laravel 12 or 13 version constraint, such as ^13.0.',
    );
  if (options.runtime && !['system', 'herd'].includes(options.runtime))
    throw new Error('Runtime must be system or herd.');
  if (options.scope && !/^[a-z][a-z0-9-]*$/.test(options.scope))
    throw new Error('Scope must be a lowercase slug.');
  if (
    options.herdDomain &&
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(options.herdDomain)
  )
    throw new Error('Herd domain must be a safe site name without .test.');
  if (options.herdDomain?.endsWith('.test'))
    throw new Error('Pass a Herd site name without the .test suffix.');
  if (options.phpVersion && !/^8\.[3-5]$/.test(options.phpVersion))
    throw new Error('Select PHP 8.3, 8.4, or 8.5 explicitly.');
  return {
    schemaVersion: 1,
    name: options.name,
    root,
    laravelVersion,
    runtime: options.runtime ?? 'system',
  };
}
export function registerLaravelProject(
  tree: Tree,
  options: ApplicationOptions,
  plan = applicationPlan(options),
): void {
  const project = getProjects(tree).get(plan.name);
  if (project || tree.exists(plan.root) || tree.children(plan.root).length)
    throw new Error(
      `Project or path ${plan.name} (${plan.root}) is already occupied; use inference to adopt an existing application.`,
    );
  const nx = tree.exists('nx.json') ? readJson(tree, 'nx.json') : {};
  if (nx.plugins !== undefined && !Array.isArray(nx.plugins))
    throw new Error('nx.json plugins must be an array.');
  const target = (tool: 'php' | 'composer' | 'herd' | 'npm', args: string[]) =>
    commandTarget(plan.root, tool, args, plan.runtime);
  addProjectConfiguration(tree, plan.name, {
    root: plan.root,
    sourceRoot: `${plan.root}/app`,
    projectType: 'application',
    tags: [
      'platform:php',
      `scope:${options.scope ?? 'shared'}`,
      'type:app',
      'visibility:internal',
    ],
    targets: {
      setup: {
        executor: '@megamono/nx-laravel:setup',
        cache: false,
        options: { root: plan.root },
      },
      'composer-install': target('composer', ['install', '--no-interaction']),
      'composer-validate': target('composer', ['validate', '--no-interaction']),
      test: target('php', ['artisan', 'test']),
      serve: { ...target('php', ['artisan', 'serve']), continuous: true },
      'assets-build': target('npm', ['run', 'build']),
      'assets-dev': { ...target('npm', ['run', 'dev']), continuous: true },
      ...(options.herdDomain
        ? { 'herd-link': target('herd', ['link', options.herdDomain]) }
        : {}),
      ...(options.phpVersion
        ? { 'herd-isolate': target('herd', ['isolate', options.phpVersion]) }
        : {}),
    },
  });
  writeJson(tree, `${plan.root}/megamono-laravel.json`, plan);
  updateJson(tree, 'nx.json', (value) => ({
    ...value,
    plugins: [
      ...(value.plugins ?? []),
      ...((value.plugins ?? []).some(
        (entry: string | { plugin: string }) =>
          (typeof entry === 'string' ? entry : entry.plugin) ===
          '@megamono/nx-laravel',
      )
        ? []
        : ['@megamono/nx-laravel']),
    ],
  }));
}
export default async function laravelApplicationGenerator(
  tree: Tree,
  options: ApplicationOptions,
) {
  registerLaravelProject(tree, options);
  console.log(
    `Review the generated project, then run nx run ${options.name}:setup to fetch the official Laravel skeleton. Dependencies, .env, keys, migrations, Herd registration and native installation are separate explicit steps.`,
  );
}
