# Packed consumer qualification

## Full App Router UI bootstrap

`npm exec nx -- run @megamono/plugin:e2e-ui-bootstrap` runs the packed
`create-megamono` CLI, the real Yalc Playstack `chakra` and `app-ui` recipes,
and the installed Megamono `playstack-integrate` generator. It reviews dry-run
plans, chooses App Router/fixed light mode/English/public fixture rows, and
connects the emitted provider to the scaffold's existing theme. Recipe and
integration reruns must preserve that application-owned composition.

The harness publishes current Megamono builds only into a private temporary
Yalc store and snapshots the required Playstack publications from the user's
store. It never pushes, modifies adopter repositories, or updates global CLIs.
It then copies the complete workspace and `.yalc` payload to a clean directory,
makes the original workspace and private store unavailable, and runs `npm ci`
without lockfile changes. Typecheck, the generated lint configuration, production
build, and Chromium hydration/keyboard filtering/navigation run in that clean
consumer. Original scaffold files are not substituted with hand-built projects.
Application-owned provider composition and the public example route are explicit.

`tmp/ui-bootstrap/<lane>/` records checks (including failed stages), resolved versions,
source revision/dirty status, package file hashes, recipe/integration plans, and
the clean-bootstrap file hashes and lockfile. A successful run qualifies only
that recorded combination. This opt-in target requires registry access, local
Playstack publications, and Chromium. It is not an auth/cache/provider test or
a claim that ignored `.yalc` directories alone are sufficient for CI.

### Version lanes and qualification boundaries

Run `npm exec nx -- run @megamono/plugin:e2e-ui-version-matrix` to exercise all
four lanes, or select one with
`npm exec nx -- run @megamono/plugin:e2e-ui-bootstrap --args='--lane=newer-ui'`.
For a subset, pass `--args='--lanes=scaffold,scaffold-eslint10'` to the matrix
target. It writes a separately named subset summary and never treats unselected
lanes as passing. Do not run overlapping lane selections concurrently.
The default lane is `scaffold`. Pins live in `ui-qualification.mjs`; these are
fixture selections, not edits to Megamono's compatibility declarations.

| Lane                | Next / Next ESLint config | Chakra | TypeScript | ESLint / @eslint/js |
| ------------------- | ------------------------- | ------ | ---------- | ------------------- |
| `scaffold`          | 16.1.7                    | 3.36.1 | 6.0.3      | 9.39.5 / 9.39.5     |
| `scaffold-eslint10` | 16.1.7                    | 3.36.1 | 6.0.3      | 10.6.0 / 10.0.1     |
| `newer-ui`          | 16.3.3                    | 3.37.0 | 6.0.3      | 9.39.5 / 9.39.5     |
| `newer-ui-eslint10` | 16.3.3                    | 3.37.0 | 6.0.3      | 10.6.0 / 10.0.1     |

Each lane creates a fresh workspace with the supported generator, then explicitly
selects its dependency combination before installing recipes. Existing app/theme
peer declarations are aligned with the root selection to prevent duplicate Chakra
contexts. The prior scaffold install/lockfile is parked outside the consumer
before resolving that combination; no stale installed peer graph is reused.
No peer-conflict bypasses or lint-rule suppression are used. The fixture
asserts the resolved versions after clean installation; other transitive versions,
including React and the Nx toolchain, are recorded in the report and lockfile.

`matrix.json` aggregates the lane reports and returns failure if **any** lane
fails. A failing lint stack remains failed even if its peer ranges permit
installation. Later checks are reported as `not-run`, never inferred from another
lane. These opt-in candidates are not promised to pass just because they are
listed. Each lane's `qualification` section is the authoritative result; missing
stages mean incomplete evidence. Unit tests for selection, manifest pinning and
report classification run through `@megamono/plugin:test-ui-qualification`.

Changing scaffold pins requires separately reviewing the recorded combination.
TypeScript 7, system/dark-mode composition, live auth/cache interactions and
vulnerability qualification remain outside these lanes. A green UI fixture is
not a product-release or security certification.

Local qualification on 2026-09-07 passed the `scaffold` and `newer-ui` ESLint 9
lanes through clean install, generated lint, production build, typecheck and
browser interaction. Both ESLint 10 lanes failed fresh dependency resolution:
the generated workspace pins `eslint-plugin-import@2.31.0`, whose ESLint peer
range ends at 9. Their downstream lint/build/browser checks were not run. This is
not an ESLint 10 qualification and must not be hidden with peer overrides.
See each dated lane report for the exact artifact hashes and dependency lock;
future runs must collect their own evidence.

## Generated Next.js and Playstack UI

`npm exec nx -- run @megamono/plugin:e2e-web-ui-consumer` generates both App
Router and Pages Router Chakra sites using the packed Megamono plugin and local
Nx generators. It resolves the real Yalc Chakra/App UI internal dependency/peer
closure, installs the generated consumer dependencies independently, composes an
application-owned custom theme, and runs lint, production webpack builds,
TypeScript 6 checks, and Chromium hydration/filtering/keyboard/navigation checks.
The theme uses explicit fixed light colors; automatic color-mode integration is
not claimed. Reports and the resolved lockfile are written to
`tmp/web-ui-consumer/`. Missing artifacts or failed browser checks fail the target.
The fixture preserves the scaffold's Chakra/Emotion versions for the UI peers
and verifies shared Chakra module resolution: separate provider copies can
otherwise compile successfully and fail during prerendering. Each workspace
declares the Playstack packages it imports. Typechecking uses Nx's generated
base configuration, including its default `skipLibCheck` policy; this is consumer
typechecking, not exhaustive validation of dependency declaration files.

This opt-in lane requires locally published Playstack packages, registry access,
and Chromium. It is not silently added to ordinary CI, which has no Yalc store.
Generation shares the local Nx toolchain; this is not a clean bootstrap test of
`create-megamono`, nor a test of Playstack UI installation recipes (use the full
bootstrap target above for that workflow).
TypeScript 7 requires a separate qualified lane before widening supported ranges.

## Portable Prisma and native-boundary composition

Run `npm exec nx -- run @megamono/plugin:e2e-prismark-consumer` under Node 24.
The target packs the current plugin and a **synthetic** package-authored
integration contract, resolves pinned public dependencies into a temporary
workspace, then performs `npm ci` against the resulting lockfile. It does not
symlink dependencies from Megamono's workspace. It runs no database migrations,
uses no application credentials, and never touches Prismark repositories or
local vaults. Registry access is required; peer errors are not bypassed.

The portable fixture proves:

- Packed generator dry-run, write, and repeat-run behavior without dependency
  reconciliation; installed-artifact snapshots are included in the report.
- Prisma 7 schema validation and explicit context-local client generation.
- Nest 11/TypeScript 5.9 compilation with generated Prisma types, followed by an
  actual Nest application-context startup/shutdown (no HTTP listener/database).
- Desktop/mobile JavaScript entry points bundle for the browser without Nest,
  Prisma, or the fixture's Node-only server implementation. Deliberately leaking
  that server entry causes bundling to fail.
- The compiled Nest application still starts after production dependency pruning.

`tmp/prismark-consumer/` contains the report, per-check logs, and resolved
lockfile. The report records source revision/dirty status, tool versions,
tarball and lockfile hashes, installed integration provenance, and explicit
not-run environments. CI preserves these as an artifact. The lockfile captures
the particular run's transitive resolutions; it is not a committed universal
compatibility matrix. Reproduce a run using its lockfile and matching tarballs.

Passing this Nx target means its **portable checks** passed, not that the whole
product is qualified. The report deliberately remains `partial`. Tauri and Expo
markers exercise workspace shape but are not native SDK/build qualification.
Real Postgres contention/rollback, container builds, Metro/native builds,
secure-storage and multi-window behavior, devices, and live providers remain
separate gates. No synthetic contract stands in for Playstack authentication,
session replay, account policy, sync, or transactional correctness.

`e2e-integration-consumer` separately exercises generated Nx/CI verification
execution and migration transitions. It shares the installed toolchain and
therefore is not clean-install evidence. `e2e-playstack-integrations-yalc`
checks real locally packed Playstack manifests, internal closures, and template
materialization in a virtual Nx tree. Its external-peer metadata is synthetic;
it is not a runtime, provider, or external-peer installation test.

The same planning fixture now covers the actual `nest-storage` and `cache-next`
Yalc manifests. It checks named-provider readiness preservation, both explicit
Cache Components selections, and that requirements-only integrations report
`none-selected`, `application-owned`, and verification `not-run`.
As of September 8, both packages still publish **zero templates**. Generated
storage/cache composition qualification is blocked on Playstack, not passed by
this planning test. The fixture deliberately fails when templates appear so a
maintainer must add emitted compilation/runtime qualification instead of silently
promoting a metadata check into compatibility evidence.

Upstream inputs needed: named-storage module/provider/test templates and separate
templates for Next incremental cache versus Cache Components. Once published,
pack the real closure, generate through Megamono, clean-install and compile all
emitted files together, then run storage readiness/behavior and the selected
Next cache API tests. Do not substitute locally invented templates or claim
database, Redis, HTTP authorization or provider qualification from this gate.

## Existing email-preview adoption

Run `npm exec nx -- run @megamono/plugin:e2e-email-preview-consumer` with local
`chakra-email`, `@chakra-email/core`, `@playstack/mail` and `@playstack/core`
artifacts. The fixture packs the current Megamono generator and those artifacts,
performs real dependency and clean lockfile installs, then adopts a synthetic
application-owned email library through the installed generator. No shared Yalc
registration or publication is performed. Network access for installation and
permission to bind loopback are required.

It checks read-only planning, no-op reruns, template/theme/script preservation,
real Chakra Email deterministic subject/HTML/plaintext with custom tokens,
invalid-input and 100 KiB limit failures before Playstack capture delivery,
loopback HTML serving, and propagation of a deliberately failing application
verification target. These are synthetic adoption fixtures, not Newsbetters
tests, email-client certification or live provider tests. Results and pinned
artifact/lockfile evidence are written to `tmp/email-preview-consumer/`.
This qualifies `emails-adopt`, **not** the still-gated `emails` seed generator.

## Actual emitted billing template set

Run `npm exec nx -- run @megamono/plugin:e2e-billing-template-consumer`.
This opt-in lane packs Megamono and the real Yalc Nest Billing dependency
closure, installs real Nest 11/TypeScript 6/Jest declarations, performs a clean
`npm ci`, and invokes the installed integration generator. Every emitted
TypeScript file, including tests, is compiled together regardless of production
tsconfig exclusions. If compilation passes, emitted direct-controller tests run
separately. No templates are repaired in the fixture. The lane never publishes,
registers Yalc installations, or changes adopter repositories.

Reports, template/tarball hashes, compiler diagnostics, and the resolved lockfile
are saved in `tmp/billing-template-consumer/`. Failed compilation fails the Nx
target; downstream checks are explicitly not-run. HTTP authorization with a real
account guard, database correctness and live Stripe behavior are **not** proven
by a permissive direct-controller test. Registry access and local Playstack
artifacts are prerequisites; ordinary CI does not acquire a hidden Yalc dependency.

September 8, 2026: packing, dependency installation, clean installation and actual
generation passed. The published `@playstack/nest-billing@0.1.0-beta.1` test
(declared template hash `1cac3fa876ace8288a093b0159c93722e659ad4eeeca7418c4b8718aaab8d20a`)
failed TS2345 because its checkout body omits `idempotencyKey`. Compilation and
direct-controller execution remain blocked until Playstack republishes the fix.
This is a recorded failed qualification, not an expected-failure pass.

`npm exec nx -- run @megamono/plugin:test-emitted-typescript` independently proves
that the compiler catches a missing required field in an excluded test and
accepts the correctly paired controller/test. This tool regression is not a
substitute for passing the actual published-artifact lane.
