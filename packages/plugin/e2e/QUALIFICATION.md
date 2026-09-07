# Packed consumer qualification

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
`create-megamono`, nor a test of the pending Playstack UI installation recipe.
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
