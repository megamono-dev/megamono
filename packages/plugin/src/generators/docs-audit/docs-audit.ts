import type { GeneratorCallback, Tree } from '@nx/devkit';
import {
  docsIndexCallback,
  listMarkdownPaths,
  normalizeSlug,
  readRecordId,
  validateCommonOptions,
  writeRecord,
} from '../docs-record';
import type { DocsAuditGeneratorSchema } from './schema';

export async function docsAuditGenerator(
  tree: Tree,
  options: DocsAuditGeneratorSchema,
): Promise<GeneratorCallback> {
  const target = normalizeSlug(options.target, 'target');
  const title = options.title ?? `${options.target} audit`;
  const references = [
    ...new Set([options.spec, ...(options.references ?? [])]),
  ];
  const common = validateCommonOptions(tree, {
    ...options,
    title,
    references,
    topics: options.topics ?? ['testing'],
  });
  const specPath = listMarkdownPaths(tree, common.docsRoot).find(
    (path) => readRecordId(tree, path) === options.spec,
  );
  if (!specPath)
    throw new Error(`Audit standard ${options.spec} does not resolve.`);
  const id = `audit-${target}-${common.compactDate}`;
  await writeRecord(tree, {
    id,
    path: `${common.docsRoot}/audits/${target}-${common.compactDate}.md`,
    title: common.title,
    data: {
      id,
      type: 'audit',
      status: 'current',
      visibility: 'internal',
      projects: [common.project],
      topics: common.topics,
      summary: common.title,
      date: common.isoDate,
      supersedes: null,
      references: common.references,
      external_references: common.externalReferences,
      standard: options.spec,
    },
    sections: ['Standard', 'Findings', 'Result'],
  });
  return docsIndexCallback(tree, common.docsRoot);
}

export default docsAuditGenerator;
