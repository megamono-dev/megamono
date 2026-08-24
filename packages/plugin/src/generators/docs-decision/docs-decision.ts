import type { GeneratorCallback, Tree } from '@nx/devkit';
import {
  docsIndexCallback,
  normalizeSlug,
  validateCommonOptions,
  writeRecord,
} from '../docs-record';
import type { DocsDecisionGeneratorSchema } from './schema';

export async function docsDecisionGenerator(
  tree: Tree,
  options: DocsDecisionGeneratorSchema,
): Promise<GeneratorCallback> {
  const common = validateCommonOptions(tree, {
    ...options,
    topics: options.topics ?? ['architecture'],
  });
  const slug = normalizeSlug(common.title, 'title');
  const id = `decision-${common.compactDate}-${slug}`;
  await writeRecord(tree, {
    id,
    path: `${common.docsRoot}/decisions/${common.compactDate}-${slug}.md`,
    title: common.title,
    data: {
      id,
      type: 'decision',
      status: 'proposed',
      visibility: 'internal',
      projects: [common.project],
      topics: common.topics,
      summary: common.title,
      date: common.isoDate,
      supersedes: null,
      references: common.references,
      external_references: common.externalReferences,
    },
    sections: ['Decision', 'Why', 'Consequences'],
  });
  return docsIndexCallback(tree, common.docsRoot);
}

export default docsDecisionGenerator;
