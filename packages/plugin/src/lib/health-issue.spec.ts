import { vi } from 'vitest';
import {
  HEALTH_CHECKS,
  type HealthFinding,
  type RepositoryHealthReport,
} from './health';
import {
  HEALTH_ISSUE_LABEL,
  HEALTH_ISSUE_TITLE,
  publishHealthIssue,
  renderHealthIssueBody,
} from './health-issue';

function report(
  options: {
    readonly findings?: readonly HealthFinding[];
    readonly intentional?: RepositoryHealthReport['intentional'];
  } = {},
): RepositoryHealthReport {
  const findings = options.findings ?? [];
  const intentional = options.intentional ?? [];
  return {
    schemaVersion: 1,
    purpose: 'advisory',
    readiness: 'not-assessed',
    coverage: Object.fromEntries(
      HEALTH_CHECKS.map((check) => [check, { status: 'completed' }]),
    ) as RepositoryHealthReport['coverage'],
    findings: findings.map((finding) => ({
      ...finding,
      severity: 'warning',
      category: finding.check,
    })),
    intentional,
    summary: {
      findings: findings.length,
      intentional: intentional.length,
      checks: {
        'dependency-alignment': findings.filter(
          ({ check }) => check === 'dependency-alignment',
        ).length,
        'spec-drift': 0,
        'stale-plans': 0,
        'orphaned-libraries': 0,
        'integration-template-drift': 0,
      },
    },
  };
}

function findingReport(): RepositoryHealthReport {
  return report({
    findings: [
      {
        check: 'dependency-alignment',
        fingerprint: 'react:app:root',
        state: 'alignable',
        confidence: 'complete',
        summary: 'React can be aligned.',
        evidence: ['app: ^19.0.0', 'root: 19.0.1'],
        recommendation: 'Align React to 19.0.1.',
      },
    ],
  });
}

function publisher(issues: readonly Record<string, unknown>[]) {
  const summary = {
    addRaw: vi.fn(),
    write: vi.fn().mockResolvedValue(undefined),
  };
  summary.addRaw.mockReturnValue(summary);
  const methods = {
    listForRepo: vi.fn(),
    getLabel: vi.fn().mockResolvedValue({}),
    createLabel: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockImplementation(async (input) => ({
      data: {
        number: input.issue_number,
        title: HEALTH_ISSUE_TITLE,
        state: input.state,
      },
    })),
    create: vi.fn().mockResolvedValue({
      data: { number: 42, title: HEALTH_ISSUE_TITLE, state: 'open' },
    }),
  };
  return {
    github: {
      paginate: vi.fn().mockResolvedValue(issues),
      rest: { issues: methods },
    },
    context: { repo: { owner: 'acme', repo: 'product' } },
    core: { summary },
    methods,
    summary,
  };
}

describe('health issue publisher', () => {
  it('renders grouped evidence, recommendations, and intentional divergences', () => {
    const body = renderHealthIssueBody(
      report({
        findings: findingReport().findings,
        intentional: [
          {
            check: 'dependency-alignment',
            fingerprint: 'react:app:root',
            decision: 'decision-20260823-react-split',
            matched: true,
          },
        ],
      }),
    );
    expect(body).toContain('## dependency-alignment');
    expect(body).toContain('Evidence: app: ^19.0.0');
    expect(body).toContain('Recommendation: Align React to 19.0.1.');
    expect(body).toContain('Intentional divergences');
    expect(body).toContain('decision-20260823-react-split');
  });

  it('updates and reopens the existing unlocked issue', async () => {
    const fixture = publisher([
      { number: 7, title: HEALTH_ISSUE_TITLE, state: 'closed' },
    ]);
    const result = await publishHealthIssue({
      ...fixture,
      report: findingReport(),
    });
    expect(result).toEqual({ action: 'updated', issueNumber: 7 });
    expect(fixture.methods.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7, state: 'open' }),
    );
    expect(fixture.methods.create).not.toHaveBeenCalled();
  });

  it('closes an open issue when no findings or suppressions remain', async () => {
    const fixture = publisher([
      { number: 8, title: HEALTH_ISSUE_TITLE, state: 'open' },
    ]);
    const result = await publishHealthIssue({ ...fixture, report: report() });
    expect(result).toEqual({ action: 'closed', issueNumber: 8 });
    expect(fixture.methods.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 8, state: 'closed' }),
    );
  });

  it('keeps intentional-only output visible', async () => {
    const fixture = publisher([
      { number: 9, title: HEALTH_ISSUE_TITLE, state: 'open' },
    ]);
    const intentional = report({
      intentional: [
        {
          check: 'dependency-alignment',
          fingerprint: 'react:app:root',
          decision: 'decision-20260823-react-split',
          matched: true,
        },
      ],
    });
    const result = await publishHealthIssue({
      ...fixture,
      report: intentional,
    });
    expect(result.action).toBe('updated');
    expect(fixture.methods.update).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Intentional') }),
    );
  });

  it('creates one replacement for a locked or concurrently deleted issue', async () => {
    const locked = publisher([
      {
        number: 10,
        title: HEALTH_ISSUE_TITLE,
        state: 'open',
        locked: true,
      },
    ]);
    const lockedResult = await publishHealthIssue({
      ...locked,
      report: findingReport(),
    });
    expect(lockedResult).toEqual({ action: 'created', issueNumber: 42 });
    expect(locked.methods.create).toHaveBeenCalledTimes(1);
    expect(locked.summary.write).toHaveBeenCalledTimes(1);

    const deleted = publisher([
      { number: 11, title: HEALTH_ISSUE_TITLE, state: 'open' },
    ]);
    deleted.methods.update.mockRejectedValueOnce({ status: 404 });
    const deletedResult = await publishHealthIssue({
      ...deleted,
      report: findingReport(),
    });
    expect(deletedResult).toEqual({ action: 'created', issueNumber: 42 });
    expect(deleted.methods.create).toHaveBeenCalledTimes(1);
  });

  it('creates the fixed label when it is missing', async () => {
    const fixture = publisher([]);
    fixture.methods.getLabel.mockRejectedValueOnce({ status: 404 });
    await publishHealthIssue({ ...fixture, report: findingReport() });
    expect(fixture.methods.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: HEALTH_ISSUE_LABEL }),
    );
  });
});
