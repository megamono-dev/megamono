import { readFile, lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parse } from 'yaml';
import ts = require('typescript');
import { z } from 'zod';
import { satisfies, validRange } from 'semver';
import { integrationFingerprint } from './integration-migrations';

const name = z.string().regex(/^[@a-zA-Z0-9][@a-zA-Z0-9._/-]*$/);
const packageIdentity = z
  .string()
  .regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i);
export const monorepoSelectionSchema = z
  .object({
    projects: z.record(
      z.string(),
      z.discriminatedUnion('action', [
        z
          .object({
            action: z.literal('import'),
            name,
            packageName: packageIdentity.optional(),
            configuration: z
              .object({
                projectType: z.enum(['application', 'library']),
                tags: z.array(z.string()).default([]),
                targets: z.record(
                  z.string(),
                  z.record(z.string(), z.unknown()),
                ),
                implicitDependencies: z.array(z.string()).optional(),
              })
              .strict(),
          })
          .strict(),
        z.object({ action: z.literal('reuse'), project: name }).strict(),
      ]),
    ),
  })
  .strict();
export type MonorepoSelection = z.input<typeof monorepoSelectionSchema>;
export interface MonorepoImportPlan {
  readonly selectionHash: string;
  readonly projects: readonly {
    root: string;
    sourceName: string;
    sourcePackage?: string;
    action: 'import' | 'reuse';
    name: string;
    packageName?: string;
    destination: string;
    configuration?: Record<string, unknown>;
  }[];
  readonly rewrites: readonly { source: string; content: string }[];
  readonly edges: readonly {
    fromProject: string;
    project: string;
    packageName: string;
  }[];
}

function safe(path: string) {
  if (
    !path ||
    /^(?:\/|[A-Za-z]:)/.test(path) ||
    path.includes('\\') ||
    path
      .split('/')
      .some(
        (p) =>
          !p || ['.', '..', '.git', 'node_modules', '.megamono'].includes(p),
      )
  )
    throw new Error(`Unsafe monorepo project path: ${path}.`);
  return path;
}
const sourceConfiguration = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    private: z.boolean().optional(),
    workspaces: z
      .union([
        z.array(z.string()),
        z.object({ packages: z.array(z.string()) }).passthrough(),
      ])
      .optional(),
    packageManager: z.string().optional(),
    scripts: z.record(z.string(), z.string()).optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    nx: z.object({ name: z.string().optional() }).passthrough().optional(),
    targets: z.record(z.string(), z.unknown()).optional(),
    references: z
      .array(z.object({ path: z.string() }).passthrough())
      .optional(),
    extends: z.union([z.string(), z.array(z.string())]).optional(),
    compilerOptions: z
      .object({
        baseUrl: z.string().optional(),
        paths: z.record(z.string(), z.array(z.string())).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
function object(content: string | undefined, path: string) {
  if (content === undefined) return sourceConfiguration.parse({});
  const parsed = ts.parseConfigFileTextToJson(path, content);
  if (
    parsed.error ||
    !parsed.config ||
    typeof parsed.config !== 'object' ||
    Array.isArray(parsed.config)
  )
    throw new Error(`Invalid source configuration ${path}.`);
  return sourceConfiguration.parse(parsed.config);
}
function workspaceMatch(root: string, pattern: string) {
  if (!/^[\w*/.-]+$/.test(pattern) || pattern.includes('..'))
    throw new Error(
      'Monorepo import requires explicit simple workspace globs (* or **); normalize complex workspace selectors first.',
    );
  const regex = pattern
    .split('**')
    .map((part) => part.replace(/\./g, '\\.').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${regex}/?$`).test(root);
}

/** Read an immutable Git tree, never run source Nx plugins to discover projects. */
export async function planMonorepoImport(input: {
  workspaceRoot: string;
  destination: string;
  name: string;
  selection: MonorepoSelection;
  packageManager?: string;
  files: readonly string[];
  read(path: string): Promise<string | undefined>;
  targetProjects: readonly {
    name: string;
    root?: string;
    packageName?: string;
  }[];
}): Promise<MonorepoImportPlan> {
  const selection = monorepoSelectionSchema.parse(input.selection);
  const targetProjects = await Promise.all(
    input.targetProjects.map(async (project) => {
      if (project.packageName || !project.root) return project;
      try {
        const manifest = object(
          await readFile(
            join(input.workspaceRoot, project.root, 'package.json'),
            'utf8',
          ),
          'host package.json',
        );
        return { ...project, packageName: manifest.name };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return project;
      }
    }),
  );
  let ancestor = input.workspaceRoot;
  for (const part of safe(input.destination).split('/')) {
    ancestor = join(ancestor, part);
    try {
      if ((await lstat(ancestor)).isSymbolicLink())
        throw new Error(
          `Import destination traverses a symlink: ${input.destination}.`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const rootManifest = object(await input.read('package.json'), 'package.json');
  const pnpm = await input.read('pnpm-workspace.yaml');
  const workspaceGlobs: unknown = pnpm
    ? parse(pnpm)?.packages
    : Array.isArray(rootManifest.workspaces)
      ? rootManifest.workspaces
      : rootManifest.workspaces?.packages;
  if (
    !Array.isArray(workspaceGlobs) ||
    !workspaceGlobs.every((p) => typeof p === 'string')
  )
    throw new Error('Source monorepo must declare workspace package globs.');
  const roots = new Set(
    input.files
      .filter((file) => file.endsWith('/project.json'))
      .map(posix.dirname),
  );
  for (const file of input.files.filter((f) => f.endsWith('/package.json'))) {
    const root = posix.dirname(file);
    if (workspaceGlobs.some((glob) => workspaceMatch(root, glob)))
      roots.add(root);
  }
  if (!roots.size)
    throw new Error('No static source workspace projects were found.');
  const missing = [...roots].filter(
    (root) => !Object.hasOwn(selection.projects, root),
  );
  const unknown = Object.keys(selection.projects).filter(
    (root) => !roots.has(root),
  );
  if (missing.length || unknown.length)
    throw new Error(
      `Review every source project. Missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}.`,
    );
  const ordered = [...roots].sort();
  if (
    ordered.some((root) =>
      ordered.some((other) => root !== other && root.startsWith(`${other}/`)),
    )
  )
    throw new Error(
      'Overlapping source project roots require separation before import.',
    );
  const projects: MonorepoImportPlan['projects'][number][] = [];
  const versions = new Map<string, string>();
  for (const root of ordered) {
    safe(root);
    const manifest = object(
      await input.read(`${root}/package.json`),
      `${root}/package.json`,
    );
    const original = object(
      await input.read(`${root}/project.json`),
      `${root}/project.json`,
    );
    const choice = selection.projects[root];
    if (manifest.name !== undefined) packageIdentity.parse(manifest.name);
    const sourceName =
      original.name ??
      manifest.nx?.name ??
      manifest.name ??
      posix.basename(root);
    if (typeof sourceName !== 'string')
      throw new Error(`Invalid source project name at ${root}.`);
    if (
      projects.some(
        (p) =>
          p.sourceName === sourceName ||
          (manifest.name && p.sourcePackage === manifest.name),
      )
    )
      throw new Error(
        `Duplicate source project/package identity at ${root}; resolve it before importing.`,
      );
    if (choice.action === 'reuse') {
      const host = targetProjects.find((p) => p.name === choice.project);
      if (!host?.root || !manifest.name || host.packageName !== manifest.name)
        throw new Error(
          `Reuse ${root} requires an existing host project owning exactly ${manifest.name ?? 'the same package identity'}.`,
        );
      safe(host.root);
      const hostManifest = object(
        await readFile(
          join(input.workspaceRoot, host.root, 'package.json'),
          'utf8',
        ),
        'host package.json',
      );
      if (
        hostManifest.name !== manifest.name ||
        typeof hostManifest.version !== 'string'
      )
        throw new Error(
          `Reuse ${root} requires a versioned host package manifest with the same identity.`,
        );
      versions.set(manifest.name, hostManifest.version);
      projects.push({
        root,
        sourceName,
        sourcePackage: manifest.name,
        action: 'reuse',
        name: host.name,
        packageName: host.packageName,
        destination: host.root,
      });
    } else {
      if (!choice.configuration.targets.build)
        throw new Error(
          `Imported project ${root} needs an explicit reviewed build target.`,
        );
      for (const [target, config] of Object.entries(
        choice.configuration.targets,
      ))
        if (
          !(typeof config.executor === 'string' && config.executor.trim()) &&
          !(typeof config.command === 'string' && config.command.trim())
        )
          throw new Error(
            `Reviewed target ${root}:${target} needs an explicit executor or command.`,
          );
      for (const phase of ['test', 'lint'])
        if (
          (original.targets?.[phase] || manifest.scripts?.[phase]) &&
          !choice.configuration.targets[phase]
        )
          throw new Error(
            `Retain the existing ${phase} verification target for ${root}.`,
          );
      if (manifest.name && typeof manifest.version === 'string')
        versions.set(manifest.name, manifest.version);
      const packageName = choice.packageName ?? manifest.name;
      if (
        targetProjects.some(
          (p) =>
            p.name === choice.name ||
            (packageName && p.packageName === packageName),
        ) ||
        choice.name === input.name ||
        projects.some(
          (p) =>
            p.name === choice.name ||
            (packageName && p.packageName === packageName),
        )
      )
        throw new Error(
          `Monorepo project/package collision at ${root}; explicitly rename the import or reuse a host project.`,
        );
      projects.push({
        root,
        sourceName,
        ...(manifest.name ? { sourcePackage: manifest.name } : {}),
        action: 'import',
        name: choice.name,
        ...(packageName ? { packageName } : {}),
        destination: `${input.destination}/${root}`,
        configuration: {
          ...choice.configuration,
          name: choice.name,
          root: `${input.destination}/${root}`,
          sourceRoot: input.files.some((f) => f.startsWith(`${root}/src/`))
            ? `${input.destination}/${root}/src`
            : `${input.destination}/${root}`,
        },
      });
    }
  }
  if (!projects.some((p) => p.action === 'import'))
    throw new Error('Monorepo import must retain at least one new project.');
  const renamed = new Map(
    projects
      .filter((p) => p.sourcePackage && p.packageName !== p.sourcePackage)
      .map((p) => [p.sourcePackage as string, p.packageName as string]),
  );
  const rewrites: { source: string; content: string }[] = [];
  const edges: MonorepoImportPlan['edges'][number][] = [];
  const owner = (path: string) =>
    projects.find((p) => path === p.root || path.startsWith(`${p.root}/`));
  const rewritePath = async (file: string, value: string) => {
    const sourcePath = posix.normalize(posix.join(posix.dirname(file), value));
    const reused = owner(sourcePath);
    if (reused?.action !== 'reuse') return value;
    const target = posix.join(
      reused.destination,
      posix.relative(reused.root, sourcePath),
    );
    // Reuse mappings cannot assume a matching tsconfig/entry point exists.
    await readFile(
      join(
        input.workspaceRoot,
        target.endsWith('.json') || posix.extname(target)
          ? target
          : `${target}/tsconfig.json`,
      ),
    );
    return (
      posix.relative(
        posix.join(input.destination, posix.dirname(file)),
        target,
      ) || '.'
    );
  };
  for (const file of input.files) {
    if (owner(file)?.action === 'reuse') continue;
    if (file === 'package.json' || file.endsWith('/package.json')) {
      // A project can contain package fixtures; they are not workspace manifests.
      if (
        file !== 'package.json' &&
        !projects.some((p) => file === `${p.root}/package.json`)
      )
        continue;
      const content = object(await input.read(file), file);
      const project = owner(file);
      if (project) {
        content.name = project.packageName;
        delete content.nx;
      } else {
        content.name = input.name;
        content.private = true;
        delete content.workspaces;
        delete content.nx;
        delete content.packageManager;
        delete content.scripts;
      }
      for (const section of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ] as const) {
        const dependencies = content[section];
        if (!dependencies) continue;
        for (const [dependency, version] of Object.entries(dependencies)) {
          if (typeof version !== 'string')
            throw new Error(`Invalid dependency ${dependency} in ${file}.`);
          const target = projects.find((p) => p.sourcePackage === dependency);
          if (/^(?:file:|link:|yalc:)/.test(version))
            throw new Error(
              `Local dependency ${dependency} in ${file} must be replaced by a reproducible workspace or registry declaration first.`,
            );
          const range = version.startsWith('workspace:')
            ? version.slice('workspace:'.length)
            : version;
          const normalizedRange = ['^', '~'].includes(range) ? '*' : range;
          if (version.startsWith('workspace:') && !target)
            throw new Error(
              `Workspace dependency ${dependency} has no mapped source project.`,
            );
          if (
            target &&
            (!versions.has(dependency) ||
              !validRange(normalizedRange) ||
              !satisfies(versions.get(dependency) ?? '', normalizedRange))
          )
            throw new Error(
              `Mapped package ${dependency} does not satisfy ${version} required by ${file}. Review versions before import.`,
            );
          const replacement = renamed.get(dependency) ?? dependency;
          if (
            replacement !== dependency &&
            Object.hasOwn(dependencies, replacement)
          )
            throw new Error(
              `Renamed dependency ${replacement} already exists in ${file}.`,
            );
          delete dependencies[dependency];
          dependencies[replacement] =
            version.startsWith('workspace:') &&
            input.packageManager !== 'pnpm' &&
            input.packageManager !== 'bun'
              ? normalizedRange
              : version;
          const targetName =
            target?.name ??
            targetProjects.find((p) => p.packageName === replacement)?.name;
          const fromProject = project?.name ?? input.name;
          if (targetName && targetName !== fromProject)
            edges.push({
              fromProject,
              project: targetName,
              packageName: replacement,
            });
        }
      }
      rewrites.push({
        source: file,
        content: JSON.stringify(content, null, 2) + '\n',
      });
    } else if (/^tsconfig[^/]*\.json$/.test(posix.basename(file))) {
      const config = object(await input.read(file), file);
      if (Array.isArray(config.references))
        for (const reference of config.references)
          if (typeof reference.path === 'string')
            reference.path = await rewritePath(file, reference.path);
      if (typeof config.extends === 'string' && config.extends.startsWith('.'))
        config.extends = await rewritePath(file, config.extends);
      if (Array.isArray(config.extends))
        config.extends = await Promise.all(
          config.extends.map((value) =>
            value.startsWith('.') ? rewritePath(file, value) : value,
          ),
        );
      const paths = config.compilerOptions?.paths;
      if (paths)
        for (const [alias, targets] of Object.entries(paths)) {
          if (
            !Array.isArray(targets) ||
            !targets.every((p) => typeof p === 'string')
          )
            throw new Error(`Invalid TypeScript paths in ${file}.`);
          if (
            targets.some(
              (target) =>
                owner(
                  posix.normalize(
                    posix.join(
                      posix.dirname(file),
                      config.compilerOptions?.baseUrl ?? '.',
                      target,
                    ),
                  ),
                )?.action === 'reuse',
            )
          )
            throw new Error(
              `TypeScript alias ${alias} points at reused code; remove that source alias in favor of the host package before importing.`,
            );
        }
      rewrites.push({
        source: file,
        content: JSON.stringify(config, null, 2) + '\n',
      });
    } else if (/\.[cm]?[jt]sx?$/.test(file)) {
      const content = (await input.read(file)) ?? '';
      const source = ts.createSourceFile(
        file,
        content,
        ts.ScriptTarget.Latest,
        true,
      );
      const edits: { start: number; end: number; text: string }[] = [];
      const visit = (node: ts.Node) => {
        if (
          ts.isStringLiteral(node) &&
          (((ts.isImportDeclaration(node.parent) ||
            ts.isExportDeclaration(node.parent)) &&
            node.parent.moduleSpecifier === node) ||
            (ts.isCallExpression(node.parent) &&
              node.parent.arguments[0] === node &&
              (node.parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.parent.expression) &&
                  node.parent.expression.text === 'require'))))
        ) {
          if (
            node.text.startsWith('.') &&
            owner(posix.normalize(posix.join(posix.dirname(file), node.text)))
              ?.action === 'reuse'
          )
            throw new Error(
              `${file} imports reused code through a relative path; use its package identity before importing.`,
            );
          for (const [old, replacement] of renamed)
            if (node.text === old || node.text.startsWith(`${old}/`))
              edits.push({
                start: node.getStart(source),
                end: node.end,
                text: JSON.stringify(replacement + node.text.slice(old.length)),
              });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (edits.length) {
        let updated = content;
        for (const edit of edits.sort((a, b) => b.start - a.start))
          updated =
            updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
        rewrites.push({ source: file, content: updated });
      }
    }
  }
  for (const project of projects)
    if (project.configuration?.implicitDependencies) {
      project.configuration.implicitDependencies = (
        project.configuration.implicitDependencies as string[]
      ).map(
        (dependency) =>
          projects.find((p) => p.sourceName === dependency)?.name ?? dependency,
      );
    }
  return {
    selectionHash: integrationFingerprint(selection),
    projects,
    rewrites,
    edges,
  };
}
