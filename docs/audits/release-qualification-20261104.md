---
id: 'audit-release-qualification-20261104'
type: 'audit'
status: 'current'
visibility: 'internal'
projects: ['megamono']
topics: ['testing', 'dependencies', 'release']
summary: 'Release qualification follow-up'
date: '2026-11-04'
supersedes: null
references:
  [
    'spec-megamono-0000',
    'spec-megamono-0014',
    'spec-megamono-0003',
    'audit-tooling-dependencies-20261103',
  ]
external_references: []
standard: 'spec-megamono-0000'
---

# Release qualification follow-up

## Standard

The implementation and adoption contracts require bounded compatibility tests,
reproducible package distribution, and explicit release evidence. Governance,
static configuration, JavaScript exports, native builds, hosted CI, and release
admission are separate claims. This dated follow-up preserves the November 3
audit as historical evidence rather than replacing its measurements.

## Findings

### Advisory-provider disagreement

The [authoritative CVE record](https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2026/93xxx/CVE-2026-93753.json) marks CVE-2026-93753 as **REJECTED** on November 2,
2026, with the reason that it does not describe a security vulnerability. The
[GitHub advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) still has `withdrawn_at: null`, and npm's bulk endpoint still
returns GHSA-gcqx-w48m-w2h4 for deepmerge 4.3.1. The latest reviewed npm release is
still 4.3.1. These provider states are recorded separately in
[`deepmerge-advisory.evidence.json`](../../tools/deepmerge-advisory.evidence.json),
including response times, primary-source URLs, and raw-response hashes.

The fresh full npm audit on November 4 still exited 1: twenty-three low-severity
package entries propagated from this one advisory, with no moderate, high, or
critical findings. The snapshot records the command, npm/Node versions, lockfile
hash, raw-audit hash, and counts. CVE rejection did not change registry audit
output or repository release admission. No dependency patch, migration,
exception, threshold change, or version rename was introduced for this report.

The read-only `tooling:review-deepmerge` target inventories every direct lockfile
consumer and installed resolution. Five isolated object examples distinguish
returned-object prototype behavior from changes to `Object.prototype`; they do
not establish attacker reachability or a privilege boundary. Nine tests qualify
inventory/version drift, provider disagreement, malformed responses, network
failure without snapshot fallback, and the absence of file mutation. The default
review uses dated evidence; explicitly pass `--live` to refresh provider facts.
Neither mode performs release admission or replaces a full dependency audit.

### Packed distribution

Local macOS checks passed for actual localhost Verdaccio publication and clean
installation, resolving all nineteen generators and eleven executors, including
Expo Doctor. Packed Nx 24.0.4 consumers passed repeated adoption, generation,
inference, graph/check, and idempotence tests with TypeScript 6.0.3 and Node
24.22.1. The PHP consumer passed frozen installation, four application plans,
ignored native-output handling, and a Composer graph edge on Nx 24.0.4. It did
not install Composer packages or run native/device builds.

Those distribution runs spanned revisions `46d0ed2` and `75deb80` while another
agent had uncommitted generator tests. The production application generator was
still the former committed version. These results are bounded compatibility
evidence, not an immutable clean-revision release attestation or hosted CI.
The November 3 audit's nineteen-generator/ten-executor result remains accurate
for its earlier run.

### Expo generation findings

Actual packed-consumer execution exposed several failures that static governance
and unit tests had not established: Nx's initializer retained newer root React
versions in an SDK 54 application; generated Metro configuration discarded Expo's
monorepo defaults; hoisted test tooling could load the web app's React; and legacy
export dependency synchronization could rewrite the generated manifest and lock.
The generation changes isolate SDK runtime/build/test dependencies in the new app,
extend Expo's Metro configuration, anchor all React entrypoints to the app, and
use scoped maintained Nx inference. Existing root, web and mobile declarations
and configurations retain their ownership. Explicitly conflicting SDK policies
fail before generation instead of silently upgrading existing applications.

A separate test of the unconfigured default then found that the Nx initializer's
React 19.2.0 and SVG 15.12.1 choices did not match published Expo 56.0.24 metadata.
React Native 0.85.3 requires React ^19.2.3. Requirements now come from matching
installed public Expo JSON or integrity-verified public snapshots with manifest,
native-module, tarball and normalized-requirement hashes. Selection reads data;
it does not install packages or execute SDK modules.

After dependency alignment, SDK 56 installation passed, but actual Doctor still
rejected an obsolete `android.edgeToEdgeEnabled` field and the documented Hermes
V1 regression. The failed result is preserved rather than calling installation
success a passing application. Newly generated SDK 56+ configuration omits the
removed field; SDK 57+ also omits the obsolete `newArchEnabled` field caught by
its real Doctor check. The reviewed new-app default moves to Expo 57.0.31 with React
Native 0.86.3, which contains the documented memory and development startup
fixes described in the [SDK 57 changelog](https://expo.dev/changelog/sdk-57). Existing authored SDK policies are preserved. SDK 58 is available upstream
but has not been qualified by this work.

The unchanged explicit SDK 54 lane passed all thirteen checks after the metadata
change: Expo 54.0.38, React Native 0.81.5, mobile React 19.1.0, web React 19.2.5,
Nx 23.3.1, TypeScript 6.0.3, Node 24.22.1 and npm 11.19.1. Doctor passed 18/18;
web/iOS/Android exports, app-local React/JSX source maps, generated TypeScript
and the default Jest test passed. Existing declarations, generated configuration,
and the post-install manifest/lock were preserved. The export harness now retains
the inferred target's existing arguments, including `--clear`, when adding map
options; it no longer accidentally replaces that cache policy.

The default SDK 57 lane passed all eight stages in a fresh Linux ARM64 consumer
using the exact emitted Nx/@nx/expo 23.2.1 scaffold, Node 24.22.1 and npm 11.21.1.
Normal feature-branch adoption and the generator-owned npm install passed without
force or peer-dependency bypasses. Expo 57.0.31 resolved React Native 0.86.3 and
app React 19.2.3 while the web sibling retained React 19.3.1. Doctor passed 21/21;
actual web/iOS/Android JavaScript exports, native React/JSX map isolation,
generated TypeScript and default Jest all passed. The generated manifest, Metro
configuration and lockfile were unchanged by validation. All 388 packed payload
entries matched the shared source capture, despite different outer tarball hashes
from the fixture's deterministic repack.

A subsequent review caught one unexercised policy edge: a compatible broad Root
React Native range was being copied into the new app. The new app now pins the
exact SDK-selected native version while preserving the caller's range and the
existing conflict preflight. The focused ownership regression covers that case.
The metadata/application suites pass all sixty-four tests. SDK 53, 55 and 56
snapshot selection tests are not full runtime qualification of those lanes.

The clean Linux all-project run at `7aecc02` caught a separate distribution
parity failure: `create-megamono` bundled an older compatibility registry without
`expoSdks`. All 874 plugin tests and the other eight package suites passed, but
the existing bootstrap parity assertion failed and the run was retained as
failed. The maintained release-pin synchronizer now treats the plugin registry
as canonical and copies its complete content to bootstrap. Check mode rejects
copy drift without writing; the new regression adds SDK metadata without changing
package versions. The original whole-registry parity assertion stays intact.

### Evidence retention

The release and standalone release-qualification workflows now retain
`tmp/expo-consumer/` and `tmp/expo-default-consumer/` as artifacts on success or failure. This preserves the
per-stage logs, exact runtime/tool versions, package integrity, lockfile hash,
Doctor result, and bundle-isolation evidence alongside the aggregate release
log. YAML validation and all twenty-seven release-policy/admission tests passed.
The publishing job uploads Expo evidence after its public-npm consumer checks,
so a `next` release also retains the artifacts created after publication.

### Linux ancestry classification

An isolated Linux ARM64 run used a clean full-history checkout at `0a7aa59`,
Node 24.22.1, npm 11.21.1 and Debian Git 2.39.5. A cold frozen install, all
forty-two tooling tests, release checks, and all ten package builds passed. The
full lint/unit stage exposed a real health bug: when an intermediate Git object
is missing, that Git version can exit 1 with an error on stderr. The collector
had interpreted any exit 1 as proof that a branch was active.

Commit `5e81b76` retains Git diagnostics and accepts only a clean negative
ancestry result before classifying an active branch. Unknown process failures
are not treated as ordinary Git negatives. The existing test now verifies its
real missing-object diagnostic before checking classification; its assertions
were not skipped or weakened. All thirty-nine health tests, plugin compilation,
and lint passed on Linux with the fix.

A continuation at the committed fix also passed governance, documentation
validation and packed exports for all ten packages, finishing with a clean
checkout. Its fresh audit still returned the same single low advisory. These
are local Docker/Linux ARM64 results, not hosted GitHub Ubuntu AMD64 CI or native
execution. The failed baseline and successful follow-up logs are retained
separately rather than describing the failed run as green.

### Corrected committed Linux qualification

At `0978b5c8fd119bbe9acc161e48865b1d5908d6c5`, the clean full-history Linux
continuation verified that only the sync tool, its test and the generated
bootstrap registry changed from `7aecc02`. The committed lockfile was unchanged,
so it retained the hash-verified frozen install, forty-two tooling checks, all ten
builds, 874 passing plugin tests and eight other passing package suites from that
run. It did not describe the earlier failed all-project stage as green.

The corrected bootstrap build/lint and all 102 tests passed on Linux, as did all
twenty-eight release tests and the release policy check. Governance, documentation
and all ten packed package exports passed. Both permanent Nx Expo targets then
passed against the corrected committed source: SDK 54's thirteen checks and the
emitted Nx 23.2.1/default SDK 57 lane's eight checks. Identity metadata and all ten
packed exports were refreshed once more after the Expo build prerequisites;
the checkout finished clean. The retained audit still blocks admission with the
same twenty-three low entries; it was hash-verified from the unchanged graph,
not presented as a fresh audit at the corrected revision.

The adjacent [evidence record](release-qualification-20261104.evidence.json)
retains the exact source revisions, commands, runtime versions, per-check/log
hashes, failed full-run report and successful continuation, both final packed
consumer reports and lockfile hashes. This is local Docker Linux ARM64 evidence,
not hosted GitHub Ubuntu AMD64 CI or native/device/cloud qualification.

## Result

Registry audit admission remains blocked by the still-returned deepmerge
advisory. The provider disagreement requires upstream reconciliation or a
separately reviewed policy decision; this work does not approve an exception.
Native/cloud/device execution, authenticated application journeys, provider
recovery, and production admission remain the responsibility of their owning
repositories. No npm publication, GitHub push, or deployment was performed.
