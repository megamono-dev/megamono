---
id: 'audit-tooling-dependencies-20261103'
type: 'audit'
status: 'current'
visibility: 'internal'
projects: ['megamono']
topics: ['dependencies', 'release', 'testing']
summary: 'Tooling dependency remediation and release qualification'
date: '2026-11-03'
supersedes: null
references: ['spec-megamono-0000']
external_references: []
standard: 'spec-megamono-0000'
---

# Tooling dependency remediation and release qualification

## Standard

The implementation contract requires explicit compatibility ranges, packed
consumer qualification, and release evidence from the repository that owns the
release. A passing dependency scanner or ordinary compatibility fixture does not
establish that a vulnerable execution path is reachable, that an advisory is
remediated, or that an application is ready for production.

This review concerns Megamono's development and package-authoring tools. The
Flightpaths SDK production-only audit cited in the incoming feedback is separate
evidence about another repository; its zero-finding result is not attributed to
Megamono or treated as current release approval.

## Findings

### Nx 24 adoption

Packed core/inference and Laravel/NativePHP consumers passed on Nx 24.0.4 without
forcing peer dependencies. The core fixture exercises repeated adoption,
database generation, target metadata, TypeScript consumption, and graph/check
behavior. The PHP fixture exercises a frozen npm install, four application
plans, ignored native output, and a Composer dependency edge. It does not run
Composer installation, native builds, or devices. Twenty-nine focused planning
and preflight tests also passed.

The adoption range now includes Nx 24, with a blocking Linux CI anchor added to
the existing Nx 17–23 matrix. PHP plugins retain their narrower Nx 22 floor.
New-workspace scaffolds remain on their existing deterministic Nx 23 baseline.
These are local macOS results; the changed Linux matrix still needs to run on
the committed revision.

### Magicast's bundled source-map-js

Magicast 0.5.5 still contains an embedded source-map-js 1.2.1 implementation even
when npm separately installs 1.2.2. Updating or overriding that external package
alone cannot replace the embedded bytes.

The repository now pins both packages and applies a local, version- and
SHA256-guarded externalization during `npm ci` postinstall. The complete embedded
implementation and its generated namespace shim are removed, and Magicast
imports source-map-js 1.2.2 instead. The patch downloads nothing, rejects unknown
artifacts and versions, verifies its complete output hash, and is idempotent.
Published tarball integrities and transformation provenance are recorded in
`tools/magicast-bundle.provenance.json`.

Seven ordinary qualification tests passed, including original-artifact integrity,
unknown-byte/version refusal, path safety, atomic-write collision preservation,
parse/edit/generate behavior, source-map round-tripping, and a real Vitest V8
coverage threshold update. Module-resolution tracing verifies that the coverage
process uses the patched Magicast and external 1.2.2 dependency. These tests do
not claim attacker-controlled source-map reachability or an application exploit.
The patch affects this repository's installed tools; it is not an upstream
Magicast release or a dependency override distributed to adopted projects.
An isolated full `npm ci` also passed and applied the patch automatically. The
same seven tests passed in that clean checkout with the explicit tarball override
unset and a writable copy of npm's existing immutable cache entry. The writable
cache avoids this agent sandbox's restrictions on user-cache temporary files;
no original package bytes were fetched or substituted for that cache-path check.

### Remaining minimatch paths

`tools/minimatch-tooling-review.mjs` reports the lockfile's direct consumer edges,
actual installed resolutions, and bounded legacy API evidence. Nx and Verdaccio
call `makeRe`; the Rollup dependency uses an older glob implementation with
RegExp-shaped matcher state. Minimatch 11 removes these contracts.

The reviewed current Nx 24.0.4 still depends on minimatch 10.2.5. Supported
maintenance releases of minimatch 3, 5, 9, and 10 remain below the advisory's
patched version, 11.0.1. A blanket major override is not qualified, and a local
maintenance backport would remain version-flagged without a separate explicit
advisory decision. No override, audit exclusion, or exception was added for this
finding.

### Glob and deepmerge

The fresh registry audit also reports the glob AbortSignal cancellation advisory
and the existing low-severity deepmerge finding. Glob's patched version starts
at 14.0.2; there is no patched 10.x or 13.x maintenance release in the reviewed
registry metadata. The affected Jest and test-exclude consumers use public APIs
retained by glob 14. Version-qualified overrides now select glob 14.0.3 for
`@jest/reporters@30.5.2`, `jest-config@30.5.2`, `jest-runtime@30.5.2`, and
`test-exclude@7.0.2`. Three consumer fixtures passed: actual resolutions,
TestExclude sync/async include/exclude behavior, and a real Jest CLI run covering
project discovery, sibling-extension diagnostics, and glob-based coverage
thresholds. The same behavioral fixtures also passed before the migration.
Rollup's glob 8 is outside this cancellation advisory and is preserved, although
its minimatch dependency remains part of the separate minimatch finding.

Deepmerge's latest reviewed version is 4.3.1 and the advisory lists no patched
version. Neither an unsupported downgrade nor a severity exclusion is used to
declare it resolved.

The post-migration npm audit no longer reports the glob cancellation advisory.
It reports two underlying advisories: minimatch (moderate) and deepmerge (low),
with zero high or critical findings. npm's propagated package totals are 71
reports (67 moderate, 4 low), compared with 70 before the migration (68 moderate,
2 low). These totals describe affected package entries, not independent bugs;
the underlying advisory count changed from three to two. The adjacent
[evidence snapshot](tooling-dependencies-20261103.evidence.json) records both
summaries, raw-report hashes, installed resolutions, and upstream metadata
provenance. No clean-audit result is claimed.

Primary references:

- [Minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- [Minimatch 11 API changes](https://github.com/isaacs/minimatch/blob/v11.0.1/changelog.md)
- [Glob cancellation advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)
- [Deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
- [Magicast's declared bundled dependencies](https://github.com/unjs/magicast/blob/v0.5.5/package.json)

## Result

Nx 24 adoption, the local Magicast repair, and the scoped glob migration have
passed their bounded consumer checks. All thirty workspace lint/test/build
targets passed after the migration. Minimatch and deepmerge
remain open tooling findings; no audit all-clear or production approval is given.

The release qualification runner now verifies the installed tooling artifact,
runs the tooling fixtures, and audits all dependency classes at the low-severity
threshold before proceeding. Audit/network failures stop admission. Three
failure-injection tests verify that artifact, fixture, and audit failures each
stop the runner before builds or package-consumer qualification. No advisory
exclusion or automatic dependency rewrite is used to admit a release.

Linux CI on the final commit, complete package-distribution gates, authenticated
application journeys, provider/recovery checks, and deployment admission remain
required in their owning repositories. No packages were published, deployments
performed, hosted services accessed, or application lifecycle approvals changed
by this work.
