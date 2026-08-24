import type { RepositoryHealthReport } from './health';

export const HEALTH_ISSUE_TITLE = 'Megamono repository health';
export const HEALTH_ISSUE_LABEL = 'megamono:health';

interface RepositoryContext {
  readonly repo: { readonly owner: string; readonly repo: string };
}

interface IssueRecord {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly locked?: boolean;
  readonly pull_request?: unknown;
}

interface IssueResponse {
  readonly data: IssueRecord;
}

interface IssueMethods {
  readonly listForRepo: unknown;
  getLabel(input: Record<string, unknown>): Promise<unknown>;
  createLabel(input: Record<string, unknown>): Promise<unknown>;
  update(input: Record<string, unknown>): Promise<IssueResponse>;
  create(input: Record<string, unknown>): Promise<IssueResponse>;
}

interface GithubClient {
  paginate(
    method: unknown,
    input: Record<string, unknown>,
  ): Promise<readonly IssueRecord[]>;
  readonly rest: { readonly issues: IssueMethods };
}

interface ActionsSummary {
  addRaw(value: string): ActionsSummary;
  write(): Promise<unknown>;
}

interface ActionsCore {
  readonly summary: ActionsSummary;
}

export interface HealthIssuePublishResult {
  readonly action: 'none' | 'closed' | 'updated' | 'created';
  readonly issueNumber?: number;
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { readonly status?: unknown }).status)
    : undefined;
}

export function renderHealthIssueBody(report: RepositoryHealthReport): string {
  const body = ['# Megamono repository health', ''];
  for (const check of [
    ...new Set(report.findings.map(({ check }) => check)),
  ].sort()) {
    body.push('## ' + check, '');
    for (const finding of report.findings.filter(
      (candidate) => candidate.check === check,
    )) {
      body.push('- **' + finding.state + '** ' + finding.summary);
      body.push('  - Fingerprint: `' + finding.fingerprint + '`');
      body.push('  - Confidence: ' + finding.confidence);
      for (const evidence of finding.evidence)
        body.push('  - Evidence: ' + evidence);
      if (finding.recommendation)
        body.push('  - Recommendation: ' + finding.recommendation);
    }
    body.push('');
  }
  if (report.intentional.length > 0) {
    body.push('<details>', '<summary>Intentional divergences</summary>', '');
    for (const suppression of report.intentional) {
      body.push(
        '- ' + suppression.check + ': `' + suppression.fingerprint + '`',
      );
      body.push('  - Decision: ' + suppression.decision);
      if (suppression.expires_at)
        body.push('  - Expires: ' + suppression.expires_at);
    }
    body.push('', '</details>', '');
  }
  return body.join('\n');
}

export async function publishHealthIssue(options: {
  readonly github: GithubClient;
  readonly context: RepositoryContext;
  readonly core: ActionsCore;
  readonly report: RepositoryHealthReport;
}): Promise<HealthIssuePublishResult> {
  const { github, context, core, report } = options;
  const repository = {
    owner: context.repo.owner,
    repo: context.repo.repo,
  };
  try {
    await github.rest.issues.getLabel({
      ...repository,
      name: HEALTH_ISSUE_LABEL,
    });
  } catch (error) {
    if (errorStatus(error) !== 404) throw error;
    await github.rest.issues.createLabel({
      ...repository,
      name: HEALTH_ISSUE_LABEL,
      color: '8250df',
      description: 'Megamono deterministic repository health findings',
    });
  }

  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repository,
    state: 'all',
    labels: HEALTH_ISSUE_LABEL,
  });
  const matching = issues.filter(
    (candidate) =>
      candidate.title === HEALTH_ISSUE_TITLE && !candidate.pull_request,
  );
  const issue =
    matching.find((candidate) => !candidate.locked) ?? matching.at(0);
  const hasOutput = report.findings.length > 0 || report.intentional.length > 0;
  if (!hasOutput) {
    if (issue?.state === 'open' && !issue.locked) {
      await github.rest.issues.update({
        ...repository,
        issue_number: issue.number,
        state: 'closed',
      });
      return { action: 'closed', issueNumber: issue.number };
    }
    return { action: 'none', ...(issue ? { issueNumber: issue.number } : {}) };
  }

  const request = {
    ...repository,
    title: HEALTH_ISSUE_TITLE,
    body: renderHealthIssueBody(report),
    labels: [HEALTH_ISSUE_LABEL],
  };
  if (issue && !issue.locked) {
    try {
      await github.rest.issues.update({
        ...request,
        issue_number: issue.number,
        state: 'open',
      });
      return { action: 'updated', issueNumber: issue.number };
    } catch (error) {
      if (![404, 410].includes(errorStatus(error) ?? 0)) throw error;
    }
  }
  const created = await github.rest.issues.create(request);
  await core.summary
    .addRaw('Created health issue #' + created.data.number + '.')
    .write();
  return { action: 'created', issueNumber: created.data.number };
}
