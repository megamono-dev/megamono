import type { GeneratorCallback, Tree } from '@nx/devkit';
import {
  docsIndexCallback,
  listMarkdownPaths,
  normalizeSlug,
  readRecordId,
  validateCommonOptions,
  writeRecord,
} from '../docs-record';
import type { DocsSpecGeneratorSchema } from './schema';

function normalizeArchitecture(
  projects: readonly string[],
  options: DocsSpecGeneratorSchema,
) {
  const normalizeEdges = (
    edges: DocsSpecGeneratorSchema['allowedDependencies'],
    label: string,
  ) =>
    (edges ?? []).map((edge) => ({
      from: normalizeSlug(edge.from, `${label} from`),
      to: normalizeSlug(edge.to, `${label} to`),
    }));
  const allowed = normalizeEdges(
    options.allowedDependencies,
    'allowed dependency',
  );
  const forbidden = normalizeEdges(
    options.forbiddenDependencies,
    'forbidden dependency',
  );
  const requested =
    options.allowedDependencies !== undefined ||
    options.forbiddenDependencies !== undefined;
  if (!requested) return undefined;
  if (allowed.length + forbidden.length === 0) {
    throw new Error('Architecture must declare at least one dependency edge.');
  }
  const projectNames = new Set(projects);
  const seen = new Map<string, 'allowed' | 'forbidden'>();
  for (const [kind, edges] of [
    ['allowed', allowed],
    ['forbidden', forbidden],
  ] as const) {
    for (const edge of edges) {
      const fingerprint = `${edge.from}->${edge.to}`;
      if (edge.from === edge.to) {
        throw new Error(
          `Architecture dependency ${fingerprint} is a self-edge.`,
        );
      }
      if (!projectNames.has(edge.from) || !projectNames.has(edge.to)) {
        throw new Error(
          `Architecture dependency ${fingerprint} must reference a project in projects.`,
        );
      }
      const previous = seen.get(fingerprint);
      if (previous) {
        throw new Error(
          `Architecture dependency ${fingerprint} is ${previous === kind ? 'duplicated' : 'both allowed and forbidden'}.`,
        );
      }
      seen.set(fingerprint, kind);
    }
  }
  return {
    allowed_dependencies: allowed,
    forbidden_dependencies: forbidden,
  };
}

export async function docsSpecGenerator(
  tree: Tree,
  options: DocsSpecGeneratorSchema,
): Promise<GeneratorCallback> {
  const rawTitle = options.title ?? `${options.project} specification`;
  const common = validateCommonOptions(tree, {
    ...options,
    title: rawTitle,
    topics: options.topics ?? ['architecture'],
  });
  const projects = (options.projects ?? [common.project]).map((project) =>
    normalizeSlug(project, 'project'),
  );
  if (new Set(projects).size !== projects.length) {
    throw new Error('projects must not contain duplicates.');
  }
  const architecture = normalizeArchitecture(projects, options);
  const slug = normalizeSlug(rawTitle, 'title');
  const directory = `${common.docsRoot}/specs/${common.project}`;
  const existingPath = listMarkdownPaths(tree, directory).find((path) =>
    new RegExp(`/\\d+-${slug}\\.md$`).test(path),
  );
  let number: number;
  if (existingPath) {
    const existingId = readRecordId(tree, existingPath);
    const match = existingId?.match(
      new RegExp(`^spec-${common.project}-(\\d{4})$`),
    );
    if (!match) {
      throw new Error(
        `Existing spec path ${existingPath} does not declare the expected project ID.`,
      );
    }
    number = Number(match[1]);
  } else {
    const numbers = listMarkdownPaths(tree, directory)
      .map((path) => readRecordId(tree, path))
      .flatMap((id) => {
        const match = id?.match(
          new RegExp(`^spec-${common.project}-(\\d{4})$`),
        );
        return match ? [Number(match[1])] : [];
      });
    number = numbers.length === 0 ? 0 : Math.max(...numbers) + 1;
  }
  const displayNumber = String(number).padStart(2, '0');
  const idNumber = String(number).padStart(4, '0');
  await writeRecord(tree, {
    id: `spec-${common.project}-${idNumber}`,
    path: existingPath ?? `${directory}/${displayNumber}-${slug}.md`,
    title: `${displayNumber} — ${common.title}`,
    data: {
      id: `spec-${common.project}-${idNumber}`,
      type: 'spec',
      status: 'draft',
      visibility: 'internal',
      projects,
      topics: common.topics,
      summary: common.title,
      date: common.isoDate,
      supersedes: null,
      references: common.references,
      external_references: common.externalReferences,
      ...(architecture ? { architecture } : {}),
    },
    sections: ['Intent', 'Scope', 'Failure behavior', 'Acceptance criteria'],
  });
  return docsIndexCallback(tree, common.docsRoot);
}

export default docsSpecGenerator;
