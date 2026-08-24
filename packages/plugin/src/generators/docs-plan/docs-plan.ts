import type { GeneratorCallback, Tree } from '@nx/devkit';
import {
  docsIndexCallback,
  normalizeSlug,
  validateCommonOptions,
  writeRecord,
} from '../docs-record';
import type { DocsPlanGeneratorSchema } from './schema';

export async function docsPlanGenerator(
  tree: Tree,
  options: DocsPlanGeneratorSchema,
): Promise<GeneratorCallback> {
  const common = validateCommonOptions(tree, {
    ...options,
    topics: options.topics ?? ['plans'],
  });
  const slug = normalizeSlug(common.title, 'title');
  const id = `plan-${common.project}-${common.compactDate}-${slug}`;
  await writeRecord(tree, {
    id,
    path: `${common.docsRoot}/plans/${common.project}/${common.compactDate}-${slug}.md`,
    title: common.title,
    data: {
      id,
      type: 'plan',
      status: 'backlog',
      visibility: 'internal',
      projects: [common.project],
      topics: common.topics,
      summary: common.title,
      date: common.isoDate,
      supersedes: null,
      references: common.references,
      external_references: common.externalReferences,
    },
    sections: ['Outcome', 'Work', 'Verification'],
  });
  return docsIndexCallback(tree, common.docsRoot);
}

export default docsPlanGenerator;
