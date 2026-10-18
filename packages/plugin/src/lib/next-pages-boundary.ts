import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ProjectGraph } from '@nx/devkit';
import * as ts from 'typescript';
import {
  nextPagesImports,
  nextPagesEdgeRuntime,
  type RuntimeImport,
} from './next-pages-imports';

const builtins = new Set(
  builtinModules.map((name) => name.replace(/^node:/, '')),
);
const codeFile = /\.[cm]?[jt]sx?$/;
const ignoredFile = /(?:\.d\.[cm]?ts|\.(?:spec|test)\.[cm]?[jt]sx?)$/;

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}

function json(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

export function nextPagesDirectory(root: string): string | undefined {
  const config = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts']
    .map((ext) => join(root, `next.config.${ext}`))
    .find(existsSync);
  if (!config || /\bpageExtensions\b/.test(readFileSync(config, 'utf8')))
    return undefined;
  // App Router server/client semantics need their own policy. Retain the strict
  // project boundary for those projects, including hybrid-router applications.
  if (['app', 'src/app'].some((path) => existsSync(join(root, path))))
    return undefined;
  const pages = ['pages', 'src/pages']
    .map((path) => join(root, path))
    .find(existsSync);
  const unsupported = (directory: string): boolean =>
    readdirSync(directory, { withFileTypes: true }).some((entry) =>
      entry.isDirectory()
        ? unsupported(join(directory, entry.name))
        : /\.mdx?$/.test(entry.name),
    );
  return pages && !unsupported(pages) ? pages : undefined;
}

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.isFile() && codeFile.test(path) && !ignoredFile.test(path)
      ? [path]
      : [];
  });
}

/** Only an active, explicit browser export changes a Node package's capability. */
export function hasBrowserExport(
  manifest: Record<string, unknown>,
  subpath: string,
  mode: RuntimeImport['mode'],
  customConditions: readonly string[] = [],
): boolean {
  const exports = manifest.exports;
  let value: unknown = exports;
  if (
    exports &&
    typeof exports === 'object' &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith('.'))
  ) {
    value = (exports as Record<string, unknown>)[subpath];
  } else if (subpath !== '.') return false;
  const select = (branch: unknown, browser: boolean): boolean | undefined => {
    if (typeof branch === 'string')
      return (
        branch.startsWith('./') && !branch.split('/').includes('..') && browser
      );
    if (branch === null) return false;
    if (!branch || typeof branch !== 'object' || Array.isArray(branch))
      return undefined;
    for (const [condition, target] of Object.entries(branch)) {
      if (
        !['browser', mode, 'default', ...customConditions].includes(condition)
      )
        continue;
      const selected = select(target, browser || condition === 'browser');
      if (selected !== undefined) return selected;
    }
    return undefined;
  };
  return select(value, false) === true;
}

export interface NextPagesBoundary {
  readonly violations: readonly string[];
  readonly browserFiles: ReadonlySet<string>;
  readonly serverFiles: ReadonlySet<string>;
}

/** Trace application-owned modules, without executing config or requiring a build. */
export function checkNextPagesBoundary(
  workspaceRoot: string,
  projectRoot: string,
  graph: ProjectGraph,
): NextPagesBoundary | undefined {
  const pages = nextPagesDirectory(projectRoot);
  if (!pages) return undefined;
  const entries = files(pages);
  if (!entries.length) return undefined;
  const browserFiles = new Set<string>();
  const serverFiles = new Set<string>();
  const violations = new Set<string>();
  const config = ts.findConfigFile(projectRoot, existsSync);
  const options = config
    ? ts.parseJsonConfigFileContent(
        ts.readConfigFile(config, ts.sys.readFile).config,
        ts.sys,
        dirname(config),
      ).options
    : { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
  const resolutionCache = ts.createModuleResolutionCache(
    projectRoot,
    (name) => name,
    options,
  );
  const projects = Object.entries(graph.nodes)
    .map(([name, node]) => {
      const root = resolve(workspaceRoot, node.data.root);
      const manifest = json(join(root, 'package.json')) ?? {};
      return {
        name,
        root,
        manifest,
        packageName: typeof manifest.name === 'string' ? manifest.name : name,
        platform: node.data.tags
          ?.find((tag) => tag.startsWith('platform:'))
          ?.slice(9),
      };
    })
    .sort((a, b) => b.root.length - a.root.length);
  const importsCache = new Map<string, readonly RuntimeImport[]>();
  const pending = entries.map((path) => ({
    path,
    server: /^(?:api\/|_document\.)/.test(
      relative(pages, path).replaceAll('\\', '/'),
    ),
  }));
  for (const directory of [projectRoot, join(projectRoot, 'src')]) {
    for (const name of [
      'middleware',
      'proxy',
      'instrumentation-client',
      'instrumentation',
    ]) {
      for (const ext of ['js', 'ts']) {
        const path = join(directory, `${name}.${ext}`);
        if (existsSync(path))
          pending.push({
            path,
            server: ['proxy', 'instrumentation'].includes(name),
          });
      }
    }
  }
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    const { path } = entry;
    const text = readFileSync(path, 'utf8');
    const edge =
      (inside(pages, path) || /middleware\.[jt]s$/.test(path)) &&
      nextPagesEdgeRuntime(path, text);
    const server = entry.server && !edge;
    const visited = server ? serverFiles : browserFiles;
    if (visited.has(path)) continue;
    visited.add(path);
    const page =
      inside(pages, path) &&
      !/^(?:api\/|_document\.)/.test(
        relative(pages, path).replaceAll('\\', '/'),
      );
    let imports = importsCache.get(path);
    if (!imports) {
      imports = nextPagesImports(
        path,
        text,
        page && !edge,
        options.verbatimModuleSyntax,
      );
      importsCache.set(path, imports);
    }
    for (const dependency of imports) {
      const nodeRuntime = server || dependency.serverOnly;
      const specifier = dependency.specifier;
      const report = (reason: string) =>
        violations.add(
          `${relative(workspaceRoot, path).replaceAll('\\', '/')}: ${reason}`,
        );
      if (!specifier) {
        if (!nodeRuntime)
          report(
            'Cannot verify a nonliteral browser import or require; use a literal module specifier.',
          );
        continue;
      }
      if (
        specifier === 'server-only' ||
        builtins.has(specifier.replace(/^node:/, '')) ||
        specifier.startsWith('node:')
      ) {
        if (!nodeRuntime) report(`Browser code may not import ${specifier}.`);
        continue;
      }
      const named = projects.find(
        (project) =>
          specifier === project.packageName ||
          specifier.startsWith(`${project.packageName}/`),
      );
      if (named?.platform === 'node') {
        const subpath =
          specifier === named.packageName
            ? '.'
            : `.${specifier.slice(named.packageName.length)}`;
        if (
          !nodeRuntime &&
          !hasBrowserExport(
            named.manifest,
            subpath,
            dependency.mode,
            options.customConditions,
          )
        )
          report(
            `Browser code may not import platform:node through ${specifier}; use a browser export or a server data function.`,
          );
        // Explicit browser conditions are package capability declarations, like
        // platform tags. Their implementation remains the package author's contract.
        continue;
      }
      const resolved = ts.resolveModuleName(
        specifier,
        path,
        options,
        ts.sys,
        resolutionCache,
      ).resolvedModule;
      let target = resolved?.resolvedFileName;
      const resolvedOwner =
        resolved &&
        projects.find((project) =>
          inside(project.root, resolved.resolvedFileName),
        );
      if (
        !nodeRuntime &&
        resolvedOwner &&
        resolvedOwner.platform === 'node' &&
        target &&
        !target.split(/[\\/]/).includes('node_modules')
      ) {
        report(
          `Browser code may not import platform:node through ${specifier}.`,
        );
        continue;
      }
      if (target && /\.d\.[cm]?ts$/.test(target)) {
        const runtime = target
          .replace(/\.d\.ts$/, '.js')
          .replace(/\.d\.mts$/, '.mjs')
          .replace(/\.d\.cts$/, '.cjs');
        target = existsSync(runtime) ? runtime : undefined;
      }
      if (!target) {
        if (
          !nodeRuntime &&
          specifier.startsWith('.') &&
          !/\.(?:css|scss|sass|less|svg|png|jpe?g|webp|gif|json)$/.test(
            specifier,
          )
        )
          report(
            `Cannot resolve browser import ${specifier} to verify its platform boundary.`,
          );
        continue;
      }
      const targetPath = target;
      const owner = projects.find((project) =>
        inside(project.root, targetPath),
      );
      if (!owner || target.split(/[\\/]/).includes('node_modules')) continue;
      if (!nodeRuntime && owner.platform === 'node') {
        report(
          `Browser code may not import platform:node through ${specifier}.`,
        );
        continue;
      }
      if (codeFile.test(target) && !ignoredFile.test(target))
        pending.push({ path: target, server: nodeRuntime });
    }
  }
  return { violations: [...violations], browserFiles, serverFiles };
}
