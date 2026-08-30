import type { Tree } from '@nx/devkit';
import matter = require('gray-matter');
import { format } from 'prettier';
import { z } from 'zod';
import { isSafeWorkspaceRelativePath } from './config';
import { repositoryDocumentSchema } from './docs';

const adoptionMapSchema = z
  .object({
    documents: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .strict();

export interface DocsAdoptionEntry {
  readonly path: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

function expectedId(type: string, id: string): boolean {
  const slug = '[a-z0-9]+(?:-[a-z0-9]+)*';
  const patterns: Readonly<Record<string, RegExp>> = {
    spec: new RegExp(`^spec-${slug}-\\d{4}$`),
    plan: new RegExp(`^plan-${slug}-\\d{8}-${slug}$`),
    decision: new RegExp(`^decision-\\d{8}-${slug}$`),
    audit: new RegExp(`^audit-${slug}-\\d{8}$`),
    research: new RegExp(`^research-\\d{8}-${slug}$`),
    report: new RegExp(`^report-${slug}-\\d{8}T\\d{6}Z$`),
  };
  return patterns[type]?.test(id) ?? false;
}

export function readDocsAdoptionMap(
  tree: Tree,
  mapPath: string | undefined,
): readonly DocsAdoptionEntry[] {
  if (!mapPath) return [];
  if (!isSafeWorkspaceRelativePath(mapPath)) {
    throw new Error('docsAdoptionMap must be a safe workspace-relative path.');
  }
  if (!tree.exists(mapPath)) throw new Error(`${mapPath} does not exist.`);
  let input: unknown;
  try {
    input = JSON.parse(tree.read(mapPath, 'utf8') ?? '');
  } catch (error) {
    throw new Error(`${mapPath} is not valid JSON.`, { cause: error });
  }
  const parsed = adoptionMapSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `${mapPath} must contain { "documents": { "path.md": { ...metadata } } }.`,
    );
  }
  const entries = Object.entries(parsed.data.documents)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, metadata]) => ({ path, metadata }));
  const ids = new Map<string, string>();
  const mappedPaths = new Set(entries.map(({ path }) => path));
  const visit = (directory: string): void => {
    for (const child of tree.children(directory)) {
      const path = directory ? `${directory}/${child}` : child;
      if (!tree.isFile(path)) {
        if (!['.git', '.nx', 'dist', 'node_modules'].includes(child)) visit(path);
        continue;
      }
      if (!path.endsWith('.md') || mappedPaths.has(path)) continue;
      const id = matter(tree.read(path, 'utf8') ?? '').data.id;
      if (typeof id === 'string') ids.set(id, path);
    }
  };
  visit('');
  for (const entry of entries) {
    if (
      !isSafeWorkspaceRelativePath(entry.path) ||
      !entry.path.endsWith('.md')
    ) {
      throw new Error(`${entry.path} must be a safe Markdown path.`);
    }
    if (!tree.exists(entry.path))
      throw new Error(`${entry.path} does not exist.`);
    const source = tree.read(entry.path, 'utf8') ?? '';
    const merged = { ...matter(source).data, ...entry.metadata };
    const metadata = repositoryDocumentSchema.safeParse(merged);
    if (!metadata.success) {
      const details = metadata.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new Error(`${entry.path} has invalid adoption metadata: ${details}`);
    }
    if (!expectedId(metadata.data.type, metadata.data.id)) {
      throw new Error(
        `${entry.path} uses ID ${metadata.data.id}, which does not match its ${metadata.data.type} lifecycle format.`,
      );
    }
    const prior = ids.get(metadata.data.id);
    if (prior) {
      throw new Error(
        `Document ID ${metadata.data.id} is assigned to both ${prior} and ${entry.path}.`,
      );
    }
    ids.set(metadata.data.id, entry.path);
  }
  return entries;
}

export async function applyDocsAdoptionMap(
  tree: Tree,
  entries: readonly DocsAdoptionEntry[],
): Promise<void> {
  const outputs = await Promise.all(
    entries.map(async ({ path, metadata }) => {
      const parsed = matter(tree.read(path, 'utf8') ?? '');
      const source = matter.stringify(parsed.content, {
        ...parsed.data,
        ...metadata,
      });
      return [path, await format(source, { parser: 'markdown' })] as const;
    }),
  );
  for (const [path, source] of outputs) tree.write(path, source);
}
