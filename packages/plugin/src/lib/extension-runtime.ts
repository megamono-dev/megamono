import type { ProjectGraph } from '@nx/devkit';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { z } from 'zod';
import { acceptedBoundaryDecisions } from './boundary-policy';

const sourceFile = /\.[cm]?[jt]sx?$/;
const excluded = new Set([
  'node_modules',
  '.yalc',
  '.git',
  '.nx',
  '.wxt',
  '.output',
  'dist',
  'build',
  'coverage',
  'test-output',
]);
const nonRuntime =
  /(?:\.d\.[cm]?ts|\.(?:spec|test)\.[cm]?[jt]sx?|(?:^|\/)(?:wxt|vite|vitest|eslint)\.config\.[cm]?[jt]s)$/;
const safePath = z
  .string()
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/)
  .refine(
    (value) =>
      !value
        .split('/')
        .some((segment) => ['', '.', '..', ...excluded].includes(segment)),
    'Use a repository-owned relative path without dot segments.',
  );
export const extensionRuntimeEntriesSchema = z
  .object({
    version: z.literal(1),
    renderers: z
      .array(safePath.refine((value) => value.endsWith('.html')))
      .min(1),
    workers: z.array(safePath.refine((value) => sourceFile.test(value))),
    rationale: z.string().trim().min(1),
    decision: z.string().regex(/^decision-\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ['renderers', 'workers'] as const)
      if (new Set(value[key]).size !== value[key].length)
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'Runtime entries must be unique.',
        });
  });
export type ExtensionRuntimeEntries = z.infer<
  typeof extensionRuntimeEntriesSchema
>;
type Kind = 'static' | 'dynamic';
interface Import {
  readonly specifier?: string;
  readonly start: number;
  readonly kind: Kind;
  readonly worker?: boolean;
}
export interface ExtensionRuntimeIssue {
  readonly file: string;
  readonly start?: number;
  readonly message: string;
  readonly kind: 'node' | 'web' | 'unresolved';
}
export interface ExtensionRuntimeUse {
  readonly file: string;
  readonly start: number;
  readonly specifier: string;
  readonly kind: Kind;
  readonly targetRoot: string;
  readonly target?: string;
  readonly rendererOnly: boolean;
}
export interface ExtensionRuntimeBoundary {
  readonly contract: ExtensionRuntimeEntries | undefined;
  readonly policyErrors: readonly string[];
  readonly issues: readonly ExtensionRuntimeIssue[];
  readonly rendererFiles: ReadonlySet<string>;
  readonly workerFiles: ReadonlySet<string>;
  readonly uses: readonly ExtensionRuntimeUse[];
  readonly inputs: ReadonlySet<string>;
  /** Source consistency under the attested roots, not execution of dynamic config. */
  readonly complete: boolean;
}
function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' ||
    (!isAbsolute(suffix) &&
      suffix !== '..' &&
      !suffix.startsWith('../') &&
      !suffix.startsWith('..\\'))
  );
}
interface Marker {
  readonly name?: unknown;
  readonly tags?: readonly string[];
  readonly nx?: { readonly tags?: readonly string[] };
  readonly megamono?: {
    readonly extension?: { readonly runtimeEntries?: unknown };
  };
}
function record(path: string): Marker | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Marker;
  } catch {
    return undefined;
  }
}
function codeImports(filename: string, text: string): Import[] {
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  if (
    (source as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics
      .length
  )
    return [{ start: 0, kind: 'static' }];
  const imports: Import[] = [];
  const literal = (value: ts.Expression | undefined) =>
    value && ts.isStringLiteralLike(value) ? value.text : undefined;
  const nameOf = (expression: ts.Expression): string | undefined => {
    while (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    )
      expression = expression.expression;
    return ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : ts.isElementAccessExpression(expression) &&
            expression.argumentExpression &&
            ts.isStringLiteralLike(expression.argumentExpression)
          ? expression.argumentExpression.text
          : undefined;
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (
        clause?.isTypeOnly ||
        (clause?.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly))
      )
        return;
      imports.push({
        specifier: ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : undefined,
        start: node.getStart(source),
        kind: 'static',
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (
        node.isTypeOnly ||
        (node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length &&
          node.exportClause.elements.every((element) => element.isTypeOnly))
      )
        return;
      imports.push({
        specifier: ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : undefined,
        start: node.getStart(source),
        kind: 'static',
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      imports.push({
        specifier: literal(node.moduleReference.expression),
        start: node.getStart(source),
        kind: 'static',
      });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require') ||
        nameOf(node.expression) === 'importScripts')
    ) {
      const args =
        nameOf(node.expression) === 'importScripts'
          ? node.arguments
          : [node.arguments[0]];
      for (const arg of args)
        imports.push({
          specifier: literal(arg),
          start: node.getStart(source),
          kind:
            node.expression.kind === ts.SyntaxKind.ImportKeyword
              ? 'dynamic'
              : 'static',
        });
    } else if (
      ts.isNewExpression(node) &&
      ['Worker', 'SharedWorker'].includes(nameOf(node.expression) ?? '')
    ) {
      const arg = node.arguments?.[0];
      const url =
        arg && ts.isNewExpression(arg) && nameOf(arg.expression) === 'URL'
          ? arg.arguments?.[0]
          : arg;
      imports.push({
        specifier: literal(url),
        start: node.getStart(source),
        kind: 'static',
        worker: true,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

/** Bounded HTML tokenization: quoted attributes are not markup or script roots. */
function rendererScripts(html: string): string[] | undefined {
  const result: string[] = [];
  const forbidden = new Set([
    'base',
    'template',
    'textarea',
    'noscript',
    'xmp',
    'plaintext',
    'iframe',
    'noembed',
    'noframes',
    'svg',
    'math',
    'object',
    'embed',
    'applet',
    'frameset',
    'select',
  ]);
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) return undefined;
      index = end + 3;
      continue;
    }
    let end = start + 1,
      quote: string | undefined;
    for (; end < html.length; end++) {
      const character = html[end];
      if (quote) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === html.length || quote) return undefined;
    const token = html.slice(start + 1, end);
    if (/^!doctype\s/i.test(token)) {
      index = end + 1;
      continue;
    }
    const name = /^\/?([A-Za-z][\w:-]*)(?=\s|\/|$)/.exec(token);
    if (!name) return undefined;
    const tag = name[1].toLowerCase();
    if (forbidden.has(tag)) return undefined;
    if (/\s+on[\w-]+\s*=|javascript\s*:/i.test(token)) return undefined;
    if (token.startsWith('/')) {
      index = end + 1;
      continue;
    }
    if (['style', 'title'].includes(tag)) {
      const closing = new RegExp(`</${tag}\\s*>`, 'ig');
      closing.lastIndex = end + 1;
      const match = closing.exec(html);
      if (!match) return undefined;
      index = closing.lastIndex;
      continue;
    }
    if (tag !== 'script') {
      index = end + 1;
      continue;
    }
    const attributes = new Map<string, string | undefined>();
    let cursor = name[0].length;
    while (cursor < token.length) {
      while (/\s/.test(token[cursor] ?? '') && cursor < token.length) cursor++;
      if (cursor === token.length) break;
      const attribute = /^[^\s"'<>/=]+/.exec(token.slice(cursor));
      if (!attribute) return undefined;
      const key = attribute[0].toLowerCase();
      cursor += attribute[0].length;
      if (attributes.has(key) || key.startsWith('on')) return undefined;
      while (/\s/.test(token[cursor] ?? '') && cursor < token.length) cursor++;
      let value: string | undefined;
      if (token[cursor] === '=') {
        cursor++;
        while (/\s/.test(token[cursor] ?? '') && cursor < token.length)
          cursor++;
        const delimiter = token[cursor];
        if (delimiter !== '"' && delimiter !== "'") return undefined;
        const closing = token.indexOf(delimiter, cursor + 1);
        if (closing < 0) return undefined;
        value = token.slice(cursor + 1, closing);
        cursor = closing + 1;
      }
      attributes.set(key, value);
    }
    const closing = /<\/script\s*>/gi;
    closing.lastIndex = end + 1;
    const match = closing.exec(html);
    if (!match || html.slice(end + 1, match.index).trim()) return undefined;
    const src = attributes.get('src');
    if (
      attributes.get('type') !== 'module' ||
      !src ||
      /[?#&%]|^[a-z]+:|^\/\//i.test(src)
    )
      return undefined;
    result.push(src);
    index = closing.lastIndex;
  }
  return result.length ? result : undefined;
}

/** Explicit, reviewed root attestation plus source reachability, never config execution. */
export function checkExtensionRuntimeBoundary(
  workspaceRoot: string,
  projectRoot: string,
  graph?: ProjectGraph,
  docsRoot = 'docs',
  override?: { readonly filename: string; readonly text: string },
): ExtensionRuntimeBoundary | undefined {
  try {
    if (
      record(join(resolve(projectRoot), 'package.json'))?.megamono?.extension
        ?.runtimeEntries === undefined
    )
      return undefined;
  } catch {
    return undefined; /* Malformed manifests cannot authorize an exemption. */
  }
  const originalRoot = resolve(workspaceRoot);
  workspaceRoot = realpathSync(originalRoot);
  projectRoot = resolve(
    workspaceRoot,
    relative(originalRoot, resolve(projectRoot)),
  );
  const inputs = new Set<string>();
  const policyErrors: string[] = [];
  const issues: ExtensionRuntimeIssue[] = [];
  const rendererFiles = new Set<string>(),
    workerFiles = new Set<string>();
  const uses: ExtensionRuntimeUse[] = [];
  let contract: ExtensionRuntimeEntries | undefined;
  let complete = true;
  const result = (): ExtensionRuntimeBoundary => ({
    contract,
    policyErrors,
    issues,
    rendererFiles,
    workerFiles,
    uses,
    inputs,
    complete: complete && !policyErrors.length && !issues.length,
  });
  const owned = (path: string): boolean => {
    if (
      !inside(workspaceRoot, path) ||
      relative(workspaceRoot, path)
        .split(/[\\/]/)
        .some((segment) => excluded.has(segment))
    )
      return false;
    let current = workspaceRoot;
    for (const segment of relative(workspaceRoot, path).split(/[\\/]/)) {
      current = join(current, segment);
      if (!existsSync(current) || lstatSync(current).isSymbolicLink())
        return false;
    }
    return true;
  };
  let manifest: Marker;
  try {
    manifest = record(join(projectRoot, 'package.json')) ?? {};
    const supplied = manifest.megamono?.extension?.runtimeEntries;
    if (supplied === undefined) return undefined;
    inputs.add(join(projectRoot, 'package.json'));
    const parsed = extensionRuntimeEntriesSchema.safeParse(supplied);
    if (!parsed.success) {
      policyErrors.push(
        'Invalid extension runtimeEntries contract: ' +
          parsed.error.issues.map((issue) => issue.message).join('; '),
      );
      return result();
    }
    contract = parsed.data;
    if (!owned(projectRoot)) {
      policyErrors.push(
        'Extension runtime roots must remain repository-owned without symlinks.',
      );
      return result();
    }
    if (
      !acceptedBoundaryDecisions(workspaceRoot, docsRoot).has(contract.decision)
    ) {
      policyErrors.push(
        `Extension runtime decision ${contract.decision} is missing, malformed, inactive, duplicated, archived or superseded.`,
      );
      return result();
    }
  } catch {
    policyErrors.push(
      'Cannot validate the extension runtime contract and decision authority.',
    );
    return result();
  }
  const textFor = (path: string) => {
    inputs.add(path);
    const overridden =
      override &&
      resolve(
        workspaceRoot,
        relative(originalRoot, resolve(override.filename)),
      );
    return override && overridden === path
      ? override.text
      : readFileSync(path, 'utf8');
  };
  const inventory: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        complete = false;
        policyErrors.push(
          `Cannot attest symlinked extension source ${relative(projectRoot, path)}.`,
        );
        continue;
      }
      if (entry.isDirectory()) walk(path);
      else if (
        entry.isFile() &&
        sourceFile.test(path) &&
        !nonRuntime.test(path)
      )
        inventory.push(path);
    }
  };
  try {
    walk(projectRoot);
  } catch {
    policyErrors.push('Cannot inventory extension-owned sources.');
    return result();
  }
  const optionsFile = ts.findConfigFile(projectRoot, existsSync);
  let options: ts.CompilerOptions = {
    allowJs: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  if (optionsFile) {
    const config = ts.readConfigFile(optionsFile, ts.sys.readFile);
    if (config.error) {
      policyErrors.push('Cannot read extension TypeScript configuration.');
      return result();
    }
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      dirname(optionsFile),
    );
    if (parsed.errors.length) {
      policyErrors.push(
        'Cannot resolve extension TypeScript configuration; prepare generated configuration before checking.',
      );
      return result();
    }
    options = parsed.options;
  }
  if (optionsFile) inputs.add(optionsFile);
  const projects = Object.entries(graph?.nodes ?? {})
    .filter(
      ([, node]) =>
        !node.data.root.split(/[\\/]/).some((segment) => excluded.has(segment)),
    )
    .map(([name, node]) => {
      const root = resolve(workspaceRoot, node.data.root);
      const marker = record(join(root, 'package.json')) ?? {};
      const physical =
        record(join(root, 'project.json'))?.tags ?? marker.nx?.tags;
      const tags = Array.isArray(physical)
        ? physical
        : Array.isArray(node.data.tags)
          ? node.data.tags
          : [];
      return {
        name,
        root,
        packageName: typeof marker.name === 'string' ? marker.name : name,
        platform: tags
          .find(
            (tag: unknown) =>
              typeof tag === 'string' && tag.startsWith('platform:'),
          )
          ?.slice(9),
      };
    })
    .sort((a, b) => b.root.length - a.root.length);
  const owner = (path: string) => {
    const known = projects.find((project) => inside(project.root, path));
    let directory = dirname(path);
    while (inside(workspaceRoot, directory)) {
      const project = record(join(directory, 'project.json'));
      const manifest = record(join(directory, 'package.json'));
      const tags = project?.tags ?? manifest?.nx?.tags;
      if (Array.isArray(tags))
        return {
          root: directory,
          name: known?.root === directory ? known.name : undefined,
          packageName: undefined,
          platform: tags
            .find(
              (tag: unknown) =>
                typeof tag === 'string' && tag.startsWith('platform:'),
            )
            ?.slice(9),
        };
      if (directory === workspaceRoot) break;
      directory = dirname(directory);
    }
    return known;
  };
  const resolveImport = (specifier: string, path: string) => {
    let target = ts.resolveModuleName(specifier, path, options, ts.sys)
      .resolvedModule?.resolvedFileName;
    if (!target && specifier.startsWith('.'))
      target = [
        resolve(dirname(path), specifier),
        ...[
          '.ts',
          '.tsx',
          '.js',
          '.jsx',
          '.mjs',
          '.cjs',
          '/index.ts',
          '/index.tsx',
          '/index.js',
        ].map((ext) => resolve(dirname(path), specifier + ext)),
      ].find(
        (candidate) => existsSync(candidate) && lstatSync(candidate).isFile(),
      );
    if (target && /\.d\.[cm]?ts$/.test(target)) {
      const runtime = target
        .replace(/\.d\.ts$/, '.js')
        .replace(/\.d\.mts$/, '.mjs')
        .replace(/\.d\.cts$/, '.cjs');
      target = existsSync(runtime) ? runtime : target;
    }
    return target && resolve(target);
  };
  const renderers: string[] = [];
  const workers: string[] = [];
  for (const entry of contract.renderers) {
    const path = resolve(projectRoot, entry);
    if (!owned(path) || !lstatSync(path).isFile()) {
      policyErrors.push(`Missing or unsafe renderer HTML entry ${entry}.`);
      continue;
    }
    let scripts: string[] | undefined;
    try {
      scripts = rendererScripts(textFor(path));
    } catch {
      /* Unreadable HTML cannot authorize runtime roots. */
    }
    if (!scripts)
      policyErrors.push(
        `Renderer ${entry} must bind literal local module scripts without ambiguous or inert-container markup.`,
      );
    for (const src of scripts ?? []) {
      const target = resolve(
        src.startsWith('/') ? projectRoot : dirname(path),
        src.replace(/^\//, ''),
      );
      if (
        !inside(projectRoot, target) ||
        !owned(target) ||
        !sourceFile.test(target) ||
        !lstatSync(target).isFile()
      )
        policyErrors.push(`Missing or unsafe renderer module in ${entry}.`);
      else renderers.push(target);
    }
  }
  for (const entry of contract.workers) {
    const path = resolve(projectRoot, entry);
    if (!owned(path) || !lstatSync(path).isFile())
      policyErrors.push(`Missing or unsafe worker entry ${entry}.`);
    else workers.push(path);
  }
  // A canonical background/worker entry cannot be reclassified by HTML reuse.
  workers.push(
    ...inventory.filter((path) =>
      /(?:^|\/)background(?:\/|\.)|\.worker\.[cm]?[jt]sx?$/.test(path),
    ),
  );
  if (policyErrors.length) return result();
  const observations = new Map<
    string,
    {
      dependency: Import;
      targetRoot: string;
      target?: string;
      platform?: string;
    }
  >();
  const builtins = new Set(
    builtinModules.map((name) => name.replace(/^node:/, '')),
  );
  const issue = (
    file: string,
    dependency: Import,
    message: string,
    kind: ExtensionRuntimeIssue['kind'],
  ) => {
    complete = false;
    if (
      !issues.some(
        (other) =>
          other.file === file &&
          other.start === dependency.start &&
          other.message === message,
      )
    )
      issues.push({ file, start: dependency.start, message, kind });
  };
  const importsCache = new Map<string, Import[]>();
  const trace = (pending: string[], renderer: boolean) => {
    const seen = renderer ? rendererFiles : workerFiles;
    while (pending.length) {
      const path = pending.pop();
      if (!path || seen.has(path)) continue;
      if (!owned(path)) {
        complete = false;
        policyErrors.push(
          'Cannot trace an unsafe or symlinked runtime module.',
        );
        continue;
      }
      seen.add(path);
      let imports = importsCache.get(path);
      if (!imports) {
        imports = codeImports(path, textFor(path));
        importsCache.set(path, imports);
      }
      for (const dependency of imports) {
        const specifier = dependency.specifier;
        if (!specifier) {
          issue(
            path,
            dependency,
            'Cannot verify a nonliteral runtime import or worker entry.',
            'unresolved',
          );
          continue;
        }
        if (
          specifier.startsWith('node:') ||
          builtins.has(specifier.replace(/^node:/, ''))
        ) {
          issue(
            path,
            dependency,
            `Extension runtime may not import Node built-in ${specifier}.`,
            'node',
          );
          continue;
        }
        const named = projects.find(
          (project) =>
            specifier === project.packageName ||
            specifier.startsWith(project.packageName + '/'),
        );
        const target = resolveImport(specifier, path);
        const installed = target
          ?.split(/[\\/]/)
          .some((segment) => excluded.has(segment));
        const targetOwner =
          named ?? (target && !installed ? owner(target) : undefined);
        if (target && owned(target) && named && !inside(named.root, target))
          issue(
            path,
            dependency,
            `Resolved source for ${specifier} does not belong to its graph project.`,
            'unresolved',
          );
        if (
          target &&
          owned(target) &&
          !targetOwner &&
          !inside(projectRoot, target)
        )
          issue(
            path,
            dependency,
            `Cannot classify repository-owned runtime import ${specifier}.`,
            'unresolved',
          );
        if (targetOwner?.platform && targetOwner.root !== projectRoot)
          observations.set(`${path}:${dependency.start}`, {
            dependency,
            targetRoot: targetOwner.root,
            target: targetOwner.name,
            platform: targetOwner.platform,
          });
        if (targetOwner?.platform === 'node')
          issue(
            path,
            dependency,
            `Extension runtime may not import platform:node through ${specifier}.`,
            'node',
          );
        if (target && owned(target) && /\.d\.[cm]?ts$/.test(target))
          issue(
            path,
            dependency,
            `Cannot verify runtime source behind declaration ${specifier}.`,
            'unresolved',
          );
        if (
          target &&
          !owned(target) &&
          (!installed || specifier.startsWith('.') || named)
        )
          issue(
            path,
            dependency,
            `Cannot trace unsafe runtime import ${specifier}.`,
            'unresolved',
          );
        if (dependency.worker) {
          if (!target || !owned(target))
            issue(
              path,
              dependency,
              `Cannot resolve worker source ${specifier}.`,
              'unresolved',
            );
          else workers.push(target);
        } else if (
          target &&
          owned(target) &&
          sourceFile.test(target) &&
          !/\.d\.[cm]?ts$/.test(target)
        )
          pending.push(target);
        else if (!target)
          issue(
            path,
            dependency,
            `Cannot resolve runtime import ${specifier}.`,
            'unresolved',
          );
      }
    }
  };
  try {
    trace([...renderers], true);
    trace(
      [...workers, ...inventory.filter((path) => !rendererFiles.has(path))],
      false,
    );
    // Renderer traversal can discover worker constructors through shared modules.
    trace(workers, false);
  } catch {
    complete = false;
    policyErrors.push('Cannot complete extension source reachability.');
  }
  for (const [key, observed] of observations) {
    const file = key.slice(0, key.lastIndexOf(':'));
    if (observed.platform !== 'web') continue;
    const rendererOnly =
      !observed.dependency.worker &&
      rendererFiles.has(file) &&
      !workerFiles.has(file);
    const specifier = observed.dependency.specifier;
    if (!specifier) continue;
    uses.push({
      file,
      start: observed.dependency.start,
      specifier,
      kind: observed.dependency.kind,
      targetRoot: observed.targetRoot,
      target: observed.target,
      rendererOnly,
    });
    if (!rendererOnly)
      issue(
        file,
        observed.dependency,
        `Extension worker or unclassified source may not import platform:web through ${specifier}.`,
        'web',
      );
  }
  return result();
}

export function extensionAllowsWebEdge(
  analysis: ExtensionRuntimeBoundary | undefined,
  targetRoot: string,
  kind: string,
): boolean {
  if (!analysis?.complete || !['static', 'dynamic'].includes(kind))
    return false;
  const root = existsSync(targetRoot) ? realpathSync(targetRoot) : targetRoot;
  return Boolean(
    analysis.uses.some(
      (use) => use.targetRoot === root && use.kind === kind && use.rendererOnly,
    ),
  );
}
