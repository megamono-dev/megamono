import type { GeneratorCallback, Tree } from '@nx/devkit';
import {
  docsIndexCallback,
  normalizeSlug,
  validateCommonOptions,
  writeRecord,
} from '../docs-record';
import type { DocsResearchGeneratorSchema } from './schema';

export async function docsResearchGenerator(
  tree: Tree,
  options: DocsResearchGeneratorSchema,
): Promise<GeneratorCallback> {
  const common = validateCommonOptions(tree, {
    ...options,
    topics: options.topics ?? ['architecture'],
  });
  const slug = normalizeSlug(common.title, 'title');
  const id = `research-${common.compactDate}-${slug}`;
  await writeRecord(tree, {
    id,
    path: `${common.docsRoot}/research/${common.compactDate}-${slug}.md`,
    title: common.title,
    data: {
      id,
      type: 'research',
      status: 'active',
      visibility: 'internal',
      projects: [common.project],
      topics: common.topics,
      summary: common.title,
      date: common.isoDate,
      supersedes: null,
      references: common.references,
      external_references: common.externalReferences,
    },
    sections: ['Question', 'Findings', 'Open questions'],
  });
  return docsIndexCallback(tree, common.docsRoot);
}

export default docsResearchGenerator;
