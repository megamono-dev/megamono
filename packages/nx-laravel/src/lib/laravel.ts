import {
  DependencyType,
  type CreateNodes,
  type CreateDependencies,
  type ProjectConfiguration,
} from '@nx/devkit';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, isAbsolute } from 'node:path';

export interface LaravelOptions {
  runtime?: 'system' | 'herd';
  scope?: string;
}
export interface ComposerManifest {
  name?: string;
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
  repositories?:
    | Array<{ type?: string; url?: string }>
    | Record<string, { type?: string; url?: string }>;
}
export function ownedComposer(path: string): boolean {
  return !path
    .split(/[\\/]/)
    .some(
      (part) =>
        [
          'vendor',
          'node_modules',
          '.git',
          '.yalc',
          'nativephp',
          'dist',
          'build',
        ].includes(part) || part.startsWith('.megamono-laravel-'),
    );
}
export function commandTarget(
  root: string,
  tool: 'php' | 'composer' | 'herd' | 'npm',
  args: string[],
  runtime: 'system' | 'herd' = 'system',
) {
  return {
    executor: '@megamono/nx-laravel:command',
    cache: false,
    options: { root, tool, args, runtime },
  };
}
export function composerProject(
  root: string,
  manifest: ComposerManifest,
  artisan: boolean,
  options: LaravelOptions = {},
): ProjectConfiguration {
  const laravel = Boolean(manifest.require?.['laravel/framework'] && artisan);
  const target = (tool: 'php' | 'composer', args: string[]) =>
    commandTarget(root, tool, args, options.runtime);
  return {
    name: `php-${(root === '.' ? (manifest.name ?? 'workspace') : root).replace(/[^a-zA-Z0-9_-]+/g, '-')}`,
    root,
    projectType: laravel ? 'application' : 'library',
    tags: [
      'platform:php',
      `scope:${options.scope ?? 'shared'}`,
      `type:${laravel ? 'app' : 'util'}`,
      'visibility:internal',
    ],
    targets: {
      'composer-validate': target('composer', ['validate', '--no-interaction']),
      'composer-install': target('composer', ['install', '--no-interaction']),
      ...(laravel
        ? {
            test: target('php', ['artisan', 'test']),
            'laravel-about': target('php', ['artisan', 'about']),
            serve: { ...target('php', ['artisan', 'serve']), continuous: true },
          }
        : {}),
      ...(manifest['require-dev']?.['laravel/pint']
        ? { lint: target('php', ['vendor/bin/pint', '--test']) }
        : {}),
    },
    metadata: {
      technologies: laravel
        ? ['php', 'composer', 'laravel']
        : ['php', 'composer'],
      'megamono:composer': {
        name: manifest.name,
        php: manifest.require?.php,
        laravel: manifest.require?.['laravel/framework'],
      },
    },
  };
}
export const createNodes: CreateNodes<LaravelOptions> = [
  '**/composer.json',
  async (
    paths: string | readonly string[],
    options: LaravelOptions = {},
    context: { workspaceRoot: string },
  ) => {
    const results = (typeof paths === 'string' ? [paths] : paths)
      .filter(ownedComposer)
      .sort()
      .map((file) => {
        const root = dirname(file).replaceAll('\\', '/');
        const manifest = JSON.parse(
          readFileSync(resolve(context.workspaceRoot, file), 'utf8'),
        ) as ComposerManifest;
        return [
          [file],
          {
            projects: {
              [root]: composerProject(
                root,
                manifest,
                existsSync(resolve(context.workspaceRoot, root, 'artisan')),
                options,
              ),
            },
          },
        ] as const;
      });
    return typeof paths === 'string'
      ? {
          projects: Object.assign(
            {},
            ...results.map(([, result]) => result.projects),
          ),
        }
      : results;
  },
] as unknown as CreateNodes<LaravelOptions>;
export const createNodesV2 = createNodes;

/** Match only declared local path repositories and actually required package names. */
export function composerEdges(
  records: readonly {
    project: string;
    root: string;
    manifest: ComposerManifest;
  }[],
  workspaceRoot: string,
) {
  const edges: {
    source: string;
    target: string;
    sourceFile: string;
    type: DependencyType;
  }[] = [];
  for (const source of records) {
    const required = new Set(
      Object.keys({
        ...source.manifest.require,
        ...source.manifest['require-dev'],
      }),
    );
    for (const repository of Object.values(
      source.manifest.repositories ?? {},
    )) {
      if (
        repository.type !== 'path' ||
        !repository.url ||
        isAbsolute(repository.url) ||
        repository.url.includes('://')
      )
        continue;
      const pattern = relative(
        workspaceRoot,
        resolve(workspaceRoot, source.root, repository.url),
      ).replaceAll('\\', '/');
      if (pattern === '..' || pattern.startsWith('../')) continue;
      if (/[?{}[\]]/.test(pattern))
        throw new Error(
          `Unsupported Composer path pattern ${repository.url}; use explicit paths or * segments.`,
        );
      const regex = new RegExp(
        `^${pattern
          .split('*')
          .map((part) => part.replace(/[.+^$()|\\]/g, '\\$&'))
          .join('[^/]*')}$`,
      );
      for (const target of records)
        if (
          target.project !== source.project &&
          target.manifest.name &&
          required.has(target.manifest.name) &&
          regex.test(target.root)
        ) {
          const edge = {
            source: source.project,
            target: target.project,
            sourceFile:
              source.root === '.'
                ? 'composer.json'
                : `${source.root}/composer.json`,
            type: DependencyType.static,
          };
          if (
            !edges.some(
              (item) =>
                item.source === edge.source && item.target === edge.target,
            )
          )
            edges.push(edge);
        }
    }
  }
  return edges;
}
export const createDependencies: CreateDependencies = (_options, context) => {
  const records = Object.entries(context.projects).flatMap(
    ([project, config]) => {
      const file = resolve(context.workspaceRoot, config.root, 'composer.json');
      return ownedComposer(config.root) && existsSync(file)
        ? [
            {
              project,
              root: config.root,
              manifest: JSON.parse(
                readFileSync(file, 'utf8'),
              ) as ComposerManifest,
            },
          ]
        : [];
    },
  );
  return composerEdges(records, context.workspaceRoot);
};
