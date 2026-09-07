# `@megamono/plugin`

Nx generators, executors, and ESLint rules for Megamono workspaces. The package
implements versioned workspace configuration, documentation lifecycle tooling,
repository structural checks, and deterministic repository health reporting.

## Initialize an existing workspace

```sh
npm exec nx g @megamono/plugin:workspace-init --defaultPlatform=node
```

For a mature mixed workspace, survey first and resolve only genuine ambiguity:

```sh
npm exec nx g @megamono/plugin:workspace-init --survey --format=json
npm exec nx g @megamono/plugin:playstack-integrate --packages=@playstack/rate-limit --api=apps/api --dry-run
npm exec nx g @megamono/plugin:workspace-init --profile=pilot --dry-run
npm exec nx g @megamono/plugin:workspace-init \
  --only=docs,agents,ci,lint \
  --adoptionMap=.megamono/adoption.json \
  --docsAdoptionMap=.megamono/docs-adoption.json \
  --ciMode=auto \
  --yes
```

Playstack integration manifests remain package-owned. The generator validates
the full published JSON schema, manifest package version, and every ejectable template hash, maps each
surface into an explicit Nx root, and records application-owned output. Existing
composition roots change only through an explicitly reviewed `--composition`
connection. Conditional requirements are resolved
with `--adapters`, `--persistence`, and an exact JSON `--conditions` map;
package-authored decisions use `--decisions`. Migration work records
`--adoptionMode=fresh|compare|shadow|cutover` and emits one suggested commit
boundary per package integration:

```sh
npm exec nx g @megamono/plugin:playstack-integrate \
  --packages=@playstack/nest-auth,@playstack/nest-billing,@playstack/webhooks \
  --api=apps/api \
  --persistence=application \
  --adoptionMode=shadow \
  --conditions='{"Stripe is selected":true}' \
  --decisions='{"auth.transport":"cross-origin-refresh-cookie","auth.sessionProjection":"newsbetters-session","billing.priceCatalog":"newsbetters-plans","webhooks.providers":"stripe:default"}' \
  --dry-run
```

Dry runs surface unresolved decisions, inactive conditions, duplicate manifest
requirements, occupied targets, and existing route/provider/environment/config
references. An accepted write still fails closed until every required condition
and decision has an explicit value.

Selected roots must be existing Nx projects. Static Nest controller/method
decorators are composed for route collision checks, including aliased imports;
dynamic declarations require manual review. These checks do not replace an
application build or endpoint integration tests. Dedicated persistence/phase
options cannot contradict package decision values. Re-running preserves
formatting-equivalent output, while substantive user edits remain fail-closed.

Integration plans also report installed artifact/manifest hashes, internal
dependency closure and peer versions. Runtime changes at the same package version
invalidate migration evidence. A stale installed copy relative to the consumer's
`.yalc` payload blocks generation; a newer same-version Yalc store is reported
without silently adopting it. Refresh dependencies explicitly before continuing.

For mature application wiring, `--equivalences` is a reviewed JSON map:
environment requirement keys map to variable names; declared module/provider
symbols map to `existing:libs/example/src/module.ts#ExportedModule`; and
`package:integration:template` keys can map to `existing:<file>` to reuse that
file instead of generating a duplicate. The referenced keys/files/exports are
validated. Environment mappings record bindings without rewriting arbitrary
template code. These mappings are declarations of application ownership, not
automatic proof of behavioral equivalence.

`--verification` maps every active `package:integration:test` ID from the plan to
an existing `project:target`; `--verificationProject` selects the project for a
`playstack-verify` aggregator. Optionally pass both `--ciWorkflow` and `--ciJob`
to append one reviewed verification step to an existing GitHub workflow job.
No installation, release, signing, or deployment steps are replaced.

The persistent `.megamono/playstack-integrations.json` ledger tracks each
integration independently. `--adoptionMode` remains advisory; actual recorded
transitions use `--migrationStages` with a JSON `package:integration` map. Start
with `{ "stage": "compare" }`. Moving to shadow/cutover/rollback also requires
`verificationReport` and `rollbackPlan` workspace file paths. The JSON report
must contain `schemaVersion: 1`, the `integration` key, the current plan's
`fingerprint`, the target `stage`, `result: "passed"`, and a nonempty `checks`
array covering all required test IDs. These are application-reviewed
attestations: the generator records their digests but never executes a traffic
cutover, database migration, or rollback. Invalid transitions fail before writes.

### Application migration contract gates

Use `--migrationContracts` to supplement package manifests with reviewed
application acceptance requirements. Keys are active `package:integration` IDs
from the survey/plan (do not guess them); values select one or more profiles:

| Profile                   | Required proof before shadow/cutover                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue-jobs`              | Producer/worker payload, envelope, job ID and Redis-prefix compatibility; scheduler, delayed/retried job and drain/recovery tests against a real queue. Queuebert monitoring checks alone do not qualify. |
| `application-persistence` | Implemented adapter behavior, uniqueness/tenant isolation and injected physical-transaction rollback against a real database. Generated throwing stubs or a typecheck do not qualify.                     |
| `auth-policy`             | Real-database session policy tests for reviewed expiry, session caps, replay/grace and membership; transport security tests including SSO where enabled. Policy values remain application-owned.          |
| `billing-cutover`         | Real-database projection comparison plus single-writer authority and rollback tests. Comparison is not authorization to enable a second writer. Marketplace policy remains application-owned.             |

For example, `--migrationContracts='{"@playstack/queues:nest-queues":["queue-jobs"]}'`
is valid only when that exact integration appears in the selected plan. Review
the emitted `migrationContracts` descriptions, `requiredTests`, and
`qualification` before mapping **every** test ID through `--verification`.
The existing verification aggregator and optional reviewed CI step include these
tests; existing deployment/release gates remain untouched.

Profiles are opt-in and do not change existing fingerprints when omitted.
For selected profiles, a requested shadow/cutover adoption mode (including a
package's `.adoptionMode` decision) must match the qualified ledger stage before
files can be written. A dry run shows the mismatch as a preflight conflict.
Selected profile tests and environment requirements participate in the integration
fingerprint. `--qualification` may add environments, but cannot weaken profile
minimums. `real-queue` means an actual queue backend, including a disposable local
Redis-backed queue—not an in-memory fake or a dashboard assertion.

Profile-qualified shadow/cutover/rollback transitions require schemaVersion 2
receipts with source revision, runtime versions and passed checks matching each
required ID, kind and environment. Every required passed check must reference
nonempty application-owned evidence using `{ "path": "reports/test.log",
"sha256": "<64-character SHA-256>" }`; the generator verifies those file hashes.
A matching reviewed rollback file is still required. Skipped tests, stale files,
compile-only substitutes and legacy passed-label receipts cannot satisfy these
gates. These remain reviewed attestations, not automatic certification of test
content, a scan proving adapters complete, or execution of a traffic cutover.

Fontstack-style adoption can therefore proceed with governance and infrastructure
while keeping identity/account and queue/billing cutovers separately gated.
Select native Playstack contracts directly when appropriate; application-owned
persistence and legacy migration scaffolds are not mandatory for prelaunch apps.

Shared Nest composition is opt-in with `--composition='<json>'`:

```json
{
  "project": "playstack-platform",
  "modules": [
    {
      "file": "libs/platform/playstack/src/auth/auth.module.ts",
      "export": "AuthModule"
    }
  ],
  "connect": {
    "file": "apps/api/src/app/app.module.ts",
    "module": "AppModule",
    "importPath": "@my-org/playstack-platform"
  }
}
```

Create the library using the workspace's normal Nx library generator first, so
its package-manager registration, TypeScript references, and build configuration
remain correct for that workspace. The import path must already identify that
library. Selected Nest templates are emitted into this library; configured
modules must be explicitly selected and directly exported with static `@Module`
metadata. The shared module and barrel are generated there, and the optional
connection adds a single AppModule import without replacing its existing metadata.
Dynamic AppModule imports and identifier collisions require manual review.
The migration ledger binds the reviewed composition project, module selections,
and AppModule connection. Changing them during shadow or cutover requires rolling
back the previous contract first, just like changing a package integration.
Generated root hashes permit pristine updates, while edited roots fail closed.
Provider registration arguments are never guessed from package export names.

Named adoption profiles are shortcuts over the same independent modules:
`minimal` selects project boundaries and health; `pilot` adds platform
inference without claiming repository CI or release workflows; `platform` adds
CI and release management; and `full` selects every governance module.
`--profile` and `--only` are mutually exclusive. Every plan groups the selected
modules into suggested commit batches without running Git or committing on the
caller's behalf.

The survey includes a versioned `inventory`, plus
`adoptionTemplates.projects`, `adoptionTemplates.documentation`, and
`adoptionTemplates.render`. Inventory
v1 is Nx-project-aware: it records nested framework/router evidence, imported
external packages, environment-variable names (never values), Prisma schema
contexts, Redis/BullMQ usage, and Docker/Render deployment markers. Ambiguous
or dashboard-owned topology remains an explicit finding instead of becoming a
guessed configuration. Copy the relevant project or documentation template
into a workspace file, replace any `<review-…>` placeholders, and pass that
file with `--adoptionMap` or `--docsAdoptionMap`; pass the reviewed Render map
inline as described below.

Package-manifest Nx projects are included; `project.json` is not required.
Shared Worker libraries can be classified from an explicit
`@cloudflare/workers-types` entry in their local TypeScript configuration.
Names such as `workers-shared` alone are not platform evidence: review their
type/platform through the adoption map when configuration is inconclusive.
Browser-specific extension manifests and package-authored
`megamono.extension.manifests` declarations are also recognized without WXT.
Render service mappings remain reviewed decisions even when command evidence
suggests a project. The Basemarks-shaped regression fixture exercises these
cases while preserving repository-owned CI, release gates, and unrelated files.

When a repository-owned `render.yaml` is present, the inference module installs
`@megamono/nx-render`. That plugin attaches only explicitly rooted or mapped
services, preserves the Blueprint as deployment authority, and exposes bounded
build/start/pre-deploy targets plus health, resource, filter, and multi-instance
Next cache diagnostics. For a root-level service, the survey identifies exact
Nx project references in declared commands and proposes a copy-ready map; init
still requires the reviewed `serviceProjects` value through
`--renderServiceProjects='<json>'` and validates its project/root pairs before
updating `nx.json`.

On a real workspace, the same survey also separates committed toolchain
requirements from active Node and package-manager binaries. It reports whether
the host is mutation-ready and gives Corepack or repository-pin activation
guidance when it is not.

The packed mixed-platform adoption fixture exercises this flow against the Nx
22.2/TypeScript 5.9/pnpm 11 portfolio anchor used by established repositories:

```sh
npm exec nx -- run @megamono/plugin:e2e-portfolio-compatibility
```

Initialization writes `megamono.json`, adds the `megamono` and
`megamono-docs` projects, tags existing Nx projects, scaffolds the documentation
information architecture, and configures the shared agent-skills directory.
It also wires `@megamono/plugin/eslint` into the workspace flat config and emits
the scheduled repository-health issue workflow.

The plan preflights selected-module dependencies and peers before writing. It
retains compatible existing ranges, lists missing dependencies individually,
and refuses incompatible, duplicate, or non-semver declarations instead of
silently upgrading an adopted workspace.

## Verify a production runtime

Workspace initialization adds a generic `megamono:verify-runtime` target. It
inspects an existing JavaScript build and fails when an external package is
undeclared or available only through `devDependencies`:

```sh
npm exec nx -- run megamono:verify-runtime --project=api
npm exec nx -- run megamono:verify-runtime --project=api \
  --outputPath=dist/apps/api \
  --report=.megamono/runtime-api.json
```

The verifier never builds or changes dependencies implicitly. Build the project
first, and provide `--outputPath` when its build target does not declare one.
Extraction parses JavaScript syntax; quoted examples, comments, regex literals,
and locally shadowed `require` calls are not external dependencies. Static
imports/re-exports, global CommonJS `require`, Node `createRequire` bindings,
their `require.resolve` calls, and literal dynamic imports are
inspected, including executable expressions inside template literals. Malformed
JavaScript, non-literal module loads, or an empty output directory produce
`runtime-analysis-incomplete` errors, never a passing zero-file report. No audited
code is executed. This is bounded static analysis, not proof of production
resolution: custom loaders, evaluated code and dependency aliases still require
bundler/runtime evidence and a clean deployment install. Keep it advisory while
qualifying a repository's actual emitted output; do not suppress all missing
dependency findings to work around an unsupported loader.

The companion workspace audit checks pnpm/Corepack pins, active Node and pnpm,
workspace package membership, and known executables or preload modules used by
scripts:

```sh
npm exec nx -- run megamono:verify-dependencies
```

This catches dependencies supplied only by a sibling package or an accidentally
hoisted installation while leaving dependency correction to the repository.

Container definitions can be checked independently for frozen installs,
copied lock/workspace manifests, build stages, and a production dependency
installation:

```sh
npm exec nx -- run megamono:verify-container --dockerfile=apps/api/Dockerfile
```

The default check only reads the Dockerfile. Pass `--smoke` explicitly to run
`docker build` with the selected `--context`; Megamono never starts the built
container or performs an image build as part of the ordinary health check.
The adoption survey also maps nested Dockerfiles to their owning Nx project and
uses exact Nx command references for root Dockerfiles. Ambiguous container
ownership stays visible as a decision rather than becoming a guessed target.

## Generator availability

`@megamono/plugin/availability.json` is the canonical registry for available,
fixture-gated, and reserved generator names. The published `generators.json`
and `executors.json` collections are produced with:

```sh
npm exec nx -- run plugin:sync-collections
```

Only entries marked `available` are emitted. Programmatic callers can use
`getGeneratorAvailability` or `assertGeneratorAvailable` to return the stable
gate diagnostic for a gated or reserved name.

The published `content-lib` and `content-type` generators scaffold an internal
content-data project, generated-import path, cached build target, Playstack
transforms, and deterministic schema-backed document types. Their packed
Free-tier fixture consumes `@playstack/content` through yalc, builds the
generated project under npm and pnpm, and verifies stable reruns.

The published `playstack-lint` and `playstack-skills` generators follow the
same ownership rule. Lint adds the selected Playstack preset in warning mode;
skills installs the compatible CLI and corpus packages, then delegates all
file ownership, drift, and synchronization to `playstack skills sync`. Their
packed cross-repository fixture consumes Playstack through yalc and verifies
local-reference preservation, real lint and skill execution, ownership
separation, and stable reruns with npm and pnpm:

```sh
npm exec nx -- run @megamono/plugin:e2e-playstack-yalc
```

## Convert an existing application repository

After committing `nx init` on a non-default conversion branch, preview the
write-free plan and then rerun it with explicit acceptance:

```sh
npm exec nx g @megamono/plugin:convert existing-app --dry-run --no-interactive
npm exec nx g @megamono/plugin:convert existing-app --acceptPlan --no-interactive
```

Convert preserves existing package commands behind Nx `build`, `test`, `lint`,
and detected `deploy` targets, moves application-owned files through the Nx
virtual tree, initializes Megamono conventions in warning mode, and records the
conversion decision. Ambiguous root files require a `--resolutions` ownership
map. `--report=<path>` persists a repository-valid report whose body contains
the same Markdown analysis, while `--verify=build` adds application build and
test verification after the default configuration checks.

## Analyze a repository import

On a clean, non-default host branch, inspect a local or remote source without
changing either repository:

```sh
npm exec nx run megamono:import -- --source=../source-app --ref=main --name=source-app
```

Analysis resolves and prints the immutable source SHA, existing commands,
dependency conflicts, aliases, environment-variable names, and non-JS
surfaces. Embedded HTTP credentials are rejected and environment values are
never included in output. After approving the report, execute the supported
subtree path by repeating the resolved SHA and choosing the verification depth:

```sh
npm exec nx run megamono:import -- \
  --source=../source-app \
  --ref=main \
  --name=source-app \
  --expectedSourceSha=<full-sha> \
  --history=subtree \
  '--resolutions.aliases.@source/shared/*=@source-app/shared/*' \
  --resolutions.environment.SHARED_TOKEN=SOURCE_APP_SHARED_TOKEN \
  --verify=build \
  --execute
```

Execution creates a history-graft commit, integrates package and Nx metadata,
records an accepted decision and completion marker, installs from the root,
and commits the integration only after validation. A failed command leaves the
graft and working tree intact with `MEGAMONO-RECOVERY.md`; a completed import
rerun is a zero-write success. Source documentation routes into the centralized
host corpus; existing repository records preserve their IDs and dates, while
plain Markdown receives valid internal metadata. Source workflows, agent files,
repository configs, and nested lockfiles are preserved under the import marker
without becoming active host configuration. All routes and collisions appear in
analysis before the graft, including the exact files an approved alias or
environment rename will change. Rewrites are restricted to source-owned config,
module specifiers, and explicit environment-reference syntax; their scope is
recorded in the accepted decision and completion marker. Relative imports among
app-owned files retain their topology under the destination. Imports into source
documentation or repository infrastructure that will be routed elsewhere are
blocked before the graft. Imports of packages already owned by target Nx
projects become an explicit graph contract that is checked after installation
and recorded in the completion marker. Subtree preserves the source graph with
its original SHAs, filter-repo rewrites the graph beneath the staging prefix,
and squash carries only the approved snapshot. Filter-repo requires a compatible
`git-filter-repo` executable on `PATH`; squash additionally requires
`--allow-history-loss`.

### Import a workspace with several projects

Use a reviewed Nx target configuration for the structured `monorepo` option.
For example, add a named configuration under the existing `megamono:import`
target in `tools/megamono/project.json` (or wherever that project lives):

```json
{
  "configurations": {
    "sdk-workspace": {
      "source": "../sdk-workspace",
      "name": "sdk-workspace",
      "destination": "libs/imported-sdk",
      "history": "subtree",
      "verify": "build",
      "monorepo": {
        "projects": {
          "packages/sdk": { "action": "reuse", "project": "existing-sdk" },
          "packages/email": {
            "action": "import",
            "name": "email",
            "configuration": {
              "projectType": "library",
              "tags": ["platform:node", "scope:shared", "type:util"],
              "targets": {
                "build": {
                  "executor": "nx:run-commands",
                  "options": {
                    "command": "node build.cjs",
                    "cwd": "libs/imported-sdk/packages/email"
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Commit that configuration before analysis; the host branch must be clean.
Run `npm exec nx -- run megamono:import:sdk-workspace` to inspect it, then repeat
with `--expectedSourceSha=<reported-full-sha> --execute` after approval. The map
must cover every static source project. `reuse` requires the same package
identity and compatible versions; alternatively use `action: "import"` with a
new `name` and `packageName` to retain a renamed implementation.

The common destination preserves the source's internal directory layout.
Reviewed targets must account for the new workspace root and retain existing
tests/lint. Source Nx plugins and root scripts are not installed as a second
workspace. Every imported project must build, and its expected graph edges must
exist before the integration commit. Reused duplicates are removed only from
the grafted copy and remain recoverable in Git history. TypeScript references
to host projects are redirected; aliases/relative imports into discarded
duplicates fail preflight. Complex workspace selectors and inference-only
source projects require static declarations first.

## Validate a workspace

```sh
npm exec nx run megamono:check
npm exec nx run megamono:check --ci
npm exec nx run megamono:check --profile=migration
npm exec nx run megamono:check --profile=release
npm exec nx run megamono-docs:validate
npm exec nx run megamono-docs:index
npm exec nx run megamono-docs:index --check
npm exec nx run megamono-docs:archive --id=<id> --status=<terminal-status> --dry-run
npm exec nx run megamono-docs:prune-reports
npm exec nx run megamono-docs:health
```

Health checks cover npm, Expo SDK, SwiftPM, and Cargo dependency alignment,
spec drift, stale plans, orphaned libraries, and integration-template drift.
Findings are written deterministically to `.megamono/health.json`.
Package-source profiles keep local evaluation separate from publication policy.
`development` permits local references, `migration` reports them as warnings,
`ci` rejects them except for exact fixture locators approved in
`megamono.json`, and `release` rejects every local reference. CI and release
also require the selected manager's lockfile. `--ci` remains an alias for the
`ci` profile, and `CI=true` selects it when no profile is passed.

## ESLint rules

The `@megamono/plugin/eslint` flat-config export provides
`docs-visibility-boundary`, `no-deep-relative-imports`, `platform-boundary`,
and `no-bare-jsx-strings`. Public applications may import repository docs only
from `content-collections/public-repo-docs`; unrestricted entry points remain
available to internal applications.
`workspace-init` reads their configured severities from `megamono.json`.

## Create repository records

```sh
npm exec nx g @megamono/plugin:docs-spec <project> "<title>"
npm exec nx g @megamono/plugin:docs-plan <project> "<title>"
npm exec nx g @megamono/plugin:docs-decision "<title>" --project=<project>
npm exec nx g @megamono/plugin:docs-research "<title>" --project=<project>
npm exec nx g @megamono/plugin:docs-audit <target> --project=<project> --spec=<spec-id>
```

Record generators default to internal visibility, validate controlled topics before
writing, and are no-ops when rerun with identical inputs.

New workspaces use pinned Node 24, npm 11 by default (or a pinned pnpm, Yarn,
or Bun selection), Nx 23.1, and TypeScript 6. Existing-workspace adoption
preserves npm 9–11, pnpm 8–11, Yarn 1.22–4, or Bun 1.x on Node 18.18–24, Nx
17–23, and TypeScript 5.2–6. Core survey and platform-neutral adoption are not
restricted by host OS; individual platform capabilities retain their own
gates. The optional Apple, Cargo, and Cloudflare inference plugins require Nx 18 or newer. See
[`compatibility.json`](./compatibility.json) for the machine-readable contract
and tested version anchors.

In CI and release profiles, package-source checks inspect dependency fields plus npm/Yarn
`overrides` and `resolutions`, package-level pnpm overrides/catalogs, and
`pnpm-workspace.yaml` overrides/catalogs. Yalc, links, portals, local package
directories, missing archives, and paths escaping the repository fail closed.
A repository-contained `.tgz` whose filename carries an exact semantic version
is accepted by the CI profile; the release profile still requires registry
resolution. CI-only fixture exceptions use an exact
`<manifest>#<dependency-location>` locator, such as
`package.json#devDependencies.@megamono/plugin`, and do not weaken release.

## Develop the plugin

```sh
npm exec nx run @megamono/plugin:typecheck
npm exec nx run @megamono/plugin:test
npm exec nx run @megamono/plugin:lint
npm exec nx run @megamono/plugin:build
```
