import type { diagnoseArtifacts } from './artifact-diagnostics.js';

export interface FeedbackContext {
  readonly command?: string;
  readonly error?: string;
  readonly exitCode?: number;
}

export interface FeedbackSubmissionResult {
  readonly id?: string;
  readonly url?: string;
}

export const FEEDBACK_HELP = `Usage: megamono feedback [--json] [--packages=<names>]
       [--yalc-store=<directory>] [--source-root=<repository>]

Create a redacted artifact report for manual review, sharing, or submission.
Includes package identities, artifact hashes, location categories and finding counts.
Omits paths, raw errors, dependency URLs, arbitrary build metadata and source text.
No feedback is submitted unless --submit is explicitly provided. Submission
requires hosted authentication and uses the configured Megamono service.

Options:
  --description=<text>  Explain what happened and what you expected
  --from-error          Include the pre-populated command/error context
  --command=<text>      Command that failed (normally supplied by the CLI)
  --error=<text>        Sanitized failure message (normally supplied by the CLI)
  --exit-code=<number>  Exit code associated with the failure
  --submit              Submit to the authenticated Megamono service
  --json                Print the complete redacted payload
  --packages=<names> --yalc-store=<directory> --source-root=<repository>

Without --submit, this remains a local report. Nothing is installed, executed,
or written by the command. User descriptions are included as supplied; review
them before submitting.`;

const hash = (value: unknown, pattern: RegExp) =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

export function sanitizeFeedbackText(value: string, limit = 2_000): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(
      /([?&](?:token|secret|password|api[_-]?key|code)=)[^&\s]+/gi,
      '$1<redacted>',
    )
    .replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi, '$1<redacted>@')
    .replace(/\b(?:\/Users\/[^\s/]+|\/home\/[^\s/]+)\//g, '<home>/')
    .slice(0, limit);
}

export function feedbackCommand(context: FeedbackContext): string {
  const quote = (value: string) =>
    `'${sanitizeFeedbackText(value, 600).replaceAll("'", "'\\''")}'`;
  const command = context.command ? ` --command=${quote(context.command)}` : '';
  const error = context.error ? ` --error=${quote(context.error)}` : '';
  const exitCode =
    typeof context.exitCode === 'number'
      ? ` --exit-code=${context.exitCode}`
      : '';
  return `megamono feedback --from-error${command}${error}${exitCode}`;
}

/** Allowlist projection: never forward diagnostics objects or raw messages. */
export function redactedFeedback(report: ReturnType<typeof diagnoseArtifacts>) {
  return {
    schemaVersion: 1,
    kind: 'megamono-feedback',
    comparisonScope: 'manifest-and-dist',
    packages: report.packages.map((entry) => ({
      name: entry.name,
      findingCount: entry.findings.length,
      locations: entry.locations.map((location) => {
        const build =
          location.build && typeof location.build === 'object'
            ? (location.build as Record<string, unknown>)
            : {};
        return {
          kind: location.kind,
          status: location.status,
          // Keep common release labels but exclude arbitrary build metadata.
          version: hash(
            location.version,
            /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/,
          ),
          digest: hash(location.digest, /^[a-f0-9]{64}$/),
          revision: hash(build.revision, /^[a-f0-9]{40,64}$/),
          buildId: hash(build.buildId, /^(?:sha256:)?[a-f0-9]{16,64}$/),
          dirty: typeof build.dirty === 'boolean' ? build.dirty : undefined,
        };
      }),
    })),
    limitations: [
      'Review package names and hashes before sharing or submitting this report.',
      'Paths, raw errors, environment/configuration values, source text and arbitrary metadata are omitted.',
      'Finding counts describe diagnostic review needs, not runtime qualification or a required upgrade.',
      'Root consumer inventory only. Use explicit verify artifacts selections to check nested consumers.',
      'No reproduction, provider calls, package installation or runtime tests were performed.',
    ],
  };
}

export function createFeedbackPayload(options: {
  readonly report: ReturnType<typeof redactedFeedback>;
  readonly description?: string;
  readonly context?: FeedbackContext;
}) {
  return {
    ...options.report,
    schemaVersion: 1,
    type: 'megamono.cli.feedback',
    description: options.description
      ? sanitizeFeedbackText(options.description)
      : undefined,
    context: options.context
      ? {
          command: options.context.command
            ? sanitizeFeedbackText(options.context.command)
            : undefined,
          error: options.context.error
            ? sanitizeFeedbackText(options.context.error)
            : undefined,
          exitCode: options.context.exitCode,
        }
      : undefined,
    report: options.report,
  };
}
