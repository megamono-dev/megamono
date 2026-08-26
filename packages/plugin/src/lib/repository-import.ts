import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import matter = require('gray-matter');
import ts = require('typescript');
import {
  getTopicVocabulary,
  readMegamonoConfig,
  type MegamonoConfig,
} from './config';
import {
  getDocumentDirectory,
  repositoryDocumentSchema,
  validateRepositoryDocs,
  type RepositoryDocumentType,
} from './docs';

const executeFile = promisify(execFile);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const noOpDispose = () => Promise.resolve();

export type ImportHistoryStrategy = 'subtree' | 'filter-repo' | 'squash';
export type ImportVerifyMode = 'none' | 'config' | 'build';

export interface ImportResolutions {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly aliases?: Readonly<Record<string, string>>;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface RepositoryImportOptions {
  readonly source: string;
  readonly ref?: string;
  readonly expectedSourceSha?: string;
  readonly name: string;
  readonly destination?: string;
  readonly history?: ImportHistoryStrategy;
  readonly verify?: ImportVerifyMode;
  readonly execute?: boolean;
  readonly allowHistoryLoss?: boolean;
  readonly resolutions?: ImportResolutions;
}

export interface ImportGitState {
  readonly available: boolean;
  readonly clean: boolean;
  readonly branch?: string;
  readonly defaultBranch?: string;
  readonly baseSha?: string;
}

export interface ImportIssue {
  readonly code: string;
  readonly message: string;
  readonly subject?: string;
}

export interface ImportDependencyConflict {
  readonly name: string;
  readonly source: string;
  readonly target: string;
  readonly resolution?: string;
}

export interface ImportCollision {
  readonly kind: 'project-name' | 'destination' | 'alias' | 'environment';
  readonly name: string;
  readonly source?: string;
  readonly target?: string;
  readonly resolution?: string;
  readonly affectedFiles?: readonly string[];
}

export interface ImportRepositoryRoute {
  readonly source: string;
  readonly destination: string;
  readonly action: 'migrate-document' | 'move-asset' | 'archive';
  readonly reason: 'documentation' | 'documentation-asset' | 'infrastructure';
  readonly document?: {
    readonly mode: 'preserve' | 'wrap';
    readonly id: string;
    readonly type: RepositoryDocumentType;
    readonly status: string;
    readonly date: string;
  };
}

export interface ImportRoutedModuleReference {
  readonly sourceFile: string;
  readonly specifier: string;
  readonly targetSource: string;
  readonly targetDestination: string;
  readonly reason: ImportRepositoryRoute['reason'];
}

export interface ImportExpectedGraphDependency {
  readonly project: string;
  readonly packageName: string;
}

export interface RepositoryImportAnalysis {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly sourceKind: 'local' | 'remote';
  readonly sourceSha: string;
  readonly sourceRef: string;
  readonly name: string;
  readonly destination: string;
  readonly history?: ImportHistoryStrategy;
  readonly verify: ImportVerifyMode;
  readonly packageManager: 'pnpm' | 'npm';
  readonly targetGit: ImportGitState;
  readonly sourceGit: ImportGitState;
  readonly sourcePackageName?: string;
  readonly sourceFiles: readonly string[];
  readonly repositoryRoutes: readonly ImportRepositoryRoute[];
  readonly routedModuleReferences: readonly ImportRoutedModuleReference[];
  readonly expectedGraphDependencies: readonly ImportExpectedGraphDependency[];
  readonly documentationTopicsToExtend: readonly string[];
  readonly commands: Readonly<
    Partial<Record<'build' | 'test' | 'lint' | 'deploy', string>>
  >;
  readonly nonJsSurfaces: readonly {
    readonly ecosystem: 'apple' | 'cargo' | 'php';
    readonly manifest: string;
    readonly plugin?: '@megamono/nx-apple' | '@megamono/nx-cargo';
  }[];
  readonly dependencyConflicts: readonly ImportDependencyConflict[];
  readonly collisions: readonly ImportCollision[];
  readonly blockers: readonly ImportIssue[];
  readonly unresolved: readonly ImportIssue[];
  readonly ready: boolean;
}

export class ImportOptionsError extends Error {
  readonly exitCode = 2;

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ImportPreflightError extends Error {
  readonly exitCode = 3;

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ImportDecisionError extends Error {
  readonly exitCode = 4;

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface PackageManifest {
  readonly name?: string;
  readonly packageManager?: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly workspaces?: unknown;
}

interface SourceSnapshot {
  readonly root: string;
  readonly kind: 'local' | 'remote';
  readonly display: string;
  readonly sha: string;
  readonly commitDate: string;
  readonly ref: string;
  readonly git: ImportGitState;
  readonly files: readonly string[];
  readonly manifest: PackageManifest;
  readonly aliases: Readonly<Record<string, readonly string[]>>;
  readonly environmentNames: readonly string[];
  readonly dispose: () => Promise<void>;
}

export interface RepositoryImportAnalysisInput {
  readonly workspaceRoot: string;
  readonly options: RepositoryImportOptions;
  readonly projectNames?: readonly string[];
  readonly targetProjects?: readonly {
    readonly name: string;
    readonly packageName?: string;
  }[];
}

export function normalizedImportDestination(
  name: string,
  destination?: string,
): string {
  const value = (destination ?? `apps/${name}`)
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
  const segments = value.split('/');
  if (
    !value ||
    value.startsWith('/') ||
    value === '..' ||
    value.startsWith('../') ||
    value.includes('/../') ||
    segments.some(
      (segment) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment === '.',
    ) ||
    ['.git', '.megamono', '.megamono-import', 'node_modules'].includes(
      segments[0]?.toLowerCase() ?? '',
    )
  ) {
    throw new ImportOptionsError(
      'import-invalid-destination',
      'destination must be a safe workspace-relative path.',
    );
  }
  return value;
}

function validateOptions(options: RepositoryImportOptions): void {
  if (!options.source.trim()) {
    throw new ImportOptionsError(
      'import-invalid-source',
      'source must not be empty.',
    );
  }
  if (!slugPattern.test(options.name)) {
    throw new ImportOptionsError(
      'import-invalid-name',
      'name must be a lowercase hyphenated project name.',
    );
  }
  normalizedImportDestination(options.name, options.destination);
  if (
    options.expectedSourceSha &&
    !/^[a-f0-9]{40}$/i.test(options.expectedSourceSha)
  ) {
    throw new ImportOptionsError(
      'import-invalid-expected-sha',
      'expectedSourceSha must be a full 40-character Git commit SHA.',
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function git(
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const result = await executeFile('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

async function requiredGit(
  cwd: string,
  args: readonly string[],
  code: string,
  message: string,
): Promise<string> {
  const value = await git(cwd, args);
  if (value === undefined) throw new ImportPreflightError(code, message);
  return value;
}

export async function collectImportGitState(
  root: string,
): Promise<ImportGitState> {
  if ((await git(root, ['rev-parse', '--is-inside-work-tree'])) !== 'true') {
    return { available: false, clean: false };
  }
  const status = await git(root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  const branch = await git(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  const remoteDefault = await git(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  const defaultBranch = remoteDefault?.replace(/^origin\//, '');
  const baseSha = remoteDefault
    ? await git(root, ['rev-parse', `${remoteDefault}^{commit}`])
    : undefined;
  return {
    available: true,
    clean: status === '',
    ...(branch ? { branch } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(baseSha ? { baseSha } : {}),
  };
}

function isRemoteSource(source: string): boolean {
  return (
    /^(?:https?|ssh|git|file):\/\//i.test(source) ||
    /^[^/\s]+@[^:]+:.+/.test(source)
  );
}

export function sanitizedImportSource(source: string): string {
  if (!/^(?:https?|ssh|git|file):\/\//i.test(source)) return source;
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new ImportOptionsError(
      'import-invalid-source-url',
      'source URL is invalid.',
    );
  }
  if (
    ['http:', 'https:'].includes(parsed.protocol) &&
    (parsed.username || parsed.password)
  ) {
    throw new ImportOptionsError(
      'import-embedded-credentials',
      'source URLs must not contain embedded credentials.',
    );
  }
  return parsed.toString();
}

async function resolveCommit(root: string, ref: string): Promise<string> {
  for (const candidate of [ref, `origin/${ref}`]) {
    const sha = await git(root, ['rev-parse', `${candidate}^{commit}`]);
    if (sha && /^[a-f0-9]{40}$/i.test(sha)) return sha;
  }
  throw new ImportPreflightError(
    'import-unresolved-source-ref',
    `Unable to resolve source ref ${ref} to a commit.`,
  );
}

async function readCommitFile(
  root: string,
  sha: string,
  path: string,
): Promise<string | undefined> {
  return git(root, ['show', `${sha}:${path}`]);
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseAliases(value: string | undefined): Record<string, string[]> {
  const parsed = parseJsonObject(value);
  const compilerOptions = parseJsonObject(
    JSON.stringify(parsed.compilerOptions ?? {}),
  );
  const paths = parseJsonObject(JSON.stringify(compilerOptions.paths ?? {}));
  return Object.fromEntries(
    Object.entries(paths).flatMap(([name, mapping]) =>
      Array.isArray(mapping) &&
      mapping.every((item) => typeof item === 'string')
        ? [[name, mapping as string[]]]
        : [],
    ),
  );
}

function environmentNames(contents: readonly string[]): string[] {
  return [
    ...new Set(
      contents.flatMap((content) =>
        content
          .split(/\r?\n/)
          .map(
            (line) =>
              line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1],
          )
          .filter((name): name is string => Boolean(name)),
      ),
    ),
  ].sort();
}

const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const codeFilePattern = /\.[cm]?[jt]sx?$/i;
const textConfigurationFilePattern =
  /(?:^|\/)(?:Dockerfile(?:\.[^/]*)?|[^/]+\.(?:env|jsonc?|ya?ml|toml|ini|conf|config|properties|sh|bash|zsh|ps1|cmd|bat))$/i;
const shellEnvironmentFilePattern =
  /(?:^|\/)(?:Dockerfile(?:\.[^/]*)?|[^/]+\.(?:env|jsonc?|ya?ml|toml|ini|conf|config|properties|sh|bash|zsh|ps1|cmd|bat))$/i;

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasBase(name: string): string {
  return name.endsWith('/*') ? name.slice(0, -2) : name;
}

function aliasHasWildcard(name: string): boolean {
  return name.endsWith('/*');
}

function aliasResolutionIsValid(source: string, resolution: string): boolean {
  if (
    !resolution ||
    source === resolution ||
    aliasHasWildcard(source) !== aliasHasWildcard(resolution) ||
    !/^[A-Za-z0-9@~#_$.-]+(?:\/[A-Za-z0-9@~#_$.*-]+)*$/.test(resolution)
  ) {
    return false;
  }
  const segments = resolution.split('/');
  return (
    segments.every((segment) => segment !== '.' && segment !== '..') &&
    segments.every((segment, index) =>
      segment.includes('*')
        ? index === segments.length - 1 && segment === '*'
        : true,
    )
  );
}

function aliasesOverlap(left: string, right: string): boolean {
  const leftBase = aliasBase(left);
  const rightBase = aliasBase(right);
  return (
    leftBase === rightBase ||
    (aliasHasWildcard(left) && rightBase.startsWith(`${leftBase}/`)) ||
    (aliasHasWildcard(right) && leftBase.startsWith(`${rightBase}/`))
  );
}

function supportsAliasRewrite(path: string): boolean {
  return (
    codeFilePattern.test(path) ||
    /(?:^|\/)tsconfig(?:\.base)?\.json$/i.test(path)
  );
}

function supportsEnvironmentRewrite(path: string): boolean {
  return (
    basename(path).startsWith('.env') ||
    codeFilePattern.test(path) ||
    textConfigurationFilePattern.test(path)
  );
}

function moduleSpecifiers(content: string): string[] {
  const source = ts.createSourceFile(
    'source.ts',
    content,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TSX,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const expression = node.expression;
      const supportedCall =
        expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(expression) && expression.text === 'require') ||
        (ts.isPropertyAccessExpression(expression) &&
          ((ts.isIdentifier(expression.expression) &&
            expression.expression.text === 'require' &&
            expression.name.text === 'resolve') ||
            (ts.isIdentifier(expression.expression) &&
              ['jest', 'vi'].includes(expression.expression.text) &&
              [
                'mock',
                'doMock',
                'unmock',
                'requireActual',
                'requireMock',
              ].includes(expression.name.text))));
      if (supportedCall) specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function importedPackageName(specifier: string): string | undefined {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#')
  ) {
    return undefined;
  }
  const segments = specifier.split('/');
  return specifier.startsWith('@')
    ? segments.length >= 2
      ? segments.slice(0, 2).join('/')
      : undefined
    : segments[0];
}

export function rewriteAliasCollisionContent(
  path: string,
  content: string,
  source: string,
  resolution: string,
): string {
  if (!supportsAliasRewrite(path)) return content;
  let rewritten = content;
  if (/(?:^|\/)tsconfig(?:\.base)?\.json$/i.test(path)) {
    const key = new RegExp(
      `("${escapeRegularExpression(source)}")(?=\\s*:)`,
      'g',
    );
    rewritten = rewritten.replace(key, JSON.stringify(resolution));
  }
  if (!codeFilePattern.test(path)) return rewritten;
  const sourceBase = aliasBase(source);
  const resolutionBase = aliasBase(resolution);
  return rewritten.replace(
    /((?:\bfrom\s*|\bimport\s*\(\s*|\brequire(?:\.resolve)?\s*\(\s*|\b(?:jest|vi)\.(?:mock|doMock|unmock|requireActual|requireMock)\s*\(\s*|\bimport\s*))(['"])([^'"]+)\2/g,
    (match, prefix: string, quote: string, specifier: string) => {
      if (
        specifier !== sourceBase &&
        !(aliasHasWildcard(source) && specifier.startsWith(`${sourceBase}/`))
      ) {
        return match;
      }
      return `${prefix}${quote}${resolutionBase}${specifier.slice(sourceBase.length)}${quote}`;
    },
  );
}

export function rewriteEnvironmentCollisionContent(
  path: string,
  content: string,
  source: string,
  resolution: string,
): string {
  if (!supportsEnvironmentRewrite(path)) return content;
  const escaped = escapeRegularExpression(source);
  let rewritten = content;
  if (basename(path).startsWith('.env')) {
    rewritten = rewritten.replace(
      new RegExp(`^(\\s*(?:export\\s+)?)${escaped}(\\s*=)`, 'gm'),
      `$1${resolution}$2`,
    );
  }
  rewritten = rewritten
    .replace(
      new RegExp(
        `((?:process|Bun)\\.env|import\\.meta\\.env)\\.${escaped}\\b`,
        'g',
      ),
      `$1.${resolution}`,
    )
    .replace(
      new RegExp(
        `((?:process|Bun)\\.env\\s*\\[\\s*['"])${escaped}(['"]\\s*\\])`,
        'g',
      ),
      `$1${resolution}$2`,
    )
    .replace(
      new RegExp(`(Deno\\.env\\.get\\(\\s*['"])${escaped}(['"]\\s*\\))`, 'g'),
      `$1${resolution}$2`,
    );
  rewritten = rewritten.replace(
    /(\{)([^{}]*)(\}\s*=\s*(?:(?:process|Bun)\.env|import\.meta\.env)\b)/g,
    (match, opening: string, fields: string, suffix: string) => {
      let updated = fields.replace(
        new RegExp(`(^|,)(\\s*)${escaped}(\\s*:)`, 'g'),
        `$1$2${resolution}$3`,
      );
      updated = updated.replace(
        new RegExp(`(^|,)(\\s*)${escaped}(\\s*)(?==|,|$)`, 'g'),
        `$1$2${resolution}: ${source}$3`,
      );
      return updated === fields ? match : `${opening}${updated}${suffix}`;
    },
  );
  if (
    shellEnvironmentFilePattern.test(path) ||
    basename(path).startsWith('.env')
  ) {
    rewritten = rewritten
      .replace(new RegExp(`\\$\\{${escaped}\\}`, 'g'), `\${${resolution}}`)
      .replace(new RegExp(`\\$env:${escaped}\\b`, 'gi'), `$env:${resolution}`)
      .replace(new RegExp(`\\$${escaped}\\b`, 'g'), `$${resolution}`)
      .replace(new RegExp(`%${escaped}%`, 'g'), `%${resolution}%`);
  }
  return rewritten;
}

type ImportedDocumentData = ReturnType<typeof repositoryDocumentSchema.parse>;

const DOCUMENT_STATUS: Readonly<
  Record<RepositoryDocumentType, readonly string[]>
> = {
  spec: ['draft', 'accepted', 'superseded', 'retired'],
  plan: ['backlog', 'in-progress', 'on-hold', 'completed', 'aborted'],
  decision: ['proposed', 'accepted', 'deferred', 'rejected'],
  audit: ['current'],
  research: ['active', 'complete'],
  report: ['generated'],
};

function importedDocumentIdIsValid(
  type: RepositoryDocumentType,
  id: string,
): boolean {
  const slug = '[a-z0-9]+(?:-[a-z0-9]+)*';
  const patterns: Record<RepositoryDocumentType, RegExp> = {
    spec: new RegExp(`^spec-${slug}-\\d{4}$`),
    plan: new RegExp(`^plan-${slug}-\\d{8}-${slug}$`),
    decision: new RegExp(`^decision-\\d{8}-${slug}$`),
    audit: new RegExp(`^audit-${slug}-\\d{8}$`),
    research: new RegExp(`^research-\\d{8}-${slug}$`),
    report: new RegExp(`^report-${slug}-\\d{8}T\\d{6}Z$`),
  };
  return patterns[type].test(id);
}

function importedDocumentIsPreservable(
  data: ImportedDocumentData,
  archived: boolean,
): boolean {
  if (
    !importedDocumentIdIsValid(data.type, data.id) ||
    !DOCUMENT_STATUS[data.type].includes(data.status) ||
    (data.visibility === 'public' && !data.visibility_reviewed_at) ||
    (data.visibility === 'internal' && data.visibility_reviewed_at)
  ) {
    return false;
  }
  switch (data.type) {
    case 'spec':
      return archived === ['superseded', 'retired'].includes(data.status);
    case 'plan': {
      const terminal = ['completed', 'aborted'].includes(data.status);
      return (
        archived === terminal &&
        (data.status !== 'in-progress' || Boolean(data.branch)) &&
        (!terminal || Boolean(data.completed_at)) &&
        (data.status !== 'aborted' || Boolean(data.aborted_because))
      );
    }
    case 'decision':
      return (
        !archived &&
        (data.status !== 'deferred' ||
          Boolean(data.revisit_when && data.migration_path))
      );
    case 'audit':
      return !archived && Boolean(data.standard);
    case 'research':
      return archived === (data.status === 'complete');
    case 'report':
      return !archived && Boolean(data.producer && data.generated_at);
  }
}

const INFRASTRUCTURE_PATH =
  /^(?:\.agents|\.github)(?:\/|$)|^(?:AGENTS\.md|CLAUDE\.md|content-collections\.ts|megamono\.json|nx\.json|project\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/;

function documentationRelativePath(source: string): string {
  return source.replace(/^docs\//, '');
}

function safeDocumentName(path: string): string {
  const extension = extname(path);
  const stem = basename(path, extension)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${stem || 'source-document'}.md`;
}

function documentationDestination(
  docsRoot: string,
  name: string,
  source: string,
  type?: RepositoryDocumentType,
  archived = false,
): string {
  const relativePath = documentationRelativePath(source);
  if (!type) {
    const directory = posix.dirname(relativePath);
    return posix.join(
      docsRoot,
      'specs',
      name,
      directory === '.' ? '' : directory,
      safeDocumentName(relativePath),
    );
  }
  const documentDirectory = getDocumentDirectory(type);
  const segments = relativePath.split('/');
  const directoryIndex = segments.indexOf(documentDirectory);
  const tail =
    directoryIndex >= 0
      ? segments.slice(directoryIndex + 1)
      : [safeDocumentName(relativePath)];
  if (tail.length === 0) tail.push(safeDocumentName(relativePath));
  const projectPrefix = ['spec', 'plan'].includes(type) ? [name] : [];
  return posix.join(
    docsRoot,
    ...(archived ? ['archives'] : []),
    documentDirectory,
    ...projectPrefix,
    ...tail,
  );
}

function documentationAssetDestination(
  docsRoot: string,
  name: string,
  source: string,
): string {
  const relativePath = documentationRelativePath(source);
  const segments = relativePath.split('/');
  const archived = segments[0] === 'archives';
  const offset = archived ? 1 : 0;
  const directory = segments[offset];
  const type = (
    [
      ['specs', 'spec'],
      ['plans', 'plan'],
      ['decisions', 'decision'],
      ['audits', 'audit'],
      ['research', 'research'],
      ['reports', 'report'],
    ] as const
  ).find(([candidate]) => candidate === directory)?.[1];
  if (!type) return posix.join(docsRoot, 'specs', name, relativePath);
  const tail = segments.slice(offset + 1);
  return posix.join(
    docsRoot,
    ...(archived ? ['archives'] : []),
    directory,
    ...(['spec', 'plan'].includes(type) ? [name] : []),
    ...tail,
  );
}

function legacyDecisionMetadata(
  source: string,
  content: string,
  fallbackDate: string,
): { readonly date: string; readonly status: string; readonly id: string } {
  const date =
    content.match(/^\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})\s*$/im)?.[1] ??
    fallbackDate;
  const statusValue =
    content.match(/^\*\*Status:\*\*\s*([a-z-]+)\s*$/im)?.[1] ?? 'accepted';
  const status = DOCUMENT_STATUS.decision.includes(statusValue)
    ? statusValue
    : 'accepted';
  const slug = safeDocumentName(source).replace(/\.md$/, '');
  return {
    date,
    status,
    id: `decision-${date.replaceAll('-', '')}-import-${slug}`,
  };
}

async function repositoryRoutes(
  workspaceRoot: string,
  snapshot: SourceSnapshot,
  name: string,
  config: MegamonoConfig,
): Promise<{
  readonly routes: readonly ImportRepositoryRoute[];
  readonly topicsToExtend: readonly string[];
  readonly issues: readonly ImportIssue[];
}> {
  const targetDocs = await validateRepositoryDocs(workspaceRoot, config);
  const issues: ImportIssue[] = targetDocs.diagnostics
    .filter(({ severity }) => severity === 'error')
    .map(({ code, path }) => ({
      code: 'import-host-docs',
      subject: path,
      message: `Target documentation must be valid before import (${code}).`,
    }));
  const targetIds = new Set(targetDocs.documents.map(({ data }) => data.id));
  const targetPaths = new Set(
    targetDocs.documents.map(({ relativePath }) =>
      posix.join(config.docs.root, relativePath),
    ),
  );
  const routes: ImportRepositoryRoute[] = [];
  const importedIds = new Set<string>();
  const importedReferences: Array<{
    readonly source: string;
    readonly references: readonly string[];
  }> = [];
  const topicsToExtend = new Set<string>();
  const topicVocabulary = getTopicVocabulary(config);
  let generatedSpec = 0;

  for (const source of snapshot.files) {
    if (source === 'docs/INDEX.md' || source === 'docs/archives/INDEX.md') {
      routes.push({
        source,
        destination: posix.join(
          '.megamono/imports',
          name,
          'source-infrastructure',
          source,
        ),
        action: 'archive',
        reason: 'infrastructure',
      });
      continue;
    }
    if (INFRASTRUCTURE_PATH.test(source)) {
      routes.push({
        source,
        destination: posix.join(
          '.megamono/imports',
          name,
          'source-infrastructure',
          source,
        ),
        action: 'archive',
        reason: 'infrastructure',
      });
      continue;
    }
    if (!source.startsWith('docs/')) continue;
    if (!source.endsWith('.md')) {
      routes.push({
        source,
        destination: documentationAssetDestination(
          config.docs.root,
          name,
          source,
        ),
        action: 'move-asset',
        reason: 'documentation-asset',
      });
      continue;
    }

    const content =
      (await readCommitFile(snapshot.root, snapshot.sha, source)) ?? '';
    const archived = source.startsWith('docs/archives/');
    let parsed: matter.GrayMatterFile<string> | undefined;
    try {
      parsed = matter(content);
    } catch {
      parsed = undefined;
    }
    const result = parsed
      ? repositoryDocumentSchema.safeParse(parsed.data)
      : undefined;
    const parsedDocument = result?.success ? result.data : undefined;
    const preserved = parsedDocument;
    if (
      parsedDocument &&
      !importedDocumentIsPreservable(parsedDocument, archived)
    ) {
      issues.push({
        code: 'import-doc-metadata',
        subject: source,
        message:
          'Imported repository-document metadata or lifecycle placement is invalid.',
      });
    }
    let document: NonNullable<ImportRepositoryRoute['document']>;
    let destination: string;
    if (preserved) {
      document = {
        mode: 'preserve',
        id: preserved.id,
        type: preserved.type,
        status: preserved.status,
        date: preserved.date,
      };
      destination = documentationDestination(
        config.docs.root,
        name,
        source,
        preserved.type,
        archived,
      );
      for (const topic of preserved.topics) {
        if (!topicVocabulary.has(topic)) topicsToExtend.add(topic);
      }
      importedReferences.push({
        source,
        references: [
          ...preserved.references,
          ...(preserved.supersedes ? [preserved.supersedes] : []),
        ],
      });
      if (preserved.architecture) {
        issues.push({
          code: 'import-doc-architecture',
          subject: source,
          message:
            'Imported architecture contracts require an explicit project-edge remapping.',
        });
      }
    } else if (/^docs\/(?:archives\/)?decisions\//.test(source)) {
      const legacy = legacyDecisionMetadata(
        source,
        parsed?.content ?? content,
        snapshot.commitDate,
      );
      document = { mode: 'wrap', type: 'decision', ...legacy };
      destination = posix.join(
        config.docs.root,
        'decisions',
        safeDocumentName(source),
      );
    } else {
      generatedSpec += 1;
      document = {
        mode: 'wrap',
        id: `spec-${name}-${String(generatedSpec).padStart(4, '0')}`,
        type: 'spec',
        status: 'accepted',
        date: snapshot.commitDate,
      };
      destination = documentationDestination(config.docs.root, name, source);
    }
    routes.push({
      source,
      destination,
      action: 'migrate-document',
      reason: 'documentation',
      document,
    });
    if (targetIds.has(document.id) || importedIds.has(document.id)) {
      issues.push({
        code: 'import-doc-id-collision',
        subject: document.id,
        message: 'Imported documentation ID is already owned.',
      });
    }
    importedIds.add(document.id);
  }

  const routeDestinations = new Set<string>();
  for (const route of routes) {
    if (
      targetPaths.has(route.destination) ||
      routeDestinations.has(route.destination) ||
      (await exists(join(workspaceRoot, route.destination)))
    ) {
      issues.push({
        code: 'import-route-destination-collision',
        subject: route.destination,
        message: 'An import route destination is already owned.',
      });
    }
    routeDestinations.add(route.destination);
  }
  const availableIds = new Set([...targetIds, ...importedIds]);
  for (const { source, references } of importedReferences) {
    for (const reference of references) {
      if (!availableIds.has(reference)) {
        issues.push({
          code: 'import-doc-reference',
          subject: `${source}:${reference}`,
          message: 'Imported documentation contains an unresolved reference.',
        });
      }
    }
  }

  return {
    routes: routes.sort((left, right) =>
      left.source.localeCompare(right.source),
    ),
    topicsToExtend: [...topicsToExtend].sort(),
    issues: issues.sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        (left.subject ?? '').localeCompare(right.subject ?? ''),
    ),
  };
}

async function inspectSnapshot(
  root: string,
  kind: 'local' | 'remote',
  display: string,
  ref: string,
  gitState: ImportGitState,
  dispose: () => Promise<void>,
): Promise<SourceSnapshot> {
  const sha = await resolveCommit(root, ref);
  const commitDate = await requiredGit(
    root,
    ['show', '-s', '--format=%cs', sha],
    'import-source-commit-date',
    'Unable to read the source commit date.',
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(commitDate)) {
    throw new ImportPreflightError(
      'import-source-commit-date',
      'The source commit does not expose a valid commit date.',
    );
  }
  const files = (
    await requiredGit(
      root,
      ['ls-tree', '-r', '--name-only', sha],
      'import-source-tree',
      'Unable to inspect the source commit tree.',
    )
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const manifestSource = await readCommitFile(root, sha, 'package.json');
  if (!manifestSource) {
    throw new ImportPreflightError(
      'import-source-package-json',
      'The source commit must contain a root package.json.',
    );
  }
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(manifestSource) as PackageManifest;
  } catch {
    throw new ImportPreflightError(
      'import-source-package-json',
      'The source package.json is not valid JSON.',
    );
  }
  const aliasFiles = ['tsconfig.base.json', 'tsconfig.json'].filter((path) =>
    files.includes(path),
  );
  const aliasConfigs = await Promise.all(
    aliasFiles.map((path) => readCommitFile(root, sha, path)),
  );
  const envFiles = files.filter((path) => basename(path).startsWith('.env'));
  const envContents = await Promise.all(
    envFiles.map(async (path) => (await readCommitFile(root, sha, path)) ?? ''),
  );
  return {
    root,
    kind,
    display,
    sha,
    commitDate,
    ref,
    git: gitState,
    files,
    manifest,
    aliases: Object.assign({}, ...aliasConfigs.map(parseAliases)),
    environmentNames: environmentNames(envContents),
    dispose,
  };
}

async function openSourceSnapshot(
  workspaceRoot: string,
  source: string,
  ref: string,
): Promise<SourceSnapshot> {
  const display = sanitizedImportSource(source);
  if (!isRemoteSource(source)) {
    const candidate = resolve(workspaceRoot, source);
    if (!(await exists(candidate)) || !(await stat(candidate)).isDirectory()) {
      throw new ImportPreflightError(
        'import-source-missing',
        'The local source repository does not exist.',
      );
    }
    const root = await requiredGit(
      candidate,
      ['rev-parse', '--show-toplevel'],
      'import-source-git',
      'The local source must be a Git repository.',
    );
    const gitState = await collectImportGitState(root);
    return inspectSnapshot(root, 'local', root, ref, gitState, noOpDispose);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'megamono-import-'));
  const cloneRoot = join(temporaryRoot, 'source');
  try {
    const cloned = await git(temporaryRoot, [
      'clone',
      '--no-checkout',
      '--quiet',
      source,
      cloneRoot,
    ]);
    if (cloned === undefined) {
      throw new ImportPreflightError(
        'import-source-clone',
        'Unable to clone the remote source repository.',
      );
    }
    return await inspectSnapshot(
      cloneRoot,
      'remote',
      display,
      ref,
      { available: true, clean: true },
      () => rm(temporaryRoot, { recursive: true, force: true }),
    );
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function manifestDependencies(
  manifest: PackageManifest,
): Record<string, string> {
  return {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };
}

async function readTargetEnvironmentNames(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const contents = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('.env'))
      .map((entry) => readFile(join(root, entry.name), 'utf8')),
  );
  return environmentNames(contents);
}

async function affectedCollisionFiles(
  snapshot: SourceSnapshot,
  routedSources: ReadonlySet<string>,
  rewrite: (path: string, content: string) => string,
): Promise<string[]> {
  const affected: string[] = [];
  for (const path of snapshot.files) {
    if (
      routedSources.has(path) ||
      (!supportsAliasRewrite(path) && !supportsEnvironmentRewrite(path))
    ) {
      continue;
    }
    const content = await readCommitFile(snapshot.root, snapshot.sha, path);
    if (content !== undefined && rewrite(path, content) !== content) {
      affected.push(path);
    }
  }
  return affected.sort();
}

async function sourceModuleReferences(
  snapshot: SourceSnapshot,
): Promise<
  readonly { readonly sourceFile: string; readonly specifier: string }[]
> {
  const references: Array<{ sourceFile: string; specifier: string }> = [];
  for (const sourceFile of snapshot.files.filter((path) =>
    codeFilePattern.test(path),
  )) {
    const content = await readCommitFile(
      snapshot.root,
      snapshot.sha,
      sourceFile,
    );
    if (content === undefined) continue;
    for (const specifier of moduleSpecifiers(content)) {
      references.push({ sourceFile, specifier });
    }
  }
  return references.sort(
    (left, right) =>
      left.sourceFile.localeCompare(right.sourceFile) ||
      left.specifier.localeCompare(right.specifier),
  );
}

function resolveSourceModule(
  files: ReadonlySet<string>,
  sourceFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  const base = posix.normalize(
    posix.join(posix.dirname(sourceFile), cleanSpecifier),
  );
  const candidates = [
    base,
    ...[
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.json',
    ].map((extension) => `${base}${extension}`),
    ...[
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.json',
    ].map((extension) => posix.join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => files.has(candidate));
}

function issueLines(issues: readonly ImportIssue[]): string[] {
  return issues.length === 0
    ? ['- None']
    : issues.map(
        ({ code, message, subject }) =>
          `- \`${code}\`${subject ? ` (${subject})` : ''}: ${message}`,
      );
}

export async function analyzeRepositoryImport(
  input: RepositoryImportAnalysisInput,
): Promise<RepositoryImportAnalysis> {
  validateOptions(input.options);
  const { workspaceRoot, options } = input;
  const destination = normalizedImportDestination(
    options.name,
    options.destination,
  );
  const sourceRef = options.ref?.trim() || 'HEAD';
  const targetGit = await collectImportGitState(workspaceRoot);
  const snapshot = await openSourceSnapshot(
    workspaceRoot,
    options.source,
    sourceRef,
  );
  try {
    const blockers: ImportIssue[] = [];
    let hostConfig: MegamonoConfig | undefined;
    if (!(await exists(join(workspaceRoot, 'megamono.json')))) {
      blockers.push({
        code: 'import-host-not-megamono',
        message: 'The target repository is not an initialized Megamono host.',
      });
    } else {
      try {
        hostConfig = await readMegamonoConfig(workspaceRoot);
      } catch {
        blockers.push({
          code: 'import-host-config',
          message: 'The target megamono.json must be valid before import.',
        });
      }
    }
    if (!targetGit.available) {
      blockers.push({
        code: 'import-target-git',
        message: 'The target must be a Git repository.',
      });
    } else {
      if (!targetGit.clean) {
        blockers.push({
          code: 'import-target-dirty-tree',
          message: 'The target working tree must be clean.',
        });
      }
      if (!targetGit.defaultBranch || !targetGit.baseSha) {
        blockers.push({
          code: 'import-target-default-branch',
          message: 'The target must expose origin/HEAD as its rollback base.',
        });
      } else if (targetGit.branch === targetGit.defaultBranch) {
        blockers.push({
          code: 'import-target-default-branch',
          message: 'Import must run from a non-default target branch.',
        });
      }
    }
    if (snapshot.kind === 'local' && !snapshot.git.clean) {
      blockers.push({
        code: 'import-source-dirty-tree',
        message: 'The local source working tree must be clean.',
      });
    }
    if (
      snapshot.manifest.workspaces ||
      snapshot.files.includes('pnpm-workspace.yaml')
    ) {
      blockers.push({
        code: 'import-unsupported-source-shape',
        message: 'V1 imports one root package, not a source monorepo.',
      });
    }
    const sourcePackageManager =
      snapshot.manifest.packageManager?.split('@')[0];
    if (
      sourcePackageManager &&
      sourcePackageManager !== 'pnpm' &&
      sourcePackageManager !== 'npm'
    ) {
      blockers.push({
        code: 'import-unsupported-package-manager',
        message: 'V1 imports pnpm and npm sources only.',
      });
    }
    if (
      options.expectedSourceSha &&
      options.expectedSourceSha.toLowerCase() !== snapshot.sha.toLowerCase()
    ) {
      blockers.push({
        code: 'import-source-sha-changed',
        message: 'The resolved source SHA does not match expectedSourceSha.',
      });
    }
    if (options.history === 'squash' && !options.allowHistoryLoss) {
      blockers.push({
        code: 'import-history-loss-not-accepted',
        message: 'Squash history requires allowHistoryLoss=true.',
      });
    }

    const routing = hostConfig
      ? await repositoryRoutes(
          workspaceRoot,
          snapshot,
          options.name,
          hostConfig,
        )
      : { routes: [], topicsToExtend: [], issues: [] };
    blockers.push(...routing.issues);
    const moduleReferences = await sourceModuleReferences(snapshot);
    const sourceFileSet = new Set(snapshot.files);
    const routesBySource = new Map(
      routing.routes.map((route) => [route.source, route] as const),
    );
    const routedModuleReferences: ImportRoutedModuleReference[] =
      moduleReferences.flatMap(({ sourceFile, specifier }) => {
        const targetSource = resolveSourceModule(
          sourceFileSet,
          sourceFile,
          specifier,
        );
        if (!targetSource) return [];
        const route = routesBySource.get(targetSource);
        return route
          ? [
              {
                sourceFile,
                specifier,
                targetSource,
                targetDestination: route.destination,
                reason: route.reason,
              },
            ]
          : [];
      });
    for (const reference of routedModuleReferences) {
      blockers.push({
        code: 'import-routed-module-reference',
        subject: `${reference.sourceFile}:${reference.specifier}`,
        message:
          reference.reason === 'infrastructure'
            ? 'Application code imports repository infrastructure that must remain inactive after import.'
            : 'Application code imports documentation that moves outside the imported project.',
      });
    }

    const targetManifest = JSON.parse(
      await readFile(join(workspaceRoot, 'package.json'), 'utf8'),
    ) as PackageManifest;
    const sourceDependencies = manifestDependencies(snapshot.manifest);
    const targetDependencies = manifestDependencies(targetManifest);
    const importedPackages = new Set(
      moduleReferences.flatMap(({ specifier }) => {
        const packageName = importedPackageName(specifier);
        return packageName ? [packageName] : [];
      }),
    );
    const targetProjects =
      input.targetProjects ??
      (input.projectNames ?? []).map((name) => ({ name, packageName: name }));
    const projectOwners = new Map<string, string[]>();
    for (const project of targetProjects) {
      const packageName = project.packageName ?? project.name;
      if (!projectOwners.has(packageName)) projectOwners.set(packageName, []);
      projectOwners.get(packageName)?.push(project.name);
    }
    const expectedGraphDependencies: ImportExpectedGraphDependency[] = [];
    for (const packageName of Object.keys(sourceDependencies).sort()) {
      if (!importedPackages.has(packageName)) continue;
      const owners = projectOwners.get(packageName) ?? [];
      if (owners.length > 1) {
        blockers.push({
          code: 'import-ambiguous-package-owner',
          subject: packageName,
          message: 'Multiple target Nx projects claim the imported package.',
        });
      } else if (owners[0] && owners[0] !== options.name) {
        expectedGraphDependencies.push({ project: owners[0], packageName });
      }
    }
    const dependencyConflicts = Object.keys(sourceDependencies)
      .filter(
        (name) =>
          targetDependencies[name] &&
          targetDependencies[name] !== sourceDependencies[name],
      )
      .sort()
      .map((name) => ({
        name,
        source: sourceDependencies[name],
        target: targetDependencies[name],
        ...(options.resolutions?.dependencies?.[name]
          ? { resolution: options.resolutions.dependencies[name] }
          : {}),
      }));

    const collisions: ImportCollision[] = [];
    if ((input.projectNames ?? []).includes(options.name)) {
      collisions.push({ kind: 'project-name', name: options.name });
    }
    if (await exists(join(workspaceRoot, destination))) {
      collisions.push({ kind: 'destination', name: destination });
    }
    const routedSources = new Set(routing.routes.map(({ source }) => source));
    const targetAliasFiles = ['tsconfig.base.json', 'tsconfig.json'];
    const targetAliases = Object.assign(
      {},
      ...(await Promise.all(
        targetAliasFiles.map(async (path) =>
          (await exists(join(workspaceRoot, path)))
            ? parseAliases(await readFile(join(workspaceRoot, path), 'utf8'))
            : {},
        ),
      )),
    ) as Record<string, string[]>;
    const aliasCollisions = Object.keys(snapshot.aliases)
      .filter((alias) =>
        Object.keys(targetAliases).some((targetAlias) =>
          aliasesOverlap(alias, targetAlias),
        ),
      )
      .sort();
    for (const name of Object.keys(options.resolutions?.aliases ?? {}).sort()) {
      if (!aliasCollisions.includes(name)) {
        blockers.push({
          code: 'import-unused-alias-resolution',
          subject: name,
          message:
            'Alias resolution does not correspond to a detected collision.',
        });
      }
    }
    const aliasDestinations: string[] = [];
    for (const name of aliasCollisions) {
      const resolution = options.resolutions?.aliases?.[name];
      if (resolution && !aliasResolutionIsValid(name, resolution)) {
        blockers.push({
          code: 'import-invalid-alias-resolution',
          subject: name,
          message:
            'Alias resolution must be a distinct safe alias with the same wildcard shape.',
        });
      } else if (
        resolution &&
        [
          ...Object.keys(targetAliases),
          ...Object.keys(snapshot.aliases).filter((alias) => alias !== name),
          ...aliasDestinations,
        ].some((alias) => aliasesOverlap(resolution, alias))
      ) {
        blockers.push({
          code: 'import-alias-resolution-collision',
          subject: name,
          message:
            'Alias resolution overlaps an alias already owned by the source or target.',
        });
      }
      if (resolution) aliasDestinations.push(resolution);
      const plannedResolution =
        resolution ??
        `__megamono_alias_resolution__${aliasHasWildcard(name) ? '/*' : ''}`;
      collisions.push({
        kind: 'alias',
        name,
        source: JSON.stringify(snapshot.aliases[name]),
        target: JSON.stringify(
          Object.fromEntries(
            Object.entries(targetAliases).filter(([targetAlias]) =>
              aliasesOverlap(name, targetAlias),
            ),
          ),
        ),
        ...(resolution ? { resolution } : {}),
        affectedFiles: await affectedCollisionFiles(
          snapshot,
          routedSources,
          (path, content) =>
            rewriteAliasCollisionContent(
              path,
              content,
              name,
              plannedResolution,
            ),
        ),
      });
    }
    const targetEnvironment = await readTargetEnvironmentNames(workspaceRoot);
    const targetEnvironmentSet = new Set(targetEnvironment);
    const environmentCollisions = snapshot.environmentNames.filter((item) =>
      targetEnvironmentSet.has(item),
    );
    for (const name of Object.keys(
      options.resolutions?.environment ?? {},
    ).sort()) {
      if (!environmentCollisions.includes(name)) {
        blockers.push({
          code: 'import-unused-environment-resolution',
          subject: name,
          message:
            'Environment resolution does not correspond to a detected collision.',
        });
      }
    }
    const environmentDestinations: string[] = [];
    for (const name of environmentCollisions) {
      const resolution = options.resolutions?.environment?.[name];
      if (
        resolution &&
        (!environmentNamePattern.test(resolution) || resolution === name)
      ) {
        blockers.push({
          code: 'import-invalid-environment-resolution',
          subject: name,
          message:
            'Environment resolution must be a distinct POSIX-compatible variable name.',
        });
      } else if (
        resolution &&
        [
          ...targetEnvironment,
          ...snapshot.environmentNames.filter((item) => item !== name),
          ...environmentDestinations,
        ].includes(resolution)
      ) {
        blockers.push({
          code: 'import-environment-resolution-collision',
          subject: name,
          message:
            'Environment resolution is already owned by the source or target.',
        });
      }
      if (resolution) environmentDestinations.push(resolution);
      collisions.push({
        kind: 'environment',
        name,
        ...(resolution ? { resolution } : {}),
        affectedFiles: await affectedCollisionFiles(
          snapshot,
          routedSources,
          (path, content) =>
            rewriteEnvironmentCollisionContent(
              path,
              content,
              name,
              resolution ?? '__MEGAMONO_ENVIRONMENT_RESOLUTION__',
            ),
        ),
      });
    }

    const unresolved: ImportIssue[] = [
      ...dependencyConflicts
        .filter(({ resolution }) => !resolution)
        .map(({ name }) => ({
          code: 'import-dependency-resolution',
          subject: name,
          message: 'Conflicting dependency versions require a resolution.',
        })),
      ...collisions
        .filter(
          ({ kind, resolution }) =>
            ['alias', 'environment'].includes(kind) && !resolution,
        )
        .map(({ kind, name }) => ({
          code: `import-${kind}-resolution`,
          subject: name,
          message: `${kind} collision requires an explicit resolution.`,
        })),
      ...collisions
        .filter(({ kind }) => ['project-name', 'destination'].includes(kind))
        .map(({ kind, name }) => ({
          code: `import-${kind}-collision`,
          subject: name,
          message: `${kind} is already owned by the target repository.`,
        })),
    ].sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        (left.subject ?? '').localeCompare(right.subject ?? ''),
    );

    const packageManager =
      hostConfig?.conventions.packageManager === 'npm' ? 'npm' : 'pnpm';
    const commands = Object.fromEntries(
      (['build', 'test', 'lint', 'deploy'] as const).flatMap((name) =>
        snapshot.manifest.scripts?.[name]
          ? [[name, `${packageManager} run ${name}`]]
          : [],
      ),
    );
    const hostDependencies = new Set(Object.keys(targetDependencies));
    const nonJsSurfaces: Array<
      RepositoryImportAnalysis['nonJsSurfaces'][number]
    > = [];
    for (const manifest of snapshot.files) {
      if (basename(manifest) === 'Package.swift') {
        nonJsSurfaces.push({
          ecosystem: 'apple',
          manifest,
          ...(hostDependencies.has('@megamono/nx-apple')
            ? { plugin: '@megamono/nx-apple' }
            : {}),
        });
      } else if (basename(manifest) === 'Cargo.toml') {
        nonJsSurfaces.push({
          ecosystem: 'cargo',
          manifest,
          ...(hostDependencies.has('@megamono/nx-cargo')
            ? { plugin: '@megamono/nx-cargo' }
            : {}),
        });
      } else if (basename(manifest) === 'composer.json') {
        nonJsSurfaces.push({ ecosystem: 'php', manifest });
      }
    }
    nonJsSurfaces.sort((left, right) =>
      left.manifest.localeCompare(right.manifest),
    );
    for (const surface of nonJsSurfaces) {
      if (!surface.plugin) {
        blockers.push({
          code: 'import-missing-inference-plugin',
          subject: surface.manifest,
          message: `No installed inference plugin covers the ${surface.ecosystem} source surface.`,
        });
      }
    }

    const sortedBlockers = blockers.sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        (left.subject ?? '').localeCompare(right.subject ?? ''),
    );
    return {
      schemaVersion: 1,
      source: snapshot.display,
      sourceKind: snapshot.kind,
      sourceSha: snapshot.sha,
      sourceRef,
      name: options.name,
      destination,
      ...(options.history ? { history: options.history } : {}),
      verify: options.verify ?? 'config',
      packageManager,
      targetGit,
      sourceGit: snapshot.git,
      ...(snapshot.manifest.name
        ? { sourcePackageName: snapshot.manifest.name }
        : {}),
      sourceFiles: snapshot.files,
      repositoryRoutes: routing.routes,
      routedModuleReferences,
      expectedGraphDependencies,
      documentationTopicsToExtend: routing.topicsToExtend,
      commands,
      nonJsSurfaces,
      dependencyConflicts,
      collisions,
      blockers: sortedBlockers,
      unresolved,
      ready: sortedBlockers.length === 0 && unresolved.length === 0,
    };
  } finally {
    await snapshot.dispose();
  }
}

export function renderRepositoryImportReport(
  analysis: RepositoryImportAnalysis,
): string {
  const commandLines = Object.entries(analysis.commands).map(
    ([target, command]) => `- \`${target}\`: \`${command}\``,
  );
  const dependencyLines = analysis.dependencyConflicts.map(
    ({ name, source, target, resolution }) =>
      `- \`${name}\`: source \`${source}\`, target \`${target}\`${
        resolution ? `, resolution \`${resolution}\`` : ''
      }`,
  );
  const collisionLines = analysis.collisions.map(
    ({ kind, name, resolution, affectedFiles }) =>
      `- \`${kind}\` \`${name}\`${resolution ? ` → \`${resolution}\`` : ''}${
        affectedFiles && affectedFiles.length > 0
          ? ` in ${affectedFiles.map((path) => `\`${path}\``).join(', ')}`
          : ''
      }`,
  );
  const routeLines = analysis.repositoryRoutes.map(
    ({ source, destination, action, document }) =>
      `- \`${action}\`: \`${source}\` → \`${destination}\`${
        document ? ` (\`${document.type}\` \`${document.id}\`)` : ''
      }`,
  );
  const routedReferenceLines = analysis.routedModuleReferences.map(
    ({ sourceFile, specifier, targetSource, targetDestination }) =>
      `- \`${sourceFile}\` imports \`${specifier}\` (\`${targetSource}\` routes to \`${targetDestination}\`)`,
  );
  const graphDependencyLines = analysis.expectedGraphDependencies.map(
    ({ project, packageName }) =>
      `- \`${analysis.name}\` → \`${project}\` via \`${packageName}\``,
  );
  return `${[
    '# Megamono repository import analysis',
    '',
    `- Source: \`${analysis.source}\``,
    `- Source kind: \`${analysis.sourceKind}\``,
    `- Source ref: \`${analysis.sourceRef}\``,
    `- Resolved source SHA: \`${analysis.sourceSha}\``,
    `- Project: \`${analysis.name}\``,
    `- Destination: \`${analysis.destination}\``,
    `- History: \`${analysis.history ?? 'not selected'}\``,
    `- Verification: \`${analysis.verify}\``,
    `- Ready: \`${analysis.ready}\``,
    '',
    '## Existing commands',
    '',
    ...(commandLines.length > 0 ? commandLines : ['- None detected']),
    '',
    '## Dependency conflicts',
    '',
    ...(dependencyLines.length > 0 ? dependencyLines : ['- None']),
    '',
    '## Collisions',
    '',
    ...(collisionLines.length > 0 ? collisionLines : ['- None']),
    '',
    '## Repository routes',
    '',
    ...(routeLines.length > 0 ? routeLines : ['- None required']),
    '',
    '## Routed module references',
    '',
    ...(routedReferenceLines.length > 0
      ? routedReferenceLines
      : ['- None detected']),
    '',
    '## Expected Nx graph dependencies',
    '',
    ...(graphDependencyLines.length > 0
      ? graphDependencyLines
      : ['- None detected']),
    '',
    '## Documentation topics added to the host vocabulary',
    '',
    ...(analysis.documentationTopicsToExtend.length > 0
      ? analysis.documentationTopicsToExtend.map((topic) => `- \`${topic}\``)
      : ['- None']),
    '',
    '## Non-JS surfaces',
    '',
    ...(analysis.nonJsSurfaces.length > 0
      ? analysis.nonJsSurfaces.map(
          ({ ecosystem, manifest, plugin }) =>
            `- \`${ecosystem}\`: ${manifest}${
              plugin ? ` via \`${plugin}\`` : ' — no installed plugin'
            }`,
        )
      : ['- None detected']),
    '',
    '## Preflight blockers',
    '',
    ...issueLines(analysis.blockers),
    '',
    '## Unresolved decisions',
    '',
    ...issueLines(analysis.unresolved),
    '',
  ].join('\n')}\n`;
}
