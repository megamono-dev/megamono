---
id: spec-megamono-0000
type: spec
status: accepted
visibility: internal
projects:
  - megamono
  - '@megamono/workspace'
  - '@megamono/cli'
  - '@megamono/plugin'
  - create-megamono
  - nx-apple
  - nx-cargo
  - nx-cloudflare
topics: [architecture, generators, nx, release]
summary: Canonical package map, compatibility baseline, command contract, and definition of done for Megamono v1.
date: 2026-08-23
supersedes: null
references: [spec-megamono-0010, spec-megamono-0014, spec-megamono-0015]
external_references: [playstack:08-data-and-prisma, playstack:45-cli]
---

# 00 — Megamono v1 Implementation Contract

This document is normative. When another spec uses an older package name, command name, or Nx API, this contract wins.

## Supported baselines

Megamono distinguishes a pinned scaffold baseline from a broader adoption range. A new workspace is deterministic and moves forward as one tested stack; initializing an existing workspace does not require an otherwise unnecessary Nx upgrade.

| Surface                            | New workspace scaffold                           | Existing-workspace adoption             |
| ---------------------------------- | ------------------------------------------------ | --------------------------------------- |
| Node.js                            | `>=24 <25`                                       | `>=18.18 <25`                           |
| npm                                | `>=11 <12`; default and exactly pinned           | `>=9 <12`; detected and preserved       |
| pnpm                               | `>=11 <12`; exactly pinned compatibility option  | `>=8 <12`; detected and preserved       |
| Yarn                               | `>=1.22 <5`; exactly pinned compatibility option | `>=1.22 <5`; detected and preserved     |
| Bun                                | `>=1.1 <2`; exactly pinned compatibility option  | `>=1.1 <2`; detected and preserved      |
| Nx core adoption                   | `>=23.1 <24`                                     | `>=17 <24`                              |
| TypeScript                         | `>=6.0 <6.1`                                     | `>=5.2 <7`                              |
| Apple/Cargo/Cloudflare inference   | `>=23.1 <24`                                     | `>=18 <24`                              |
| Optional Playstack handoff         | Node `>=20`; ESLint `^9` when lint is selected   | Same per-capability gate                |
| Operating systems for core tooling | macOS and Linux                                  | Any Node-supported host                 |
| Windows                            | Unsupported for new-workspace bootstrap in v1    | Supported for platform-neutral adoption |

`create-megamono` accepts `--package-manager=npm|pnpm|yarn|bun`, defaults to npm, and records the selection in both the root `packageManager` field and `megamono.json`. Every generated install, execution, CI, verification, recovery, and local-package command uses that recorded manager. Existing-workspace adoption selects the manager from an unambiguous root lockfile or a matching `packageManager` declaration and preserves it. Nested lockfiles do not participate in root ownership. When a root lockfile supplies the only answer, Megamono records the inferred choice in `megamono.json` without adding a `packageManager` declaration. Changing managers is a separate explicit migration, never a side effect of adoption.

`@megamono/plugin` declares the adoption range in `engines` and `peerDependencies`. Each inference plugin declares its narrower Nx floor independently. Nx 17's plugin discovery callback is synchronous, so it can host core adoption but not the async Apple, Cargo, or Cloudflare discovery implementations. Adding another package-manager or Nx range remains an explicit compatibility project; operating-system gates belong only to capabilities that actually require them.

`@megamono/plugin/compatibility.json` is a public, versioned data export containing the exact scaffold defaults, adoption ranges, per-package Nx ranges, stable test anchors, application frameworks, service images, vendor SDKs, and optional external CLIs. Generators read that file rather than resolving `latest`. Changing an entry requires the affected fixture and snapshot suite in the same release.

## Package and release map

| Package                   | Responsibility                                                                                      | Runtime dependency?                   | Repository status                 |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------- |
| `create-megamono`         | Bootstrap a new workspace before Nx is installed                                                    | No; executed with `npx` or equivalent | Implemented; public release group |
| `@megamono/cli`           | Global `megamono` command that delegates existing-workspace operations to the local Nx plugin       | Global development tool               | Implemented; public release group |
| `@megamono/plugin`        | Workspace, docs, conventions, health, integration, Playstack-wiring, and email generators/executors | Dev dependency only                   | Implemented; public release group |
| `@megamono/nx-apple`      | Apple project inference, targets, and graph edges                                                   | Dev dependency only                   | Implemented; public release group |
| `@megamono/nx-cargo`      | Cargo/Tauri inference, targets, and graph edges                                                     | Dev dependency only                   | Implemented; public release group |
| `@megamono/nx-cloudflare` | Wrangler inference, binding graph edges, targets, and generators                                    | Dev dependency only                   | Implemented; public release group |
| `@megamono/nx-extension`  | WXT extension inference and generators                                                              | Dev dependency only                   | Implemented; public release group |
| `@megamono/nx-laravel`    | Composer/Laravel inference and generators                                                           | Dev dependency only                   | Reserved; no package directory    |

The `megamono` Nx release group publishes `@megamono/cli`, `@megamono/plugin`, `@megamono/nx-apple`, `@megamono/nx-cargo`, `@megamono/nx-cloudflare`, and `@megamono/nx-extension` as fixed-version public packages on npm from `megamono-dev/megamono`. The unscoped `create-megamono` entry package remains independently versioned and tagged, but the guarded workflow validates and publishes both groups together so new-workspace and existing-workspace entry points are exercised in the same release.

These labels deliberately distinguish specification state from software and distribution state. `accepted` means the behavioral contract is build-ready; `implemented` means a package directory and tested implementation exist; membership in a public release group means CI is authorized to publish it after its gates pass, not that a registry version already exists. A reserved row is neither implemented nor published. Later packages enter a public validation group only after their accepted spec, implementation, and packed-package fixture are complete.

`docs`, `skills`, `conventions`, `content`, `integrations`, `playstack`, and `generators` are internal modules of `@megamono/plugin`, not separately published packages in v1. This avoids version skew between repo-shaping capabilities that must agree on one `megamono.json` schema.

## Canonical generator names

```text
@megamono/plugin:workspace-init
@megamono/plugin:workspace-eject
@megamono/plugin:app
@megamono/plugin:database
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

| Availability                         | Generators                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unconditional core                   | `workspace-init`, `workspace-eject`, `app`, `database`, `convert`, `skill-eject`, `docs-init`, `docs-spec`, `docs-decision`, `docs-plan`, `docs-research`, `docs-audit`                                       |
| Available                            | `content-lib`, `content-type`, `playstack-lint`, `playstack-skills`                                                                                                                                           |
| Conditional on external fixture gate | `integration-sentry`, `theme`, `emails`                                                                                                                                                                       |
| Reserved boundary or later wave      | `playstack-auth`, `playstack-accounts`, `playstack-webhooks`, `playstack-cache`, `playstack-media`, `integration-fathom`, `integration-postmark`, `integration-stripe`, `playstack-admin`, `playstack-queues` |

The published collection is generated from this availability registry. Requesting a reserved or gated generator returns a diagnostic naming the unsatisfied gate; it never falls through to a partial implementation.

`@megamono/plugin/emissions.json` is the machine-readable enforcement point for every `@playstack/*` package a generator may place in a consumer. Each record names its owning generator, dependency class, required tier, compatible version when one has passed fixtures, and current availability. Generator source and packed-output fixtures fail when they encounter an unregistered package. Only an `available` record with a compatible version authorizes emission; gated and reserved records remain non-emittable even when a version is retained for compatibility evidence. Generators never embed a substitute version in template code.

## Dedicated CLI contract

Installing `@megamono/cli` globally exposes the `megamono` executable. V1 intentionally keeps it as a thin dispatcher rather than a second implementation of generators or executors:

```text
megamono init
megamono init --survey
megamono init --playstack --playstack-packages=auth,accounts
megamono init --playstack-packages=auth --playstack-web=apps/storefront --playstack-api=apps/gateway
megamono init --playstack --local-packages=yalc
megamono add app web
megamono add app api --name=admin-api
megamono add database primary --adapter=prisma
megamono add database analytics --adapter=drizzle
megamono add docs|agents|ci|release|lint|skills|health|inference
megamono generate <name> [...generator options]
megamono help
megamono --version
```

`megamono init [...options]` finds the workspace from the current directory, resolves root package-manager ownership from the committed lockfile or `packageManager` declaration, verifies that the corresponding local package manager, Nx, and `@megamono/plugin` are installed, and delegates to the local `@megamono/plugin:workspace-init` generator through the recorded manager's adapter. A core-only `--survey` is the exception: it invokes the repository-local Nx binary directly through Node, so an unsupported or unavailable global package manager does not prevent read-only inspection. Every option not owned by the Playstack orchestration families below is forwarded as its own argument without reinterpretation, including `--survey`, `--only`, `--interactive`, `--yes`, and generator options added by a compatible local plugin.

`megamono generate <name> [...options]` reads the workspace-local plugin availability registry before delegation. Available names run through the local Nx and package manager; gated and reserved names exit `3` with the registry's exact unsatisfied gate and never reach Nx. This preserves an available-only published collection while giving the dedicated CLI a stable diagnostic for canonical names that are not yet buildable.

`megamono add app <type> [...options]` delegates to the local `@megamono/plugin:app` generator. The supported v1 types are `web`, `site`, `api`, `worker`, `mobile`, `desktop`, and `apple`. The type is also the default project basename; `--name` and `--directory` allow additional instances without changing the maintained preset. A valueless `megamono add app` opens the type selector in an interactive terminal and exits `4` without mutation in non-interactive mode. The generator owns application structure, project registration, conventional tags, stable port allocation, lint and test setup, Nest feature-library composition, Chakra starter composition, and the repository onboarding billboard where applicable.

`megamono add database <name> [...options]` delegates to `@megamono/plugin:database`. The adapter is selected with `--adapter=prisma|drizzle`, prompted when interactive, and required when automation cannot infer it from an existing named target. Megamono creates or adopts the Nx project, scaffolds the adapter's repository configuration at compatibility-pinned versions, and records the project in `megamono.json`. New native multi-file layouts receive a corresponding named artifact destination in `playstack.json`. A Prisma destination is always the complete schema-folder root containing the datasource-bearing schema entry; a nested fragments directory is invalid because it would let compatibility inspection omit application-owned models. An established Prisma layout is adopted structurally without enabling artifact composition unless the repository already owns that Playstack target or supplies an explicit compatible `--target`; this prevents package fragments from being written outside the schema input Prisma actually validates. An enabled new target omits `packages`, allowing installed-package discovery, while an existing explicit `packages` allowlist is preserved unchanged. Megamono never copies Playstack schema artifacts, connects to a database, generates a migration, or applies a migration.

`megamono add docs|agents|ci|release|lint|skills|health|inference` is an ergonomic route to the corresponding independently selectable `workspace-init` module. It does not introduce a second generator or ownership implementation. Add commands require an initialized `megamono.json`; they never adopt the baseline implicitly. Repeating an already satisfied add command is a successful no-op.

Every add command is interactive by default, accepts `--dry-run`, and accepts `--interactive=false --yes` for a fully explicit automation path. `--dry-run` performs discovery and prints the same ordered plan used by execution without installing dependencies, writing files, or warming workspace caches. `--yes` confirms a resolved plan but never supplies an ambiguous project name, occupied path, port, or missing app type. Required local or upstream plugins appear in the preview; an accepted execution installs exact compatibility-pinned packages before local generator delegation and records a recovery command if later work fails.

The CLI consumes these init-only option families before delegation:

- `--playstack` runs package-owned `playstack init` after Megamono initialization succeeds.
- `--playstack-packages=<comma-separated names>` accepts concise capabilities such as `auth,accounts` or full `@playstack/*` package names and implies `--playstack`. Concise names delegate to `playstack add <capability> --yes`, allowing Playstack to own recipes, prerequisites, surface bindings, and transitive packages. Full package IDs are an explicit compatibility escape hatch installed directly before Playstack init; they do not invoke a capability recipe. In an interactive terminal, a bare `--playstack-packages` opens the supported-capability multiselect; without an interactive prompt, omitting the value is a usage error and never blocks automation.
- `--playstack-web=<project-root|false>` and `--playstack-api=<project-root|false>` select or suppress the exact application roots passed to every delegated capability command. These are Megamono routing inputs and are not forwarded to `workspace-init`.
- `--local-packages=registry|yalc` selects the source for missing Megamono and Playstack packages; registry is the default.

The local `@megamono/plugin` remains a prerequisite because installing it would dirty the worktree before the generator's safety check. When it is absent, the CLI exits `3` with the exact registry or yalc installation command, and the user commits that dependency change before retrying. `--local-packages=yalc` verifies the missing Megamono plugin and Playstack CLI before running workspace-init. For explicitly named full packages, Megamono also resolves and validates every required transitive `@playstack/*` dependency and peer from the user-wide store before mutation. Playstack separately preflights and installs the transitive closure for concise capabilities after Megamono completes; a failure there preserves the initialized repository and prints the exact capability retry command.

After workspace-init succeeds, Megamono reads the local Nx graph for capability handoff. Conventional `apps/web` and `apps/api` projects win automatically; otherwise a sole matching `type:app` plus `platform:web|node` candidate is selected. Multiple candidates prompt interactively and exit `4` in automation unless the matching `--playstack-web` or `--playstack-api` path is supplied. A false value deliberately omits that surface. Every selected root is passed explicitly as `--web=<root>` or `--api=<root>`; Playstack never needs to infer Nx layout.

Playstack setup installs a missing `@playstack/cli` as a dev dependency, handles explicitly named full package IDs, delegates each concise capability to the repository-local `playstack add`, and finally invokes `playstack init`. For a direct yalc package, Megamono installs required third-party dependencies and peers first, adds the complete validated local Playstack closure at exact versions, rewrites copied internal dependency edges to sibling `file:` references, and only then hydrates through the selected package-manager adapter. Existing `file:.yalc/*` declarations are treated as satisfied. Capability commands instead receive `--local-packages=yalc` and retain Playstack ownership of recipe closure resolution. Neither path substitutes a registry version; a partial failure names completed commands and the exact retry. Playstack owns capability recipes, `playstack.json`, package detection, artifact targets, and all later sync/update behavior.

`--survey` remains write-free. With `--playstack`, it runs `playstack init --survey` only when the local Playstack CLI already exists; otherwise it reports the package additions and command that a real run would perform. It never installs from either source during a survey.

The global CLI never upgrades the plugin, runs a global Nx or Playstack binary, bypasses generator preflight, or contains a copy of either product's init logic. Unknown commands, invalid CLI-only values, and invalid Playstack package names exit `2`. Preflight/source failures exit `3`. Otherwise the CLI returns the delegated process status, including signal failures, without translating generator diagnostics. A failure after workspace-init prints the completed steps and exact retry command; it does not roll back Megamono-owned files.

Nested help is resolved before workspace discovery or interactive decisions. In particular, `megamono add database --help` prints the database generator options without requiring a database name, adapter, initialized workspace, or active package-manager preflight.

This design deliberately allows the globally installed CLI and repository-local plugin to update independently. The local plugin and local Nx version remain authoritative for workspace behavior; the CLI owns only command discovery, prompting, dependency preflight, package-manager selection, delegation, help, and version output. `create-megamono` invokes the same local `app` and `workspace-init` generators after it establishes the Nx workspace; it contains no second copy of an application preset or post-processing template.

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

Language plugins bridge the Nx 18–23 discovery transition:

- `createDependencies` parses local manifest dependencies and emits static project-graph edges.
- `createNodes` accepts Nx 18/19's async single-file callback and Nx 20+ batched files at runtime.
- `createNodesV2` aliases the same implementation because Nx 19 prefers it and Nx 21 requires the transitional export; later Nx versions ignore the extra alias.
- Every inferred target declares `inputs`, `outputs` when it writes files, `cache`, and enough metadata for `nx show project` to explain its source.

Generated target metadata is capability-gated from the installed Nx version. `parallelism` is emitted from Nx 19.5 onward, and `continuous` is emitted from Nx 21 onward. Older workspaces retain the underlying commands without unsupported metadata.

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

Selected modules declare their dependency and peer requirements as machine-readable ranges. Planning compares those ranges against every root dependency section before file mutation, retains compatible repository-owned declarations byte-for-byte, and identifies each missing installable dependency separately. Duplicate declarations, incompatible ranges, and unsupported local/protocol specifiers are preflight conflicts rather than implicit upgrades. Dependency installation remains a run-last operation after the complete plan has passed.

Commands emitted by a generator are package-manager-aware. npm, pnpm, Yarn, and Bun each use a single tested adapter for install, frozen install, executable, script, lockfile, workspace-discovery, and local-dependency syntax. pnpm uses `workspace:` declarations; npm, Yarn, and Bun retain package-json-workspace-compatible declarations. A generator never mixes command families or infers ownership from executable availability after the workspace contract has been recorded. Generated CI and health workflows inherit the workspace's committed Node and package-manager versions; when the manager version is undeclared, lockfile evidence such as Yarn Classic is preserved before falling back to the compatibility baseline. When Node is undeclared, the fallback is selected from the installed Nx major rather than the scaffold baseline.

Survey distinguishes committed toolchain ownership from the active host. It reports active Node plus every discoverable npm, pnpm, Yarn, and Bun version, resolves the workspace-selected manager, checks both values against Megamono support and valid repository declarations, and emits activation guidance without changing the host. Mutation rejects an unready host before generation; dry-run planning exposes the same issues as conflicts.

Private package routing is configuration, not a yalc deployment strategy. `megamono.json.packageSources.registries` maps user-selected scopes to HTTPS registries, and a bounded `.npmrc` section records only those routes. Authentication remains external. CI validation rejects development-only local package addresses and yalc state, requires the selected manager's committed lockfile, and verifies recorded routes before builds begin.

Megamono error classifications are stable: `0` success/no-op, `1` validation or execution failure, `2` invalid options, `3` preflight refusal, and `4` unresolved user decision in non-interactive mode. Standalone CLIs and executors use those values as process exit codes. Supported Nx generator runners may normalize a thrown generator error to process status `1`, so `nx generate` also exposes classifications `2`–`4` through the error object's `exitCode` and a stable diagnostic code. Packed-generator fixtures assert the runner status plus that diagnostic code; direct tests assert the programmatic classification.

## Compatibility and fixture tests

Each published package must pass:

- Unit tests for manifest parsing, option normalization, and conflict detection.
- Snapshot tests for generated trees; snapshots include `package.json`, `nx.json`, and `megamono.json` changes.
- Idempotency tests that run every generator twice.
- Failure-injection tests proving no file mutation occurs before preflight completes.
- An e2e test that packs the publishable package, installs it into a clean consumer workspace, and runs the generated targets.
- For language plugins, fixtures for workspace roots, leaf projects, local dependencies, renamed targets, missing toolchains, malformed manifests, and cycles.
- Graph assertions using `NX_DAEMON=false NX_CACHE_PROJECT_GRAPH=false nx graph --file=...` plus one `nx affected` assertion per dependency-edge kind.

The compatibility suite installs packed output—not workspace source aliases—against stable anchors for every supported Nx major, 17 through 23. Nx 17 exercises `@megamono/plugin`; Nx 18 onward also exercise the inference plugins. Each fixture runs init twice, adds and reruns named Prisma and Drizzle targets, checks target metadata capability gates, compiles a consumer TypeScript import, and runs core graph/check behavior. Nx 18 onward also add a Cloudflare binding fixture, while Nx 18–23 add the supported inference surfaces exercised by that anchor. Survey fixtures assert that unresolved project and documentation classifications produce stable, copy-ready adoption-map templates without writing them. A separately packed pnpm 11 portfolio fixture runs on Node 22 and 24 with the Nx 22.2/TypeScript 5.9 adoption anchor. It combines Next, Nest, inferred libraries, root Prisma with migrations, Docker, SwiftPM, Xcode with multiple named scheme targets, mature CI/release workflows, Content Collections, and a numbered specification corpus so the mixed-repository adoption contract cannot regress.

A scheduled and manually dispatchable `nx@next` plus `typescript@next` canary is non-blocking until that future line enters the declared peer range. Nx 24 is not supported merely because the canary starts: promotion requires replacing any removed/deprecated executor configuration exposed by the canary, updating peer and engine ranges, adding a stable Nx 24 anchor, and making the full packed matrix blocking for that line.

## Cross-product contracts

Playstack specifications are maintained in `org-playstack/playstack-pro`, which is the initial authoritative repository for the `playstack:` namespace. References use qualified IDs such as `playstack:08-data-and-prisma`, never filesystem paths or assumptions about a sibling checkout. Local docs validation syntax-checks those IDs; release gating relies on the published package contracts and fixtures below rather than requiring cross-repository access.

A Playstack-wiring generator ships only when the referenced package publishes:

- its install name and Free-tier availability,
- its runtime/framework compatibility,
- its configuration and environment contract,
- its database-schema artifact and declared format, when applicable,
- and a fixture package usable by Megamono e2e tests.

Until those artifacts exist, the generator name may be reserved but is not included in the published generator collection.

## Definition of build-ready

A spec is build-ready when it has `status: accepted`, no unresolved decision that changes its v1 output, an explicit v1 scope, failure behavior, and acceptance criteria. Future work may remain as a deferred section only when the v1 behavior is already fixed.

## Acceptance criteria

- Packed packages enforce the supported Node, npm/pnpm/Yarn/Bun, Nx, and TypeScript ranges. Mutation rejects unsupported or ambiguous root package-manager ownership, while survey remains available and platform-neutral core adoption does not reject a repository solely because of its host OS.
- `workspace-eject` preserves artifact content, changes only Megamono ownership metadata or managed-section delimiters, and prevents later plugin upgrades from reclaiming the artifact.
- Every public generator and executor name appears in this contract and resolves from a local-registry installation fixture.
- A packed `@megamono/cli` installed globally delegates mutation through npm and pnpm fixtures, forwards generator arguments unchanged, and propagates delegated exit status. Adapter tests cover Yarn and Bun command families, and core-only survey bypasses package-manager execution while remaining repository-local.
- Packed npm and pnpm fixtures prove `megamono add app web` and `megamono add app api` produce the same project contracts as `create-megamono`, are stable on rerun, preview without writes, reject incompatible occupied roots, and support a second named instance.
- Packed npm and pnpm fixtures prove named Prisma and Drizzle database projects use the shared create/add primitive, validate in their native formats, retain the canonical `type:data` graph contract, and keep Playstack artifact targets inside their selected Nx projects.
- Registry and yalc Playstack fixtures prove init-only options are consumed rather than forwarded, concise capabilities receive explicit Nx-resolved web/API roots, ambiguous automation refuses before Playstack mutation, explicit yalc packages install their complete local closure without registry fallback, `@playstack/cli` remains a dev dependency, the local `playstack` binary performs configuration, survey writes nothing, missing closure artifacts fail before workspace-init, and a post-init failure reports completed commands plus an exact recovery command.
- Generator fixtures prove deterministic planning, dry-run parity, idempotency, conflict handling, stable exit codes, and absence of secret values.
- Language-plugin fixtures prove the Nx 18–23 API bridge, deterministic project discovery, and affected graph propagation.
- Apple discovery ignores Xcode's generated `<name>.xcodeproj/project.xcworkspace` bundle and indexes the owning `.xcodeproj` only; standalone `.xcworkspace` manifests remain independently discoverable.
- Gated generators are absent from the published collection until their external contract fixtures pass.
- No core package has a runtime dependency on Playstack, an application framework, or Nx Enterprise.
