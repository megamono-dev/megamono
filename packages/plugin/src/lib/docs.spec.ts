import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MEGAMONO_CONFIG } from './config';
import {
  generateDocsIndexes,
  validatePublicVisibilityReviews,
  validateRepositoryDocs,
} from './docs';

const spec = `---
id: spec-test-0001
type: spec
status: accepted
visibility: internal
projects: [test]
topics: [architecture]
summary: Defines the fixture contract.
date: 2026-08-23
supersedes: null
references: []
external_references: []
---

# Fixture
`;

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'megamono-docs-'));
  await mkdir(join(root, 'docs', 'specs', 'test'), { recursive: true });
  await mkdir(join(root, 'docs', 'archives'), { recursive: true });
  await writeFile(join(root, 'docs', 'specs', 'test', '01-fixture.md'), spec);
  await writeFile(join(root, 'docs', 'DESIGN.md'), '# Design\n');
  return root;
}

describe('repository documentation', () => {
  it('validates metadata and generates byte-stable indexes', async () => {
    const root = await fixture();
    try {
      const result = await validateRepositoryDocs(
        root,
        DEFAULT_MEGAMONO_CONFIG,
      );
      expect(result.diagnostics).toEqual([]);
      expect(result.documents).toHaveLength(1);

      const first = await generateDocsIndexes(
        root,
        DEFAULT_MEGAMONO_CONFIG,
        result.documents,
      );
      const second = await generateDocsIndexes(
        root,
        DEFAULT_MEGAMONO_CONFIG,
        result.documents,
      );
      expect(first).toEqual(['docs/INDEX.md', 'docs/archives/INDEX.md']);
      expect(second).toEqual([]);
      expect(await readFile(join(root, 'docs', 'INDEX.md'), 'utf8')).toContain(
        '[`spec-test-0001`](specs/test/01-fixture.md)',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports duplicate IDs and dangling references with source paths', async () => {
    const root = await fixture();
    try {
      const duplicate = spec.replace(
        'references: []',
        'references: [spec-test-9999]',
      );
      await writeFile(
        join(root, 'docs', 'specs', 'test', '02-duplicate.md'),
        duplicate,
      );
      const result = await validateRepositoryDocs(
        root,
        DEFAULT_MEGAMONO_CONFIG,
      );
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'docs-duplicate-id' }),
          expect.objectContaining({ code: 'docs-reference-integrity' }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts strict architecture dependency contracts on specs', async () => {
    const root = await fixture();
    try {
      await writeFile(
        join(root, 'docs', 'specs', 'test', '01-fixture.md'),
        spec.replace('projects: [test]', 'projects: [test, api]').replace(
          'topics: [architecture]',
          `topics: [architecture]
architecture:
  allowed_dependencies:
    - from: test
      to: api
  forbidden_dependencies:
    - from: api
      to: test`,
        ),
      );

      const result = await validateRepositoryDocs(
        root,
        DEFAULT_MEGAMONO_CONFIG,
      );

      expect(result.diagnostics).toEqual([]);
      expect(result.documents[0].data.architecture).toEqual({
        allowed_dependencies: [{ from: 'test', to: 'api' }],
        forbidden_dependencies: [{ from: 'api', to: 'test' }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid and non-spec architecture contracts', async () => {
    const root = await fixture();
    try {
      const invalidArchitecture = `architecture:
  allowed_dependencies:
    - from: test
      to: test
    - from: test
      to: missing
    - from: test
      to: api
    - from: test
      to: api
  forbidden_dependencies:
    - from: test
      to: api`;
      await writeFile(
        join(root, 'docs', 'specs', 'test', '01-fixture.md'),
        spec
          .replace('projects: [test]', 'projects: [test, api]')
          .replace(
            'topics: [architecture]',
            `topics: [architecture]\n${invalidArchitecture}`,
          ),
      );
      await mkdir(join(root, 'docs', 'decisions'), { recursive: true });
      await writeFile(
        join(root, 'docs', 'decisions', 'architecture.md'),
        spec
          .replace('id: spec-test-0001', 'id: decision-20260823-architecture')
          .replace('type: spec', 'type: decision')
          .replace('projects: [test]', 'projects: [test, api]')
          .replace(
            'topics: [architecture]',
            `topics: [architecture]\n${invalidArchitecture}`,
          ),
      );

      const result = await validateRepositoryDocs(
        root,
        DEFAULT_MEGAMONO_CONFIG,
      );

      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'docs-architecture-self-edge' }),
          expect.objectContaining({ code: 'docs-architecture-project' }),
          expect.objectContaining({ code: 'docs-architecture-duplicate' }),
          expect.objectContaining({ code: 'docs-architecture-conflict' }),
          expect.objectContaining({ code: 'docs-architecture-type' }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enforces public review metadata and plan archive lifecycle', async () => {
    const root = await fixture();
    try {
      await writeFile(
        join(root, 'docs', 'specs', 'test', '01-fixture.md'),
        spec.replace('visibility: internal', 'visibility: public'),
      );
      await mkdir(join(root, 'docs', 'plans', 'test'), { recursive: true });
      await writeFile(
        join(root, 'docs', 'plans', 'test', 'plan.md'),
        `---
id: plan-test-20260823-fixture
type: plan
status: completed
visibility: internal
projects: [test]
topics: [plans]
summary: Completes the fixture.
date: 2026-08-23
supersedes: null
references: []
external_references: []
completed_at: 2026-08-23T12:00:00Z
---

# Plan
`,
      );
      const result = await validateRepositoryDocs(
        root,
        DEFAULT_MEGAMONO_CONFIG,
      );
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'docs-public-review' }),
          expect.objectContaining({ code: 'docs-plan-location' }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires changed public content to advance its visibility review', async () => {
    const root = await fixture();
    try {
      const publicSpec = spec
        .replace('visibility: internal', 'visibility: public')
        .replace(
          'projects: [test]',
          'visibility_reviewed_at: 2026-08-23T12:00:00Z\nprojects: [test]',
        );
      await writeFile(
        join(root, 'docs', 'specs', 'test', '01-fixture.md'),
        publicSpec.replace('# Fixture', '# Changed fixture'),
      );
      const result = await validateRepositoryDocs(
        root,
        DEFAULT_MEGAMONO_CONFIG,
      );
      const previous = new Map([['specs/test/01-fixture.md', publicSpec]]);

      expect(
        validatePublicVisibilityReviews(result.documents, previous),
      ).toEqual([
        expect.objectContaining({ code: 'docs-public-review-stale' }),
      ]);

      await writeFile(
        join(root, 'docs', 'specs', 'test', '01-fixture.md'),
        publicSpec
          .replace(
            'visibility_reviewed_at: 2026-08-23T12:00:00Z',
            'visibility_reviewed_at: 2026-08-24T12:00:00Z',
          )
          .replace('# Fixture', '# Changed fixture'),
      );
      const reviewed = await validateRepositoryDocs(
        root,
        DEFAULT_MEGAMONO_CONFIG,
      );
      expect(
        validatePublicVisibilityReviews(reviewed.documents, previous),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns when a content collection depends on repository-doc identifiers or paths', async () => {
    const root = await fixture();
    try {
      const contentRoot = join(root, 'packages', 'articles');
      await mkdir(join(contentRoot, 'content', 'article'), {
        recursive: true,
      });
      await writeFile(
        join(contentRoot, 'package.json'),
        JSON.stringify({
          name: '@test/articles',
          megamono: {
            contentCollection: { version: 1, name: 'articles', types: [] },
          },
        }),
      );
      await writeFile(
        join(contentRoot, 'content', 'article', 'fixture.md'),
        '# Article\n\nSee spec-test-0001 and docs/specs/test/01-fixture.md.\n',
      );

      const result = await validateRepositoryDocs(
        root,
        DEFAULT_MEGAMONO_CONFIG,
      );

      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          severity: 'warning',
          code: 'docs-corpus-direction',
          path: 'packages/articles/content/article/fixture.md',
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
