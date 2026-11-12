import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { readJson, writeJson, type Tree } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import matter = require('gray-matter');
import { repositoryDocumentSchema } from '../lib/docs';
import { docsAuditGenerator } from './docs-audit/docs-audit';
import { docsDecisionGenerator } from './docs-decision/docs-decision';
import { docsPlanGenerator } from './docs-plan/docs-plan';
import { docsResearchGenerator } from './docs-research/docs-research';
import { docsSpecGenerator } from './docs-spec/docs-spec';
import { workspaceInitGenerator } from './workspace-init/workspace-init';

describe('documentation generators', () => {
  let tree: Tree;

  beforeEach(async () => {
    tree = createTreeWithEmptyWorkspace();
    await workspaceInitGenerator(tree, {
      only: 'docs,agents,ci,lint,skills,health,inference',
      yes: true,
    });
  });

  function expectValid(path: string): void {
    const source = tree.read(path, 'utf8');
    expect(source).toBeDefined();
    expect(
      repositoryDocumentSchema.safeParse(matter(source ?? '').data).success,
    ).toBe(true);
  }

  it('provides complete help descriptions and preserves required versus inferred options', () => {
    const required = {
      'docs-init': [],
      'docs-audit': ['target', 'project', 'spec'],
      'docs-decision': ['title', 'project'],
      'docs-plan': ['project', 'title'],
      'docs-research': ['title', 'project'],
      'docs-spec': ['project'],
    };
    const ajv = new Ajv({ strict: false, validateFormats: false });
    for (const [name, fields] of Object.entries(required)) {
      const schema = JSON.parse(
        readFileSync(join(__dirname, name, 'schema.json'), 'utf8'),
      );
      expect(schema.description.length).toBeGreaterThan(20);
      expect(schema.required ?? []).toEqual(fields);
      for (const field of Object.values(schema.properties) as {
        description?: string;
      }[])
        expect(field.description?.trim().length).toBeGreaterThan(10);
      delete schema.$schema;
      const validate = ajv.compile(schema);
      if (name === 'docs-research') {
        expect(
          validate({
            title: 'Explore',
            project: 'future-project',
            topics: ['my-configured-topic'],
          }),
        ).toBe(true);
        expect(validate({ title: 'Explore' })).toBe(false);
        expect(validate({ title: ' ', project: 'future-project' })).toBe(false);
        expect(
          validate({
            title: 'Explore',
            project: 'future-project',
            topics: ['architecture', 'architecture'],
          }),
        ).toBe(false);
      }
    }
  });

  it('rejects unknown topics atomically for every document record generator', async () => {
    const generators = [
      () =>
        docsResearchGenerator(tree, {
          project: 'future-project',
          title: 'Explore',
          topics: ['typo-topic'],
        }),
      () =>
        docsPlanGenerator(tree, {
          project: 'future-project',
          title: 'Plan',
          topics: ['typo-topic'],
        }),
      () =>
        docsDecisionGenerator(tree, {
          project: 'future-project',
          title: 'Decide',
          topics: ['typo-topic'],
        }),
      () =>
        docsSpecGenerator(tree, {
          project: 'future-project',
          topics: ['typo-topic'],
        }),
      () =>
        docsAuditGenerator(tree, {
          target: 'api',
          project: 'future-project',
          spec: 'spec-future-project-0000',
          topics: ['typo-topic'],
        }),
    ];
    const before = tree.listChanges();
    for (const generate of generators) {
      await expect(generate()).rejects.toThrow('Unknown topic typo-topic');
      expect(tree.listChanges()).toEqual(before);
    }
  });

  it('accepts configured topics and planned project namespaces without inventing an Nx project', async () => {
    const config = readJson(tree, 'megamono.json');
    writeJson(tree, 'megamono.json', {
      ...config,
      topics: {
        ...config.topics,
        extend: [...(config.topics?.extend ?? []), 'future-planning'],
      },
    });
    await docsResearchGenerator(tree, {
      project: 'Future Project',
      title: 'Explore',
      date: '2026-11-10',
      topics: ['future-planning'],
    });
    expect(tree.read('docs/research/20261110-explore.md', 'utf8')).toContain(
      'projects: ["future-project"]',
    );
  });

  it('rejects missing project and malformed lists before mutation', async () => {
    const before = tree.listChanges();
    await expect(
      docsResearchGenerator(tree, {
        project: undefined as unknown as string,
        title: 'Explore',
      }),
    ).rejects.toThrow('project must be a nonempty string');
    await expect(
      docsResearchGenerator(tree, {
        project: 'test',
        title: 'Explore',
        topics: 'architecture' as unknown as string[],
      }),
    ).rejects.toThrow('topics must be a list');
    expect(tree.listChanges()).toEqual(before);
  });

  it('rejects unresolved document references before writing a record', async () => {
    const before = tree.listChanges();
    await expect(
      docsResearchGenerator(tree, {
        project: 'test',
        title: 'Explore',
        references: ['spec-test-9999'],
      }),
    ).rejects.toThrow('Document reference spec-test-9999 does not resolve');
    expect(tree.listChanges()).toEqual(before);
  });

  it('numbers specs deterministically and reruns as a no-op', async () => {
    const options = {
      project: 'test',
      title: 'API contract',
      date: '2026-08-23',
    };
    await docsSpecGenerator(tree, options);
    const changes = tree.listChanges();
    await docsSpecGenerator(tree, options);
    expect(tree.listChanges()).toEqual(changes);
    expect(tree.exists('docs/specs/test/00-api-contract.md')).toBe(true);
    expectValid('docs/specs/test/00-api-contract.md');

    await docsSpecGenerator(tree, {
      project: 'test',
      title: 'Worker contract',
      date: '2026-08-23',
    });
    expect(
      tree.read('docs/specs/test/01-worker-contract.md', 'utf8'),
    ).toContain('id: "spec-test-0001"');
  });

  it('refuses to overwrite a modified generated spec', async () => {
    const options = {
      project: 'test',
      title: 'API contract',
      date: '2026-08-23',
    };
    await docsSpecGenerator(tree, options);
    tree.write(
      'docs/specs/test/00-api-contract.md',
      `${tree.read('docs/specs/test/00-api-contract.md', 'utf8')}\nModified.\n`,
    );
    await expect(docsSpecGenerator(tree, options)).rejects.toThrow(
      'Refusing to overwrite',
    );
  });

  it('generates a strict architecture dependency contract', async () => {
    await docsSpecGenerator(tree, {
      project: 'platform',
      projects: ['web', 'api'],
      title: 'Service boundary',
      allowedDependencies: [{ from: 'web', to: 'api' }],
      forbiddenDependencies: [{ from: 'api', to: 'web' }],
      date: '2026-08-23',
    });
    const path = 'docs/specs/platform/00-service-boundary.md';
    const source = tree.read(path, 'utf8') ?? '';
    const parsed = matter(source).data;

    expect(parsed.projects).toEqual(['web', 'api']);
    expect(parsed.architecture).toEqual({
      allowed_dependencies: [{ from: 'web', to: 'api' }],
      forbidden_dependencies: [{ from: 'api', to: 'web' }],
    });
    expectValid(path);
  });

  it('rejects contradictory architecture dependency options', async () => {
    await expect(
      docsSpecGenerator(tree, {
        project: 'platform',
        projects: ['web', 'api'],
        allowedDependencies: [{ from: 'web', to: 'api' }],
        forbiddenDependencies: [{ from: 'web', to: 'api' }],
        date: '2026-08-23',
      }),
    ).rejects.toThrow('both allowed and forbidden');
  });

  it('creates valid lifecycle defaults for plan, decision, and research', async () => {
    await docsPlanGenerator(tree, {
      project: 'test',
      title: 'Ship API',
      date: '2026-08-23',
    });
    await docsDecisionGenerator(tree, {
      project: 'test',
      title: 'Use HTTP',
      date: '2026-08-23',
    });
    await docsResearchGenerator(tree, {
      project: 'test',
      title: 'Transport options',
      date: '2026-08-23',
    });
    expect(tree.read('docs/plans/test/20260823-ship-api.md', 'utf8')).toContain(
      'status: "backlog"',
    );
    expect(tree.read('docs/decisions/20260823-use-http.md', 'utf8')).toContain(
      'status: "proposed"',
    );
    expect(
      tree.read('docs/research/20260823-transport-options.md', 'utf8'),
    ).toContain('status: "active"');
    expectValid('docs/plans/test/20260823-ship-api.md');
    expectValid('docs/decisions/20260823-use-http.md');
    expectValid('docs/research/20260823-transport-options.md');
  });

  it('requires an existing spec as an audit standard', async () => {
    await docsSpecGenerator(tree, {
      project: 'test',
      title: 'API contract',
      date: '2026-08-23',
    });
    await docsAuditGenerator(tree, {
      target: 'api',
      project: 'test',
      spec: 'spec-test-0000',
      date: '2026-08-23',
    });
    expect(tree.read('docs/audits/api-20260823.md', 'utf8')).toContain(
      'standard: "spec-test-0000"',
    );
    expectValid('docs/audits/api-20260823.md');
  });
});
