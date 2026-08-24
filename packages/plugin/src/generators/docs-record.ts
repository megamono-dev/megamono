import { type GeneratorCallback, type Tree } from '@nx/devkit';
import { format } from 'prettier';
import {
  getTopicVocabulary,
  megamonoConfigSchema,
  readMegamonoConfig,
} from '../lib/config';
import { generateDocsIndexes, validateRepositoryDocs } from '../lib/docs';

export interface CommonRecordOptions {
  readonly project: string;
  readonly title: string;
  readonly topics?: readonly string[];
  readonly references?: readonly string[];
  readonly externalReferences?: readonly string[];
  readonly date?: string;
}

export interface RecordDefinition {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly sections: readonly string[];
}

export function normalizeSlug(value: string, label = 'value'): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`${label} must contain a letter or number.`);
  return slug;
}

export function dateParts(date = new Date()): {
  readonly iso: string;
  readonly compact: string;
} {
  const iso = date.toISOString().slice(0, 10);
  return { iso, compact: iso.replaceAll('-', '') };
}

function serializeYaml(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export async function renderRecord(
  definition: RecordDefinition,
): Promise<string> {
  const frontMatter = Object.entries(definition.data)
    .map(([key, value]) => `${key}: ${serializeYaml(value)}`)
    .join('\n');
  const sections = definition.sections
    .map((section) => `## ${section}\n\nTODO`)
    .join('\n\n');
  return format(
    `---\n${frontMatter}\n---\n\n# ${definition.title}\n\n${sections}\n`,
    { parser: 'markdown' },
  );
}

export function listMarkdownPaths(tree: Tree, directory: string): string[] {
  const paths: string[] = [];
  const visit = (current: string) => {
    for (const child of tree.children(current)) {
      const path = current ? `${current}/${child}` : child;
      if (tree.isFile(path)) {
        if (path.endsWith('.md')) paths.push(path);
      } else {
        visit(path);
      }
    }
  };
  if (directory === '' || tree.exists(directory)) visit(directory);
  return paths.sort();
}

export function readRecordId(tree: Tree, path: string): string | undefined {
  return tree
    .read(path, 'utf8')
    ?.match(/^id:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
}

export function readDocsGeneratorConfig(tree: Tree) {
  if (!tree.exists('megamono.json')) {
    throw new Error('megamono.json is missing. Run workspace-init first.');
  }
  let value: unknown;
  try {
    value = JSON.parse(tree.read('megamono.json', 'utf8') ?? '');
  } catch (error) {
    throw new Error('megamono.json is not valid JSON.', { cause: error });
  }
  const result = megamonoConfigSchema.safeParse(value);
  if (!result.success) throw new Error('megamono.json is invalid.');
  return result.data;
}

export function validateCommonOptions(
  tree: Tree,
  options: CommonRecordOptions,
): {
  readonly project: string;
  readonly title: string;
  readonly topics: readonly string[];
  readonly references: readonly string[];
  readonly externalReferences: readonly string[];
  readonly isoDate: string;
  readonly compactDate: string;
  readonly docsRoot: string;
} {
  const config = readDocsGeneratorConfig(tree);
  const project = normalizeSlug(options.project, 'project');
  const title = options.title.trim();
  if (!title) throw new Error('title must not be empty.');
  const topics = options.topics ?? [];
  if (new Set(topics).size !== topics.length) {
    throw new Error('topics must not contain duplicates.');
  }
  const vocabulary = getTopicVocabulary(config);
  for (const topic of topics) {
    if (!vocabulary.has(topic)) {
      throw new Error(
        `Unknown topic ${topic}. Add it to megamono.json topics.extend.`,
      );
    }
  }
  const references = options.references ?? [];
  const externalReferences = options.externalReferences ?? [];
  if (new Set(references).size !== references.length) {
    throw new Error('references must not contain duplicates.');
  }
  if (new Set(externalReferences).size !== externalReferences.length) {
    throw new Error('externalReferences must not contain duplicates.');
  }
  for (const reference of externalReferences) {
    if (!/^[a-z][a-z0-9-]*:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reference)) {
      throw new Error(`Invalid external reference ${reference}.`);
    }
  }
  const parsedDate = options.date
    ? new Date(`${options.date}T00:00:00Z`)
    : new Date();
  if (
    Number.isNaN(parsedDate.getTime()) ||
    (options.date && parsedDate.toISOString().slice(0, 10) !== options.date)
  ) {
    throw new Error(`Invalid date ${options.date}.`);
  }
  const { iso, compact } = dateParts(parsedDate);
  return {
    project,
    title,
    topics,
    references,
    externalReferences,
    isoDate: iso,
    compactDate: compact,
    docsRoot: config.docs.root,
  };
}

export async function writeRecord(
  tree: Tree,
  definition: RecordDefinition,
): Promise<boolean> {
  const content = await renderRecord(definition);
  if (tree.exists(definition.path)) {
    if (tree.read(definition.path, 'utf8') === content) return false;
    throw new Error(
      `Refusing to overwrite existing record ${definition.path}.`,
    );
  }
  const duplicatePath = listMarkdownPaths(tree, '').find(
    (path) => readRecordId(tree, path) === definition.id,
  );
  if (duplicatePath) {
    throw new Error(
      `Document ID ${definition.id} already exists at ${duplicatePath}.`,
    );
  }
  tree.write(definition.path, content);
  return true;
}

export function docsIndexCallback(
  tree: Tree,
  docsRoot: string,
): GeneratorCallback {
  return async () => {
    const config = await readMegamonoConfig(tree.root);
    const result = await validateRepositoryDocs(tree.root, config, docsRoot);
    if (
      result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ) {
      throw new Error('Generated document failed repository validation.');
    }
    await generateDocsIndexes(tree.root, config, result.documents, docsRoot);
  };
}
