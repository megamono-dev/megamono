import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import type { Tree } from '@nx/devkit';
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
    await workspaceInitGenerator(tree, {});
  });

  function expectValid(path: string): void {
    const source = tree.read(path, 'utf8');
    expect(source).toBeDefined();
    expect(
      repositoryDocumentSchema.safeParse(matter(source ?? '').data).success,
    ).toBe(true);
  }

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
