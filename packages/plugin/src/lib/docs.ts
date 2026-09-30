import { execFile } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import matter = require('gray-matter');
import { format } from 'prettier';
import { z } from 'zod';
import {
  getTopicVocabulary,
  isSafeWorkspaceRelativePath,
  type MegamonoConfig,
} from './config';
import type { Diagnostic } from './diagnostics';
import { refreshDerivedArtifactHashes } from './managed-artifacts';

const DOCUMENT_DIRECTORIES = new Set([
  'specs',
  'plans',
  'decisions',
  'audits',
  'research',
  'reports',
]);
const EXCLUDED_NAMES = new Set(['README.md', 'OVERVIEW.md', 'INDEX.md']);
const externalReferencePattern = /^[a-z][a-z0-9-]*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const slugPattern = '[a-z0-9]+(?:-[a-z0-9]+)*';
const projectPattern = `(?:${slugPattern}|@${slugPattern}/${slugPattern})`;
const execFileAsync = promisify(execFile);
const IGNORED_PACKAGE_DIRECTORIES = new Set([
  '.content-collections',
  '.git',
  '.nx',
  'dist',
  'node_modules',
]);

const dateSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value),
  z.iso.date(),
);
const dateTimeSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.iso.datetime({ offset: true }),
);

export const architectureDependencySchema = z
  .object({
    from: z.string().regex(new RegExp(`^${projectPattern}$`)),
    to: z.string().regex(new RegExp(`^${projectPattern}$`)),
  })
  .strict();

export const repositoryArchitectureSchema = z
  .object({
    allowed_dependencies: z.array(architectureDependencySchema),
    forbidden_dependencies: z.array(architectureDependencySchema),
  })
  .strict()
  .refine(
    ({ allowed_dependencies, forbidden_dependencies }) =>
      allowed_dependencies.length + forbidden_dependencies.length > 0,
    { message: 'Architecture must declare at least one dependency edge.' },
  );

export const repositoryDocumentSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['spec', 'plan', 'decision', 'audit', 'research', 'report']),
    status: z.string().min(1),
    visibility: z.enum(['internal', 'public']),
    visibility_reviewed_at: dateTimeSchema.optional(),
    projects: z
      .array(z.string().regex(new RegExp(`^${projectPattern}$`)))
      .min(1),
    topics: z.array(z.string().regex(new RegExp(`^${slugPattern}$`))),
    summary: z.string().min(1),
    date: dateSchema,
    supersedes: z.string().nullable(),
    references: z.array(z.string()),
    external_references: z.array(z.string().regex(externalReferencePattern)),
    branch: z.string().min(1).optional(),
    architecture: repositoryArchitectureSchema.optional(),
    completed_at: dateTimeSchema.optional(),
    aborted_because: z.string().min(1).optional(),
    revisit_when: z.string().min(1).optional(),
    migration_path: z.string().min(1).optional(),
    standard: z.string().min(1).optional(),
    producer: z.string().min(1).optional(),
    generated_at: dateTimeSchema.optional(),
    retention_days: z.number().int().positive().optional(),
  })
  .strict();

export const repositoryContentCollectionSchema =
  repositoryDocumentSchema.extend({ content: z.string() });

export type RepositoryDocumentType = z.infer<
  typeof repositoryDocumentSchema
>['type'];
export type ArchitectureDependency = z.infer<
  typeof architectureDependencySchema
>;
export type RepositoryArchitecture = z.infer<
  typeof repositoryArchitectureSchema
>;

export interface RepositoryDocument {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly archived: boolean;
  readonly content: string;
  readonly source?: string;
  readonly data: z.infer<typeof repositoryDocumentSchema>;
}

interface ContentPackageManifest {
  readonly megamono?: {
    readonly contentCollection?: {
      readonly version?: unknown;
    };
  };
}

export interface DocsValidationResult {
  readonly documents: readonly RepositoryDocument[];
  readonly diagnostics: readonly Diagnostic[];
}

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function expectedIdPattern(type: RepositoryDocumentType): RegExp {
  switch (type) {
    case 'spec':
      return new RegExp(`^spec-${slugPattern}-\\d{4}$`);
    case 'plan':
      return new RegExp(`^plan-${slugPattern}-\\d{8}-${slugPattern}$`);
    case 'decision':
      return new RegExp(`^decision-\\d{8}-${slugPattern}$`);
    case 'audit':
      return new RegExp(`^audit-${slugPattern}-\\d{8}$`);
    case 'research':
      return new RegExp(`^research-\\d{8}-${slugPattern}$`);
    case 'report':
      return new RegExp(`^report-${slugPattern}-\\d{8}T\\d{6}Z$`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function walkMarkdown(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await walkMarkdown(path)));
    if (
      entry.isFile() &&
      entry.name.endsWith('.md') &&
      !EXCLUDED_NAMES.has(entry.name)
    ) {
      paths.push(path);
    }
  }
  return paths;
}

async function walkContentCollectionRoots(
  directory: string,
): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const roots: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.isDirectory()) {
      if (!IGNORED_PACKAGE_DIRECTORIES.has(entry.name)) {
        roots.push(
          ...(await walkContentCollectionRoots(join(directory, entry.name))),
        );
      }
      continue;
    }
    if (!entry.isFile() || entry.name !== 'package.json') continue;
    try {
      const manifest = JSON.parse(
        await readFile(join(directory, entry.name), 'utf8'),
      ) as ContentPackageManifest;
      if (manifest.megamono?.contentCollection) roots.push(directory);
    } catch {
      // Invalid manifests are owned by package-manager and workspace checks.
    }
  }
  return roots;
}

async function validateCorpusDirection(
  workspaceRoot: string,
  docsRoot: string,
  documents: readonly RepositoryDocument[],
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const roots = await walkContentCollectionRoots(workspaceRoot);
  const ids = documents.map((document) => document.data.id);
  const normalizedDocsRoot = normalizePath(docsRoot).replace(/\/$/, '');
  const corpusPathPattern = new RegExp(
    `(?:^|[\\s("'\x60])${normalizedDocsRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:archives/)?(?:specs|plans|decisions|audits|research|reports)/`,
    'm',
  );

  for (const root of roots) {
    for (const absolutePath of await walkMarkdown(join(root, 'content'))) {
      const source = await readFile(absolutePath, 'utf8');
      const referencedIds = ids.filter((id) => source.includes(id));
      if (referencedIds.length === 0 && !corpusPathPattern.test(source))
        continue;
      const details = [
        ...(referencedIds.length > 0
          ? [`repository document IDs (${referencedIds.join(', ')})`]
          : []),
        ...(corpusPathPattern.test(source)
          ? ['repository document paths']
          : []),
      ];
      diagnostics.push({
        severity: 'warning',
        code: 'docs-corpus-direction',
        message: `Content-level documents must not depend on ${details.join(' or ')}. Move shared facts into content-level sources or use an external reference.`,
        path: normalizePath(relative(workspaceRoot, absolutePath)),
      });
    }
  }
  return diagnostics;
}

function sourceWithoutVisibilityReview(source: string): string {
  return source.replace(/^visibility_reviewed_at:\s*[^\r\n]*(?:\r?\n|$)/m, '');
}

function frontMatterDateTime(value: unknown): number | undefined {
  const date = value instanceof Date ? value : new Date(String(value));
  const timestamp = date.getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

export function validatePublicVisibilityReviews(
  documents: readonly RepositoryDocument[],
  previousSources: ReadonlyMap<string, string>,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const document of documents) {
    if (document.data.visibility !== 'public' || !document.source) continue;
    const previousSource = previousSources.get(document.relativePath);
    if (!previousSource || !matter.test(previousSource)) continue;
    let previous: matter.GrayMatterFile<string>;
    try {
      previous = matter(previousSource);
    } catch {
      continue;
    }
    if (previous.data.visibility !== 'public') continue;
    if (
      sourceWithoutVisibilityReview(previousSource) ===
      sourceWithoutVisibilityReview(document.source)
    ) {
      continue;
    }
    const previousReview = frontMatterDateTime(
      previous.data.visibility_reviewed_at,
    );
    const currentReview = frontMatterDateTime(
      document.data.visibility_reviewed_at,
    );
    if (
      currentReview !== undefined &&
      (previousReview === undefined || currentReview > previousReview)
    ) {
      continue;
    }
    diagnostics.push({
      severity: 'error',
      code: 'docs-public-review-stale',
      message:
        'Changed public content must advance visibility_reviewed_at beyond the base revision.',
      path: document.relativePath,
    });
  }
  return diagnostics;
}

export async function collectPreviousDocumentSources(
  workspaceRoot: string,
  documents: readonly RepositoryDocument[],
  baseRef: string,
): Promise<ReadonlyMap<string, string>> {
  await execFileAsync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], {
    cwd: workspaceRoot,
  });
  const entries = await Promise.all(
    documents.map(
      async (document): Promise<readonly [string, string] | undefined> => {
        const workspacePath = normalizePath(
          relative(workspaceRoot, document.absolutePath),
        );
        try {
          const { stdout } = await execFileAsync(
            'git',
            ['show', `${baseRef}:${workspacePath}`],
            { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 },
          );
          return [document.relativePath, stdout] as const;
        } catch {
          return undefined;
        }
      },
    ),
  );
  return new Map(entries.filter((entry) => entry !== undefined));
}

function validateTypeSpecificFields(
  document: RepositoryDocument,
  diagnostics: Diagnostic[],
): void {
  const { data, relativePath, archived } = document;
  const error = (code: string, message: string) =>
    diagnostics.push({ severity: 'error', code, message, path: relativePath });

  if (!expectedIdPattern(data.type).test(data.id)) {
    error(
      'docs-id-format',
      `ID "${data.id}" is invalid for type ${data.type}.`,
    );
  }
  if (data.supersedes === data.id) {
    error('docs-self-supersedes', 'A document cannot supersede itself.');
  }
  if (!unique(data.projects)) {
    error('docs-duplicate-project', 'The projects list contains duplicates.');
  }
  if (!unique(data.topics)) {
    error('docs-duplicate-topic', 'The topics list contains duplicates.');
  }
  if (!unique(data.references) || !unique(data.external_references)) {
    error(
      'docs-duplicate-reference',
      'Reference lists must not contain duplicates.',
    );
  }
  if (data.visibility === 'public' && !data.visibility_reviewed_at) {
    error(
      'docs-public-review',
      'Public documents require visibility_reviewed_at.',
    );
  }
  if (data.visibility === 'internal' && data.visibility_reviewed_at) {
    error(
      'docs-internal-review',
      'Internal documents must not carry visibility_reviewed_at.',
    );
  }
  if (data.architecture) {
    if (data.type !== 'spec') {
      error(
        'docs-architecture-type',
        'Architecture dependency contracts are only valid on specifications.',
      );
    }
    const projects = new Set(data.projects);
    const allowed = new Set<string>();
    const forbidden = new Set<string>();
    const validateEdges = (
      edges: readonly ArchitectureDependency[],
      kind: 'allowed' | 'forbidden',
      seen: Set<string>,
    ) => {
      for (const edge of edges) {
        const fingerprint = `${edge.from}->${edge.to}`;
        if (edge.from === edge.to) {
          error(
            'docs-architecture-self-edge',
            `Architecture ${kind} dependency ${fingerprint} cannot be a self-edge.`,
          );
        }
        if (!projects.has(edge.from) || !projects.has(edge.to)) {
          error(
            'docs-architecture-project',
            `Architecture ${kind} dependency ${fingerprint} must reference projects listed by the specification.`,
          );
        }
        if (seen.has(fingerprint)) {
          error(
            'docs-architecture-duplicate',
            `Architecture ${kind} dependency ${fingerprint} is duplicated.`,
          );
        }
        seen.add(fingerprint);
      }
    };
    validateEdges(data.architecture.allowed_dependencies, 'allowed', allowed);
    validateEdges(
      data.architecture.forbidden_dependencies,
      'forbidden',
      forbidden,
    );
    for (const fingerprint of allowed) {
      if (forbidden.has(fingerprint)) {
        error(
          'docs-architecture-conflict',
          `Architecture dependency ${fingerprint} cannot be both allowed and forbidden.`,
        );
      }
    }
  }

  switch (data.type) {
    case 'spec': {
      const statuses = ['draft', 'accepted', 'superseded', 'retired'];
      if (!statuses.includes(data.status)) {
        error('docs-status', `Invalid spec status "${data.status}".`);
      }
      if (archived !== ['superseded', 'retired'].includes(data.status)) {
        error(
          'docs-spec-location',
          archived
            ? 'Archived specs must be superseded or retired.'
            : 'Superseded and retired specs must be archived.',
        );
      }
      break;
    }
    case 'plan': {
      const active = ['backlog', 'in-progress', 'on-hold'];
      const terminal = ['completed', 'aborted'];
      if (![...active, ...terminal].includes(data.status)) {
        error('docs-status', `Invalid plan status "${data.status}".`);
      }
      if (data.status === 'in-progress' && !data.branch) {
        error('docs-plan-branch', 'In-progress plans require branch.');
      }
      if (terminal.includes(data.status) && !data.completed_at) {
        error('docs-plan-completed-at', 'Terminal plans require completed_at.');
      }
      if (data.status === 'aborted' && !data.aborted_because) {
        error(
          'docs-plan-abort-reason',
          'Aborted plans require aborted_because.',
        );
      }
      if (archived !== terminal.includes(data.status)) {
        error(
          'docs-plan-location',
          archived
            ? 'Archived plans must have a terminal status.'
            : 'Terminal plans must be archived.',
        );
      }
      break;
    }
    case 'decision': {
      if (
        !['proposed', 'accepted', 'deferred', 'rejected'].includes(data.status)
      ) {
        error('docs-status', `Invalid decision status "${data.status}".`);
      }
      if (
        data.status === 'deferred' &&
        (!data.revisit_when || !data.migration_path)
      ) {
        error(
          'docs-deferred-contract',
          'Deferred decisions require revisit_when and migration_path.',
        );
      }
      if (archived) error('docs-decision-location', 'Decisions never archive.');
      break;
    }
    case 'audit':
      if (data.status !== 'current') {
        error('docs-status', `Invalid audit status "${data.status}".`);
      }
      if (!data.standard)
        error('docs-audit-standard', 'Audits require standard.');
      if (archived) error('docs-audit-location', 'Audits never archive.');
      break;
    case 'research':
      if (!['active', 'complete'].includes(data.status)) {
        error('docs-status', `Invalid research status "${data.status}".`);
      }
      if (archived !== (data.status === 'complete')) {
        error(
          'docs-research-location',
          archived
            ? 'Archived research must be complete.'
            : 'Completed research must be archived.',
        );
      }
      break;
    case 'report':
      if (data.status !== 'generated') {
        error('docs-status', `Invalid report status "${data.status}".`);
      }
      if (!data.producer || !data.generated_at) {
        error(
          'docs-report-contract',
          'Reports require producer and generated_at.',
        );
      }
      if (archived) error('docs-report-location', 'Reports never archive.');
      break;
  }
}

export async function validateRepositoryDocs(
  workspaceRoot: string,
  config: MegamonoConfig,
  docsRoot = config.docs.root,
): Promise<DocsValidationResult> {
  if (!isSafeWorkspaceRelativePath(docsRoot)) {
    throw new Error(
      'Documentation root must be a safe workspace-relative path.',
    );
  }
  const absoluteDocsRoot = resolve(workspaceRoot, docsRoot);
  const diagnostics: Diagnostic[] = [];
  const paths = (
    await Promise.all([
      ...[...DOCUMENT_DIRECTORIES].map((directory) =>
        walkMarkdown(join(absoluteDocsRoot, directory)),
      ),
      walkMarkdown(join(absoluteDocsRoot, 'archives')),
    ])
  ).flat();
  const documents: RepositoryDocument[] = [];
  const topicVocabulary = getTopicVocabulary(config);

  for (const absolutePath of paths) {
    const relativePath = normalizePath(
      relative(absoluteDocsRoot, absolutePath),
    );
    const parts = relativePath.split('/');
    const archived = parts[0] === 'archives';
    const documentDirectory = archived ? parts[1] : parts[0];
    if (!documentDirectory || !DOCUMENT_DIRECTORIES.has(documentDirectory)) {
      diagnostics.push({
        severity: 'error',
        code: 'docs-placement',
        message: 'Markdown record is outside the supported corpus directories.',
        path: relativePath,
      });
      continue;
    }

    const source = await readFile(absolutePath, 'utf8');
    if (!matter.test(source)) {
      diagnostics.push({
        severity: 'error',
        code: 'docs-front-matter',
        message: 'Repository documents require YAML front matter.',
        path: relativePath,
      });
      continue;
    }

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(source);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'docs-front-matter',
        message: `Unable to parse YAML front matter: ${(error as Error).message}`,
        path: relativePath,
      });
      continue;
    }
    const result = repositoryDocumentSchema.safeParse(parsed.data);
    if (!result.success) {
      for (const issue of result.error.issues) {
        diagnostics.push({
          severity: 'error',
          code: 'docs-front-matter',
          message: `${issue.path.join('.') || '<root>'}: ${issue.message}`,
          path: relativePath,
        });
      }
      continue;
    }

    const expectedDirectory = getDocumentDirectory(result.data.type);
    const actualDirectory = documentDirectory;
    if (actualDirectory !== expectedDirectory) {
      diagnostics.push({
        severity: 'error',
        code: 'docs-type-location',
        message: `Type ${result.data.type} belongs in ${expectedDirectory}/, not ${actualDirectory}/.`,
        path: relativePath,
      });
    }
    for (const topic of result.data.topics) {
      if (!topicVocabulary.has(topic)) {
        diagnostics.push({
          severity: 'error',
          code: 'docs-topic-vocabulary',
          message: `Unknown topic "${topic}". Add it to megamono.json topics.extend.`,
          path: relativePath,
        });
      }
    }

    const document: RepositoryDocument = {
      absolutePath,
      relativePath,
      archived,
      content: parsed.content,
      source,
      data: result.data,
    };
    validateTypeSpecificFields(document, diagnostics);
    documents.push(document);
  }

  const documentsById = new Map<string, RepositoryDocument>();
  const externalSystems = new Set(
    documents.flatMap((document) =>
      document.data.external_references.map(
        (reference) => reference.split(':')[0],
      ),
    ),
  );

  for (const document of documents) {
    const existing = documentsById.get(document.data.id);
    if (existing) {
      diagnostics.push({
        severity: 'error',
        code: 'docs-duplicate-id',
        message: `ID ${document.data.id} is also declared by ${existing.relativePath}.`,
        path: document.relativePath,
      });
    } else {
      documentsById.set(document.data.id, document);
    }
  }

  for (const document of documents) {
    const declared = new Set(document.data.references);
    for (const reference of document.data.references) {
      if (!documentsById.has(reference)) {
        diagnostics.push({
          severity: 'error',
          code: 'docs-reference-integrity',
          message: `Reference ${reference} does not resolve in the hot or archived corpus.`,
          path: document.relativePath,
        });
      }
    }
    if (document.data.supersedes) {
      const target = documentsById.get(document.data.supersedes);
      if (!target) {
        diagnostics.push({
          severity: 'error',
          code: 'docs-supersedes-integrity',
          message: `Superseded ID ${document.data.supersedes} does not resolve.`,
          path: document.relativePath,
        });
      } else if (target.data.type !== document.data.type) {
        diagnostics.push({
          severity: 'error',
          code: 'docs-supersedes-type',
          message: `A ${document.data.type} cannot supersede a ${target.data.type}.`,
          path: document.relativePath,
        });
      }
    }

    for (const knownId of documentsById.keys()) {
      if (
        knownId !== document.data.id &&
        document.content.includes(knownId) &&
        !declared.has(knownId) &&
        document.data.supersedes !== knownId
      ) {
        diagnostics.push({
          severity: 'error',
          code: 'docs-body-reference',
          message: `Body reference ${knownId} must be listed in references.`,
          path: document.relativePath,
        });
      }
    }
    const declaredExternal = new Set(document.data.external_references);
    for (const system of externalSystems) {
      const pattern = new RegExp(
        `\\b${system}:[a-z0-9]+(?:-[a-z0-9]+)*\\b`,
        'g',
      );
      for (const match of document.content.matchAll(pattern)) {
        const value = match[0];
        if (!declaredExternal.has(value)) {
          diagnostics.push({
            severity: 'error',
            code: 'docs-external-reference',
            message: `Body reference ${value} must be listed in external_references.`,
            path: document.relativePath,
          });
        }
      }
    }
  }

  for (const document of documents) {
    const visited = new Set<string>();
    let current: RepositoryDocument | undefined = document;
    while (current?.data.supersedes) {
      if (visited.has(current.data.supersedes)) {
        diagnostics.push({
          severity: 'error',
          code: 'docs-supersedes-cycle',
          message: `Supersedes chain for ${document.data.id} contains a cycle.`,
          path: document.relativePath,
        });
        break;
      }
      visited.add(current.data.supersedes);
      current = documentsById.get(current.data.supersedes);
    }
  }

  diagnostics.push(
    ...(await validateCorpusDirection(
      workspaceRoot,
      normalizePath(docsRoot),
      documents,
    )),
  );

  return { documents, diagnostics };
}

function escapeTableCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderIndex(
  title: string,
  documents: readonly RepositoryDocument[],
  indexPath: string,
  designHandoff = false,
): string {
  const rows = [...documents]
    .filter((document) => document.data.type !== 'report')
    .sort((left, right) => left.data.id.localeCompare(right.data.id))
    .map((document) => {
      const link = normalizePath(
        relative(dirname(indexPath), document.absolutePath),
      );
      const data = document.data;
      return `| [\`${data.id}\`](${link}) | ${data.type} | ${data.status} | ${data.visibility} | ${data.projects.join(', ')} | ${data.topics.join(', ')} | ${escapeTableCell(data.summary)} |`;
    });
  return `${[
    `# ${title}`,
    '',
    ...(designHandoff
      ? [
          '[Design handoff](design/README.md) — visual references, tokens, and spec mappings (outside the lifecycle corpus).',
          '',
        ]
      : []),
    '| ID | Type | Status | Visibility | Projects | Topics | Summary |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')}`;
}

async function writeIfChanged(
  path: string,
  content: string,
  write: boolean,
): Promise<boolean> {
  let current: string | undefined;
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current === content) return false;
  if (write) await writeFile(path, content, 'utf8');
  return true;
}

export async function generateDocsIndexes(
  workspaceRoot: string,
  config: MegamonoConfig,
  documents: readonly RepositoryDocument[],
  docsRoot = config.docs.root,
  write = true,
): Promise<readonly string[]> {
  if (!isSafeWorkspaceRelativePath(docsRoot)) {
    throw new Error(
      'Documentation root must be a safe workspace-relative path.',
    );
  }
  const absoluteDocsRoot = resolve(workspaceRoot, docsRoot);
  const hotPath = join(absoluteDocsRoot, 'INDEX.md');
  const archivePath = join(absoluteDocsRoot, 'archives', 'INDEX.md');
  const changed: string[] = [];
  const hot = documents.filter((document) => !document.archived);
  const archived = documents.filter((document) => document.archived);
  const designHandoff = await stat(
    join(absoluteDocsRoot, 'design', 'README.md'),
  )
    .then((entry) => entry.isFile())
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
  const hotContent = await format(
    renderIndex('Repository documentation index', hot, hotPath, designHandoff),
    { parser: 'markdown' },
  );
  const archiveContent = await format(
    renderIndex('Archived documentation index', archived, archivePath),
    { parser: 'markdown' },
  );
  if (await writeIfChanged(hotPath, hotContent, write)) {
    changed.push(normalizePath(relative(workspaceRoot, hotPath)));
  }
  if (await writeIfChanged(archivePath, archiveContent, write)) {
    changed.push(normalizePath(relative(workspaceRoot, archivePath)));
  }
  if (write) {
    refreshDerivedArtifactHashes(workspaceRoot, [
      'docs.index',
      'docs.archive-index',
    ]);
  }
  return changed;
}

export function getDocumentDirectory(type: RepositoryDocumentType): string {
  return type === 'research' ? 'research' : `${type}s`;
}

export function getDocumentFileName(document: RepositoryDocument): string {
  return basename(document.absolutePath);
}
