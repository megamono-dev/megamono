# Deepmerge release admission review — November 13, 2026

## Decision and expiry

Accept **GHSA-gcqx-w48m-w2h4 only**, at **low** severity, for
**deepmerge 4.3.1** used exclusively as a development dependency through
`jest-config`, `fork-ts-checker-webpack-plugin`, or
`@rollup/plugin-node-resolve`. The exception is recorded in
[`security-audit-exception.json`](../../tools/security-audit-exception.json).
It expires **December 13, 2026 at 00:00 UTC**. Maintainers must remove or
explicitly review and renew it before further admission after that date.

This is a bounded acceptance of the registry finding, not a dependency patch,
an upstream withdrawal, or a claim that the merge behavior cannot affect a
caller. No dependency version, package artifact, or low-severity threshold is
changed. This repository's exception is not added to generated workspaces or
published package dependencies.

## Evidence

The November 13 release run
[`43481220285`](https://github.com/megamono-dev/megamono/actions/runs/43481220285)
stopped at the full-workspace audit before versioning or publishing. A fresh
pnpm 11.28.9 audit returned one low advisory across 1,652 dependencies, with no
moderate, high, or critical findings. Its raw JSON SHA-256 was
`fbac2ef869b0cff7ef06f35f003813834e1a62ccb4f12bf655214b8f4842a7a3`.

Primary providers were refreshed at **18:57 UTC on November 13**:

| Provider                                                                                                                          | Result                                                                                                          | Raw response SHA-256                                               |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [CVE assigning authority record](https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2026/93xxx/CVE-2026-93753.json) | CVE-2026-93753 rejected November 2; the assigning authority says it does not describe a security vulnerability. | `99aac8731934595bfb682e0acca0bb6812dcc12b00a6201a5bd44cb10e1d8499` |
| [GitHub advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)                                                              | Active, low severity, no patched version.                                                                       | `129678c2a239966df96de51652fed82705e52bf32828c008c5a37e0bce39bf78` |
| [npm latest metadata](https://registry.npmjs.org/deepmerge/latest)                                                                | Latest remains 4.3.1.                                                                                           | `e59831a9bf2293e70f9c296253e7fad50116bc5bbea8078bcb2e3a1486014da0` |
| [npm bulk advisory endpoint](https://registry.npmjs.org/-/npm/v1/security/advisories/bulk), POST `{"deepmerge":["4.3.1"]}`        | Still returns this low advisory.                                                                                | `868d602c806d21019470fb54bb7cd977799f2cb9fc425325385d1ae8fcc36cb8` |

These responses match the bytes in the existing
[November 4 evidence snapshot](../../tools/deepmerge-advisory.evidence.json).
The CVE rejection and npm/GitHub status are separate facts; the rejection did
not clear the registry finding.

## Scope and residual behavior

The installed-resolution review finds three direct deepmerge consumers:
`jest-config@30.5.2`, `fork-ts-checker-webpack-plugin@9.1.0`, and
`@rollup/plugin-node-resolve@15.3.1`. All resolve the same 4.3.1 artifact.
The audit classifies its affected paths as development-only. These consumers
merge test, compiler, and bundler configuration. Workspace configuration
already has code execution privileges; the bounded acceptance does not cover
merging untrusted request data or application authorization state.

The retained `tooling:review-deepmerge` probes reproduce inherited properties
on returned objects for null placeholders, null-prototype targets, and own
`__proto__` keys. The global `Object.prototype` remains unchanged in those
probes. Neither result proves universal safety or exploitability. The review
and its regression tests are preserved unchanged.

## Enforcement

`pnpm run security:audit` runs the full pnpm JSON audit against public npm,
retains its raw output, and evaluates every returned advisory. CI and release
qualification use this same command. No advisory is added to pnpm's global
ignore list, and there is no `--ignore-unfixable`, production-only audit,
raised threshold, or registry-error bypass.

The child audit removes inherited npm/pnpm configuration environment variables
and explicitly selects all dependency classes. This matters because pinned
pnpm 11.28.9 accepts environment settings that can narrow the audit to
production dependencies or a single workspace importer while returning a
self-consistent empty report. Hostile production and project-filter settings
are covered by the qualification probes. Standard proxy environment variables
are preserved.

pnpm can truncate the paths listed for an advisory, so the gate also inspects
every direct deepmerge edge in the lockfile. Only the three consumer versions
listed above are accepted; new direct workspace imports, consumer upgrades,
unknown consumers, or changed deepmerge resolutions require review even when
the changed path is absent from the audit's displayed paths.

The accepted finding is printed separately with its expiry and this decision
reference. Admission fails on other low-or-higher advisories, increased
severity, changed package/version, production use, an unreviewed direct
consumer, a published fix, or expiry. Invalid JSON, registry/CLI failure,
incomplete reports, and inconsistent report counts or exit codes also fail.
The audit remains a registry finding with an exception; it is not reported as
zero vulnerabilities.

Review or remove this exception as soon as upstream publishes a fix, the
providers change their assessment, the tooling paths change, or a relevant
runtime use is introduced. The older qualification notes describe the prior
blocked state and are historical evidence; this decision supersedes their
deepmerge admission status only.

## Validation

- `pnpm run release:test`: 38 passing tests, including the audit policy,
  expiry, changed findings, malformed responses, inherited settings, and
  lockfile consumer drift.
- `pnpm run release:check`: all ten public packages pass release policy and
  compatibility-pin checks.
- `pnpm exec nx run @megamono/workspace:tooling-review-deepmerge`: installed
  inventory and bounded behavior review pass with all three known consumers.
- Fresh `pnpm run security:audit`: passes admission with one explicit low
  exception, auditing all 1,652 dependencies, including 1,455 development
  dependencies. A second live run with hostile production and project-filter
  environment settings returns the same scope and decision.
- Formatting and whitespace checks pass. No package publication or full
  platform-consumer qualification was performed for this audit-policy change.
