---
id: spec-megamono-0000
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [architecture, generators, nx, release]
summary: Canonical package map, compatibility baseline, command contract, and definition of done for Megamono v1.
date: 2026-08-23
supersedes: null
references: [spec-megamono-0010, spec-megamono-0014, spec-megamono-0015]
external_references: [playstack:08-data-and-prisma, playstack:45-cli]
---

# 00 — Megamono v1 Implementation Contract

This document is normative. When another spec uses an older package name, command name, or Nx API, this contract wins.

## Supported baseline

Megamono v1 targets one deliberately narrow toolchain:

| Surface                            | Supported in v1                                              |
| ---------------------------------- | ------------------------------------------------------------ |
| Node.js                            | `>=24 <25`                                                   |
| pnpm                               | `>=11 <12`; default for new workspaces                       |
| npm                                | `>=11 <12`; supported compatibility option                   |
| Nx                                 | `>=23.1 <24`                                                 |
| TypeScript                         | `>=6.0 <6.1`                                                 |
| Operating systems for core tooling | macOS and Linux                                              |
| Windows                            | Unsupported in v1; fail preflight with an actionable message |

The core packages declare these ranges in `engines` and `peerDependencies`. `create-megamono` accepts `--package-manager=pnpm|npm`, defaults to pnpm, and records the selection in both the root `packageManager` field and `megamono.json`. Every generated install, execution, CI, verification, recovery, and local-package command uses that recorded manager. Existing-workspace adoption detects an unambiguous pnpm or npm lockfile and preserves it; conflicting or unsupported lockfiles fail preflight. Supporting another package manager or Nx major is a separate compatibility project, not an incidental bug fix.

`@megamono/plugin/compatibility.json` is a public, versioned data export containing the exact scaffold defaults and tested ranges for application frameworks, service images, vendor SDKs, and optional external CLIs. Generators read that file rather than resolving `latest`. Changing an entry requires the affected fixture and snapshot suite in the same release.

## Published package map

| Package                   | Responsibility                                                                                      | Runtime dependency?                  |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `create-megamono`         | Bootstrap a new workspace before Nx is installed                                                    | No; executed with `pnpm dlx` / `npx` |
| `@megamono/cli`           | Global `megamono` command that delegates existing-workspace operations to the local Nx plugin       | Global development tool              |
| `@megamono/plugin`        | Workspace, docs, conventions, health, integration, Playstack-wiring, and email generators/executors | Dev dependency only                  |
| `@megamono/nx-apple`      | Apple project inference, targets, and graph edges                                                   | Dev dependency only                  |
| `@megamono/nx-cargo`      | Cargo/Tauri inference, targets, and graph edges                                                     | Dev dependency only                  |
| `@megamono/nx-extension`  | WXT extension inference and generators; Wave 2                                                      | Dev dependency only                  |
| `@megamono/nx-laravel`    | Composer/Laravel inference and generators; Wave 2                                                   | Dev dependency only                  |
| `@megamono/nx-cloudflare` | Wrangler inference, binding graph edges, targets, and generators; Wave 3                            | Dev dependency only                  |

The initial validation channel publishes `@megamono/cli`, `@megamono/plugin`, `@megamono/nx-apple`, `@megamono/nx-cargo`, and `@megamono/nx-cloudflare` as restricted packages on npm from `megamono-dev/megamono`. Their canonical names do not change when they graduate to public npm. The unscoped `create-megamono` entry package cannot be private on npm and remains in a separate release group until public promotion.

Later scoped packages enter the same restricted validation channel before public promotion. Adding a package to this map does not add it to the current release group until its accepted spec and packed-package fixture are complete.

`docs`, `skills`, `conventions`, `content`, `integrations`, `playstack`, and `generators` are internal modules of `@megamono/plugin`, not separately published packages in v1. This avoids version skew between repo-shaping capabilities that must agree on one `megamono.json` schema.

## Canonical generator names

```text
@megamono/plugin:workspace-init
@megamono/plugin:workspace-eject
@megamono/plugin:convert
@megamono/plugin:skill-eject

@megamono/plugin:docs-init
@megamono/plugin:docs-spec
@megamono/plugin:docs-decision
@megamono/plugin:docs-plan
@megamono/plugin:docs-research
@megamono/plugin:docs-audit
@megamono/plugin:content-lib
@megamono/plugin:content-type

@megamono/plugin:playstack-auth
@megamono/plugin:playstack-accounts
@megamono/plugin:playstack-webhooks
@megamono/plugin:playstack-cache
@megamono/plugin:playstack-media

@megamono/plugin:integration-sentry
@megamono/plugin:integration-fathom
@megamono/plugin:integration-postmark
@megamono/plugin:integration-stripe

@megamono/plugin:theme
@megamono/plugin:emails

@megamono/plugin:playstack-lint
@megamono/plugin:playstack-skills
```

These are stable names, not a promise that every generator ships in the first collection. V1 availability is explicit:

| Availability                         | Generators                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unconditional core                   | `workspace-init`, `workspace-eject`, `convert`, `skill-eject`, `docs-init`, `docs-spec`, `docs-decision`, `docs-plan`, `docs-research`, `docs-audit`                       |
| Published after external fixtures    | `playstack-lint`, `playstack-skills`                                                                                                                                       |
| Conditional on external fixture gate | `content-lib`, `content-type`, `playstack-auth`, `playstack-accounts`, `playstack-webhooks`, `playstack-cache`, `playstack-media`, `integration-sentry`, `theme`, `emails` |
| Reserved for later wave              | `integration-fathom`, `integration-postmark`, `integration-stripe`, `playstack-admin`, `playstack-queues`                                                                  |

The published collection is generated from this availability registry. Requesting a reserved or gated generator returns a diagnostic naming the unsatisfied gate; it never falls through to a partial implementation.

`@megamono/plugin/emissions.json` is the machine-readable enforcement point for every `@playstack/*` package a generator may place in a consumer. Each record names its owning generator, dependency class, required tier, compatible version when one has passed fixtures, and current availability. Generator source and packed-output fixtures fail when they encounter an unregistered package. A null compatible version keeps the owning generator gated; generators never embed a substitute version in template code.

## Dedicated CLI contract

Installing `@megamono/cli` globally exposes the `megamono` executable. V1 intentionally keeps it as a thin dispatcher rather than a second implementation of generators or executors:

```text
megamono init
megamono init --survey
megamono init --playstack --playstack-packages=@playstack/auth,@playstack/accounts
megamono init --playstack --local-packages=yalc
megamono help
megamono --version
```

`megamono init [...options]` finds the workspace from the current directory, detects exactly one supported lockfile, verifies that the corresponding local package manager, Nx, and `@megamono/plugin` are installed, and delegates to the local `@megamono/plugin:workspace-init` generator. pnpm workspaces run `pnpm exec nx generate`; npm workspaces run `npm exec nx -- generate`. Every option after `init` is forwarded as its own argument without reinterpretation, including `--survey`, `--only`, `--interactive`, `--yes`, and generator options added by a compatible local plugin.

The CLI consumes three init-only options before delegation:

- `--playstack` runs package-owned `playstack init` after Megamono initialization succeeds.
- `--playstack-packages=<comma-separated @playstack/* names>` installs those product packages before invoking Playstack init and implies `--playstack`.
- `--local-packages=registry|yalc` selects the source for missing Megamono and Playstack packages; registry is the default.

The local `@megamono/plugin` remains a prerequisite because installing it would dirty the worktree before the generator's safety check. When it is absent, the CLI exits `3` with the exact registry or yalc installation command, and the user commits that dependency change before retrying. `--local-packages=yalc` verifies all requested exact packages in the user-wide yalc store before running workspace-init, so a missing local Playstack artifact cannot leave a half-initialized repository.

After workspace-init succeeds, Playstack setup installs a missing `@playstack/cli` as a dev dependency and requested product packages as application dependencies from the selected source, hydrates the lockfile with the recorded package manager, and invokes the repository-local `playstack init`. Yalc mode uses `yalc add --no-pure` followed by the local package manager's install; it never substitutes a registry version. Playstack owns `playstack.json`, package detection, artifact targets, and all later sync/update behavior.

`--survey` remains write-free. With `--playstack`, it runs `playstack init --survey` only when the local Playstack CLI already exists; otherwise it reports the package additions and command that a real run would perform. It never installs from either source during a survey.

The global CLI never upgrades the plugin, runs a global Nx or Playstack binary, bypasses generator preflight, or contains a copy of either product's init logic. Unknown commands, invalid CLI-only values, and invalid Playstack package names exit `2`. Preflight/source failures exit `3`. Otherwise the CLI returns the delegated process status, including signal failures, without translating generator diagnostics. A failure after workspace-init prints the completed steps and exact retry command; it does not roll back Megamono-owned files.

This design deliberately allows the globally installed CLI and repository-local plugin to update independently. The local plugin and local Nx version remain authoritative for workspace behavior; the CLI owns only command discovery, package-manager selection, delegation, help, and version output.

## Canonical executor targets

The docs project is named `megamono-docs` by default and exposes:

```text
megamono-docs:validate
megamono-docs:index
megamono-docs:archive
megamono-docs:prune-reports
megamono-docs:health
```

The repository-wide structural checker is `megamono:check`. ESLint rules remain available through the `@megamono/plugin/eslint` export, but Markdown and project-graph checks run through `megamono:check`, not ESLint.

Repository maintenance also exposes `megamono:import`. Import is an executor rather than a generator because history grafting necessarily creates Git commits; it runs only with the explicit execution flag defined in `spec-megamono-0010`, never pushes, and never touches the source repository.

## Nx plugin API contract

Language plugins export the Nx 23 v2 APIs under their current names:

- `createNodes` discovers projects and infers targets.
- `createDependencies` parses local manifest dependencies and emits static project-graph edges.
- `createNodesV2` is not exported in v1; it is a deprecated alias in Nx 23.
- Every inferred target declares `inputs`, `outputs` when it writes files, `cache`, and enough metadata for `nx show project` to explain its source.

## Generator execution contract

Every generator follows these rules:

1. **Deterministic planning.** Resolve inputs and produce an in-memory change plan before writing.
2. **No hidden prompts.** `--interactive=false` either has enough flags/config to finish or exits before mutation with the missing option names.
3. **Idempotency.** Re-running with the same options produces no diff and exits successfully.
4. **Conflict safety.** Workspace-governance artifacts use the ownership modes and committed registry from `spec-megamono-0014`. A pristine managed artifact may update only while its installed hash matches. A modified managed artifact is preserved, receives a diff, and must be made repository-owned with `workspace-eject`; `--force` never reclaims it. Generator-specific files outside that registry may expose a separately specified scoped `--force`, but `--force` never applies to workspace-init, convert, or import.
5. **No implicit commits.** Generators write files but do not commit, push, open PRs, create secrets, run migrations against a database, or deploy.
6. **External commands last.** Package installation and ecosystem CLIs run only after file preflight succeeds. Failure leaves a recovery report naming every completed step.
7. **Secrets by name only.** Workflows declare required secret names; generators never request or persist secret values.
8. **Dry run.** Mutating generators support `--dry-run`, print the same ordered plan used for execution, and write nothing.

Commands emitted by a generator are package-manager-aware. pnpm workspaces use `pnpm install`, `pnpm exec`, `pnpm run`, and `workspace:` dependency declarations. npm workspaces use `npm install`, `npm exec`, `npm run`, and npm-compatible local workspace declarations. A generator never mixes command families or infers a manager from executable availability after the workspace contract has been recorded.

Megamono error classifications are stable: `0` success/no-op, `1` validation or execution failure, `2` invalid options, `3` preflight refusal, and `4` unresolved user decision in non-interactive mode. Standalone CLIs and executors use those values as process exit codes. Nx 23's generator runner catches every thrown generator error and returns process status `1`, so `nx generate` exposes classifications `2`–`4` through the error object's `exitCode` and a stable diagnostic code rather than through the process status. Packed-generator fixtures assert status `1` plus that diagnostic code; direct tests assert the programmatic classification.

## Compatibility and fixture tests

Each published package must pass:

- Unit tests for manifest parsing, option normalization, and conflict detection.
- Snapshot tests for generated trees; snapshots include `package.json`, `nx.json`, and `megamono.json` changes.
- Idempotency tests that run every generator twice.
- Failure-injection tests proving no file mutation occurs before preflight completes.
- An e2e test that publishes to the local registry, installs into a fresh Nx 23 workspace, and runs the generated targets.
- For language plugins, fixtures for workspace roots, leaf projects, local dependencies, renamed targets, missing toolchains, malformed manifests, and cycles.
- Graph assertions using `NX_DAEMON=false NX_CACHE_PROJECT_GRAPH=false nx graph --file=...` plus one `nx affected` assertion per dependency-edge kind.

## Cross-product contracts

Playstack specifications are maintained in `org-playstack/playstack-pro`, which is the initial authoritative repository for the `playstack:` namespace. References use qualified IDs such as `playstack:08-data-and-prisma`, never filesystem paths or assumptions about a sibling checkout. Local docs validation syntax-checks those IDs; release gating relies on the published package contracts and fixtures below rather than requiring cross-repository access.

A Playstack-wiring generator ships only when the referenced package publishes:

- its install name and Free-tier availability,
- its runtime/framework compatibility,
- its configuration and environment contract,
- its Prisma fragment, when applicable,
- and a fixture package usable by Megamono e2e tests.

Until those artifacts exist, the generator name may be reserved but is not included in the published generator collection.

## Definition of build-ready

A spec is build-ready when it has `status: accepted`, no unresolved decision that changes its v1 output, an explicit v1 scope, failure behavior, and acceptance criteria. Future work may remain as a deferred section only when the v1 behavior is already fixed.

## Acceptance criteria

- Packed packages enforce the supported Node, pnpm/npm, Nx, and TypeScript ranges and reject unsupported or ambiguous package managers and operating systems during preflight.
- `workspace-eject` preserves artifact content, changes only Megamono ownership metadata or managed-section delimiters, and prevents later plugin upgrades from reclaiming the artifact.
- Every public generator and executor name appears in this contract and resolves from a local-registry installation fixture.
- A packed `@megamono/cli` installed globally delegates `megamono init --survey` through both pnpm and npm fixtures, refuses missing or ambiguous workspace prerequisites before spawn, forwards generator arguments unchanged, and propagates delegated exit status.
- Registry and yalc Playstack fixtures prove init-only options are consumed rather than forwarded, requested product packages use the selected source, `@playstack/cli` remains a dev dependency, the local `playstack` binary performs configuration, survey writes nothing, and missing yalc artifacts fail before workspace-init.
- Generator fixtures prove deterministic planning, dry-run parity, idempotency, conflict handling, stable exit codes, and absence of secret values.
- Language-plugin fixtures prove current Nx 23 API exports, deterministic project discovery, and affected graph propagation.
- Gated generators are absent from the published collection until their external contract fixtures pass.
- No core package has a runtime dependency on Playstack, an application framework, or Nx Enterprise.
