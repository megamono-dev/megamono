import type { diagnoseArtifacts } from './artifact-diagnostics.js';

export const FEEDBACK_HELP = `Usage: megamono feedback [--json] [--packages=<names>]
       [--yalc-store=<directory>] [--source-root=<repository>]

Print a local, redacted JSON artifact report for manual review and sharing.
Includes package identities, artifact hashes, location categories and finding counts.
Omits paths, raw errors, dependency URLs, arbitrary build metadata and source text.
Never submits feedback, installs packages, executes inspected packages or writes files.
Exit 0 means the report was produced, not that the artifacts are qualified.
Review the output before attaching it to an issue; names and hashes remain visible.`;

const hash = (value: unknown, pattern: RegExp) =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

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
      'Local report only; nothing was submitted. Review package names and hashes before sharing.',
      'Paths, raw errors, environment/configuration values, source text and arbitrary metadata are omitted.',
      'Finding counts describe diagnostic review needs, not runtime qualification or a required upgrade.',
      'Root consumer inventory only. Use explicit verify artifacts selections to check nested consumers.',
      'No reproduction, provider calls, package installation or runtime tests were performed.',
    ],
  };
}
