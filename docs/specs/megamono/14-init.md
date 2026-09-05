---
id: spec-megamono-0014
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [generators, lifecycle, docs, agents, lint, ci]
summary: Defines additive, modular adoption of Megamono in an existing Nx workspace.
date: 2026-08-24
supersedes: null
references:
  [
    spec-megamono-0000,
    spec-megamono-0002,
    spec-megamono-0003,
    spec-megamono-0004,
    spec-megamono-0005,
    spec-megamono-0006,
    spec-megamono-0008,
    spec-megamono-0009,
    spec-megamono-0011,
    spec-megamono-0015,
  ]
external_references: [playstack:45-cli]
---

# 14 — Init: Existing Nx Workspace → Megamono

## Three entry points

| Situation                               | Path                                     |
| --------------------------------------- | ---------------------------------------- |
| New repository                          | `create-megamono` (`spec-megamono-0002`) |
| Existing package repository, not yet Nx | `nx init`, then convert (`0009`)         |
| Existing, established Nx workspace      | `workspace-init` (this spec)             |

`create-megamono` never modifies an existing repository. Convert owns structural adoption, including moving a single application into the accepted workspace shape. `workspace-init` owns an Nx workspace whose project structure already works and needs only Megamono's repository-governance layers.

## Invocation and prerequisites

```text
npm install --save-dev @megamono/plugin
npm install --global @megamono/cli
megamono init
```

For an established workspace, the preferred CLI surface is safe-by-default:

```text
megamono adopt
megamono adopt --only=health,inference,lint --dry-run
megamono adopt --only=health,inference,lint --write --yes
```

`adopt` delegates to this same generator. With no execution-mode flag it adds
`--survey`; `--dry-run` returns the ordered operation plan; and `--write`
removes the safety alias before delegation so the normal clean-branch,
decision, and confirmation requirements remain authoritative. There is no
second adoption implementation.

The direct generator invocation remains supported for repository-local automation:

```text
npm exec nx -- generate @megamono/plugin:workspace-init
```

`megamono init` is a thin global dispatcher. It requires the repository-local plugin, selects root package-manager ownership from an unambiguous lockfile or matching `packageManager` declaration, consumes only its documented Playstack routing options, forwards every other init option, and returns the local Nx process status. The core path does not install dependencies or weaken mutation preflight; explicitly requested post-init Playstack setup may install the packages described in its separate handoff contract. A core-only survey uses the local Nx binary directly through Node and therefore does not require the active package-manager executable to be compatible. After initialization, the same dispatcher exposes additive repository and application operations without duplicating generator behavior.

```text
megamono add app web
megamono add app api --name=admin-api
megamono add database events --adapter=drizzle
megamono add docs
megamono add ci
megamono add skills
```

Module add commands delegate to `workspace-init --only=<module>`. Application add delegates to the canonical `@megamono/plugin:app` generator from `spec-megamono-0003`; database add delegates to `@megamono/plugin:database` with a user-defined logical name and explicit or prompted adapter. Add commands require the initialized baseline rather than silently running init, inherit the same clean-worktree and branch safety rules, preview by default, and support `--dry-run` plus fully explicit `--interactive=false --yes` automation.

### Optional Playstack handoff

Existing monorepos may adopt repository governance and then run Playstack's package-owned setup in one command:

```text
megamono init \
  --playstack \
  --playstack-packages=auth,accounts \
  --playstack-web=apps/web \
  --playstack-api=apps/api \
  --local-packages=yalc
```

Megamono completes first. The dispatcher treats concise names as Playstack capabilities and delegates each to `playstack add <name> --yes`; Playstack therefore owns the recipe, prerequisites, application mutations, and transitive package closure. Before delegation, Megamono reads the local Nx project graph and passes explicit `--web=<root>` and `--api=<root>` bindings. It selects conventional `apps/web` and `apps/api` roots first, otherwise selects a sole tagged application, and prompts when multiple candidates remain. Non-interactive ambiguity exits `4` and requires `--playstack-web=<root>` or `--playstack-api=<root>`; either flag accepts `false` to omit that surface deliberately. These flags are consumed by the dispatcher and never reach `workspace-init`.

Full `@playstack/*` names are an explicit direct-package escape hatch and do not invoke capability recipes. The dispatcher then invokes the repository-local `playstack init`. It does not interpret Playstack artifacts or write `playstack.json`.

Registry is the default source. In yalc mode Megamono preflights the missing Playstack CLI before workspace-init and forwards `--local-packages=yalc` to every capability command. Playstack owns preflight of each capability's transitive closure. For an explicit full package, Megamono instead preflights all required local Playstack dependencies and peers before init, installs the closure's required third-party dependencies first, links every missing local package at the validated version, converts copied internal dependency edges to local `file:` references, and then hydrates the selected package manager. Existing `file:.yalc/*` declarations are satisfied and never replaced. A closure or capability failure after Megamono initialization leaves the adopted repository intact and prints completed commands plus the exact retry rather than claiming that the repository was rolled back.

When a terminal is interactive, a bare `--playstack-packages` opens a multiselect of supported Playstack capabilities. The chosen short names enter the same delegation path as explicit values. Non-interactive callers must provide a comma-separated value; a valueless selector exits `2` instead of waiting for input.

For a survey, no packages are installed. An already-installed Playstack CLI contributes its own read-only survey; otherwise the Megamono report lists the deferred package and command plan.

The composite command treats `--dry-run` as an end-to-end transaction boundary. Megamono may inspect the Nx graph and local package metadata, but it never installs either CLI or capability packages. When a local Playstack CLI is already present, each capability receives `--dry-run` and final initialization uses the read-only survey; otherwise Megamono prints the exact deferred package and capability plan.

Existing-workspace mutation uses the adoption baseline from `spec-megamono-0000`: Node `>=18.18 <25`; npm `>=9 <12`, pnpm `>=8 <12`, Yarn `>=1.22 <5`, or Bun `>=1.1 <2`; Nx `>=17 <24`; and TypeScript `>=5.2 <7`. Core adoption is operating-system-neutral. Platform-specific generators and targets apply their own host gates instead of disqualifying the repository. Optional Playstack setup applies its narrower Node `>=20` gate only when requested, plus ESLint `^9` only when the explicit `@playstack/lint` package is selected; these constraints never narrow core Megamono adoption. Inference plugins require Nx 18 or newer; an Nx 17 workspace can adopt the core modules and receives an explicit capability reduction for detected Apple, Cargo, or Cloudflare manifests.

Eligibility, mutation safety, and host readiness are separate decisions. Any established Nx repository with the local plugin can be surveyed, including one with no recognized manager, an unavailable global manager, a dirty tree, or an untested future Nx version. Mutation additionally requires supported Nx and TypeScript versions, unambiguous root ownership, a supported active Node and selected package-manager binary, a valid project graph, a clean worktree, and a non-default named branch. Nested project lockfiles are ignored for root ownership; conflicting root managers refuse. If the lockfile identifies the manager but `package.json#packageManager` is absent, init records the inferred manager only in `megamono.json`. It never adds, replaces, or upgrades the repository's manager declaration. Package-manager migration is a separate explicit operation. `--toolchainPin=nvmrc|node-version|both --toolchainNode=<exact-version>` may add explicit repository-owned runtime pins after the same conflict preview.

Survey inventory honors repository `.gitignore` rules, including nested ignore files, and always excludes generated dependency/build surfaces such as `.git`, `.nx`, `.yalc`, `.build`, `.next`, `DerivedData`, `node_modules`, `dist`, and coverage output. Dependency checkouts and ignored generated Markdown never affect document counts, classification, or adoption maps.

The survey embeds `inventory.schemaVersion: 1` as the stable integration handoff. Inventory is derived per Nx project rather than from repository-root markers. It records project roots and targets alongside nested Next router, Nest, Expo/React Native, and Vite evidence; imported external package names; environment-variable names but never their values; named or unresolved Prisma schema contexts and migration roots; Redis and BullMQ consumers; and explicit Docker or Render deployment markers. Generated Prisma schema copies are identified from client-generator output, Nx output roots, and generated-directory conventions, then reported as derivatives of the owning source context rather than separate databases. Render inventory includes declared service names, explicit roots, and exact Nx project candidates referenced by Blueprint commands. A committed `render.services.json` may inventory dashboard-owned services using the same non-secret service shape. A Procfile without either inventory or `render.yaml` is only a `partial-marker`, because dashboard-owned Render services cannot be reconstructed from repository files. Multiple unnamed database contexts and other incomplete topology are returned as `inventory.ambiguities`; survey never invents product-purpose names or deployment services to make the report appear complete.

The same survey includes one capability assessment per adoption module. Each assessment names detected evidence, the Megamono equivalent, whether existing behavior is compatible as-is, configuration that can be imported, files a selected module may modify, and conflicts requiring a decision. This section is deterministic in both Markdown and JSON and remains a report rather than authorization to mutate.

This contract is the repository-side input for Playstack integration planning. Megamono may pass the versioned inventory and explicit Nx destinations to Playstack, but package-specific routes, provider tokens, environment requirements, source templates, and artifact lifecycle remain Playstack-owned. An installed package may publish `playstack.integration.json` version 1 plus package-contained source templates. `megamono add integration --packages=<names> --web=<root> --api=<root> --dry-run` validates the manifest/package version pair and each template digest before reporting the structured requirements. Adapter and persistence conditions are selected explicitly; human-readable conditions and required decisions remain unresolved until supplied by the caller. An accepted `--yes` run copies only active templates into application-owned targets and records the resolved plan, migration phase, existing application references, and suggested per-integration commit boundaries under `.megamono/`. Existing unequal targets, duplicate destinations or routes, incompatible environment/config declarations, missing templates, digest drift, unsupported placeholders, unresolved choices, and absent surface selections fail before mutation. Megamono never invents the wiring, patches a repository-owned composition root, or interprets database-model collisions, and it does not copy capability recipes into its plugin.

## Additive and modular

> **Init never moves an existing path. It adds governance layers and changes an existing file only after identifying the exact edit in its preview.**

Every execution installs a small baseline: `megamono.json`, the `megamono` project with `check` and `import` targets, plugin compatibility metadata, and the selected module records. Modules are otherwise independently selectable.

`--profile=minimal|pilot|platform|full` provides named shortcuts without changing module behavior. `minimal` selects `lint,health`; `pilot` selects `lint,health,inference` for a mature repository without claiming CI or release ownership; `platform` selects `ci,release,lint,health,inference`; and `full` selects every module. A profile and `--only` are mutually exclusive. The ordered plan includes one suggested commit batch per selected module, attaching baseline changes to the first batch. Suggested batches contain exact targets and a commit subject, but the generator never stages or commits repository files.

The independently selectable modules are:

| Module      | Adds or configures                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs`      | Centralized corpus directories, collision-free Content Collections integration, indexes, and `megamono-docs` targets (`spec-megamono-0004`, `spec-megamono-0011`) |
| `agents`    | A managed section in `AGENTS.md`, a safe `CLAUDE.md` pointer when possible, and `docs/DESIGN.md`                                                                  |
| `ci`        | Retains equivalent repository CI by default, or adds a standalone/reusable affected-CI workflow owned by Megamono                                                 |
| `release`   | Nx Release groups and tag strategy for publishable packages, a private prerelease workflow, and yalc-from-dist local package vetting                              |
| `lint`      | Project-tag completion, project-graph structural checks, and ESLint wiring (`spec-megamono-0006`)                                                                 |
| `skills`    | Managed portable skills under `.agents/skills` and the `.claude/skills` projection (`spec-megamono-0005`)                                                         |
| `health`    | The deterministic scheduled health workflow and local health target (`spec-megamono-0008`)                                                                        |
| `inference` | Supported Apple, Cargo, or Cloudflare plugins when corresponding manifests are detected (`spec-megamono-0003`, `spec-megamono-0015`)                              |

```text
npm exec nx g @megamono/plugin:workspace-init --only=docs,agents
```

`--only` accepts a comma-separated set of module names. Omitting it starts the guided flow. Selecting a module never silently selects another: when a capability is reduced because another module is absent, the preview names the reduction. For example, `health` without `docs` disables the spec-drift and stale-plan checks but can still run dependency-alignment and orphan checks.

The baseline `megamono:check` target is capability-aware. Documentation lifecycle/front-matter checks run only after `docs` is adopted, while tag cardinality, naming, and type/scope/platform graph rules run only after `lint` is adopted. Core managed-artifact integrity, package-source safety, installed-skill validation, inference preflights, and Megamono/Playstack package-direction checks remain available independently. Thus an `agents,skills` adoption is valid without retroactively imposing documentation metadata or project tags.

The `ci` module never replaces or inserts unbounded text into an existing general-purpose workflow. In the default `--ciMode=auto`, a repository workflow that runs lint, test, and build through either Nx affected commands or a mature full-workspace `run-many` is retained and no duplicate workflow is added. `--ciMode=standalone` writes `.github/workflows/megamono-ci.yml`; `--ciMode=reusable` writes the bounded `.github/workflows/megamono-ci-reusable.yml` with only `workflow_call`, leaving caller integration repository-owned. Generated workflows inherit the committed Node version from `.node-version`, `.nvmrc`, or `engines.node`, and the manager version from `packageManager`. When Node is undeclared, init chooses the tested fallback for the installed Nx major. An occupied selected target is an owned-path conflict, not permission to overwrite it.

## Artifact ownership and provenance

Ownership follows the artifact's semantic lifecycle, not its file extension or the fact that a generator created it:

| Mode              | Contract                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `managed`         | Megamono owns the complete artifact and may update it only while its installed hash still matches.               |
| `managed-section` | Megamono owns only the bytes between exact start and end delimiters in an otherwise repository-owned file.       |
| `seeded`          | Megamono creates an initial artifact once; the repository owns it immediately and no plugin upgrade rewrites it. |
| `derived`         | The artifact is deterministic output from canonical repository state and is regenerated rather than edited.      |

The committed registry `.megamono/artifacts.json` is the authority for the lifecycle of Megamono-emitted workspace artifacts. It has schema version `1` and a stable, ID-sorted `artifacts` array. Each entry records `id`, `module`, `mode`, `target`, `sourceVersion`, `templateHash`, `installedHash`, `state: managed|seeded|derived|ejected`, and `ejectable`. A `managed-section` entry additionally records its exact start and end delimiters. A managed file set, such as a skill, records a stable, explicit `files` array under its target directory. Hashes are SHA-256 values prefixed with `sha256:`; a whole-file hash covers exact bytes, a section hash covers only the bytes inside its delimiters, and a file-set hash covers each sorted relative path, byte length, and file content. A symlink hash covers its normalized relative target.

Artifact IDs match `^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$` and remain stable when a target path changes. V1 reserves `agents.instructions`, `agents.claude-pointer`, `ci.affected`, `release.workflow`, `release.yalc-publisher`, `health.workflow`, `docs.loader`, `docs.index`, `docs.archive-index`, and `skill.<name>` for their corresponding artifacts.

Creating a directory never grants Megamono ownership of later descendants. Registry entries name files, symlinks, bounded sections, or an explicit file set; unlisted descendants are always repository-owned. The registry is committed and validated by `megamono:check`, but is not an entry in its own array and therefore has no self-referential hash.

The canonical examples are:

| Artifact                                             | Mode              |
| ---------------------------------------------------- | ----------------- |
| `megamono.json`                                      | `seeded`          |
| Megamono Nx project configuration                    | `managed`         |
| `.github/workflows/megamono-ci.yml`                  | `managed`         |
| `.github/workflows/megamono-health.yml`              | `managed`         |
| Megamono instructions within an existing `AGENTS.md` | `managed-section` |
| A `CLAUDE.md` pointer created by Megamono            | `managed`         |
| Installed portable skills                            | `managed`         |
| `docs/DESIGN.md` and new document skeletons          | `seeded`          |
| `docs/INDEX.md` and archive indexes                  | `derived`         |

Playstack keeps a separate domain. `@playstack/cli` owns artifacts required by Playstack packages and their update/eject/merge state. Megamono owns repository-governance artifacts and may invoke the Playstack CLI, but `.megamono/artifacts.json` never mirrors or interprets `playstack.artifacts.json`, `.playstack/base`, or `playstack.json`. Human-authored product and organizational content is repository-owned regardless of which tool created its initial skeleton.

### Ejection

```text
npm exec nx g @megamono/plugin:workspace-eject --artifact=agents.instructions
```

`workspace-eject` accepts one exact artifact ID plus `--dry-run`. It preserves the current content. For a whole file or symlink it removes any embedded Megamono provenance while leaving the target in place; for a managed section it removes only the delimiters and retains the section body in place; for a managed file set it leaves every listed and unlisted file unchanged. It then records `state: ejected` in the registry. Ejected artifacts are repository-owned, excluded from managed drift, and never reclaimed by workspace-init or a plugin upgrade.

The command refuses unknown and `ejectable: false` artifacts before mutation. An already-ejected artifact is a successful no-op, preserving generator idempotency. `skill-eject --name=<name>` remains the ergonomic skill-specific command and delegates to the same ownership library and registry transition. There is no implicit re-adoption in V1.

## Survey before trust

Every run begins with the same deterministic survey:

Project-local WXT configurations, browser manifests (Manifest V2/V3), and
Figma plugin manifests are distinct inventory evidence. Figma plugins use the
general `platform:extension` classification; they do not enable browser
extension build targets. Unrelated PWA manifests are not extension evidence.
Next router mode is reported as Pages, App, or mixed. Nest API and queue-worker
roles are reported independently, including applications hosting both; queue
hosting does not change a Node project's platform to Cloudflare `worker`.

- resolved Nx project names, roots, evidence-backed application/library types, per-project platforms, targets, and tags;
- root package-manager ownership and active package-manager, Node, Nx, and TypeScript versions;
- supported and unsupported non-JavaScript manifests;
- existing docs roots, corpus-like directories, and Markdown files;
- existing `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, and skill directories;
- existing CI, health, ESLint, nested Content Collections loaders, and Megamono configuration;
- every path or config key a selected module would add or modify.

```text
megamono init --survey
```

`--survey` prints the report and exits with zero repository writes, no generated repository cache, and no Git operation. If `@megamono/plugin` is absent, the global CLI may install the matching plugin and workspace Nx version into a disposable operating-system temporary directory from the selected registry or Yalc source; this bootstrap is removed after the survey and never changes the repository manifest, lockfile, `node_modules`, or `.yalc` state. When invoked through the real generator it reports the active host platform, Node, and all discoverable package-manager versions separately from the committed workspace baseline. It marks the selected manager ready or not ready and supplies exact activation guidance when a committed Corepack declaration or Node pin exists. `--format=json` emits the same readiness data in a stable machine-readable form for portfolio triage; the default is human-readable Markdown. Both forms include copy-ready project and documentation adoption-map templates. Inferred values are populated, while unresolved types, platforms, lifecycle IDs, and dates use conspicuous review placeholders that must be replaced before the map can pass init validation.

## Guided flow

The default flow follows the adaptive-prompting rule from `spec-megamono-0002`:

1. Show the survey before asking a question.
2. Ask which modules to adopt. Safe additive modules may be recommended, but any module that edits an existing file starts unchecked.
3. Ask only about unresolved choices for the selected modules.
4. Show the complete ordered plan and diff summary.
5. Require explicit confirmation, then apply the same plan.

Inference is never a prompt. Root lockfiles and `packageManager` declarations identify package-manager ownership, resolved Nx metadata identifies projects and targets, manifests identify relevant inference plugins, and existing tags identify the current vocabulary. A prompt is permitted only when two valid outcomes remain.

The preview may be skipped only with `--yes`. `--yes` is not an answer to an ambiguity: non-interactive execution must also provide `--only` and every option named as unresolved by the survey. Missing input exits with programmatic classification `4` and the stable diagnostic `workspace-init-decision-required`.

Before any tree mutation, init compares every selected module's required dependencies and peers with all declarations in the root `dependencies`, `devDependencies`, and `peerDependencies`. Compatible existing ranges are retained exactly. Missing installable dependencies are listed individually in the plan and added only after all conflicts pass. Incompatible ranges, non-semver protocols where a registry range is required, or duplicate declarations across dependency sections block adoption with the current and required ranges in the diagnostic. Init never treats an adoption run as permission to upgrade an existing major.

## Existing conventions

Init adapts rather than normalizing for its own sake:

- Existing project names, roots, target names, and library names remain unchanged. Project classification considers Nx `projectType`, tags, `tsconfig.app.json`/`tsconfig.lib.json`, root placement, framework files, and lifecycle targets; a package-inferred library under `libs/` is never defaulted to an application.
- Existing `type:`, `scope:`, `platform:`, and `visibility:` tags remain unchanged when valid. Missing required tags are proposed using `--defaultScope` and evidence-based per-project platform inference. A non-executable root Nx project is treated as workspace tooling (`type:util`) without projecting root dependency evidence onto it. E2E applications inherit a platform only when their explicit `implicitDependencies` resolve to one unambiguous application platform. `--defaultPlatform` is only a fallback. Conflicting or incomplete evidence requires an explicit `--adoptionMap=<json>` whose project entries resolve `type` and, for applications, `platform`; one workspace-wide platform answer never flattens a mixed repository.
- The Nest feature-library convention applies to newly generated libraries only. Renaming existing libraries and imports is outside init.
- Supported `Package.swift`, `Cargo.toml`, and Wrangler configuration surfaces produce an inference-plugin offer. A surface without a shipped plugin is reported as a graph-confidence gap.

Generated documentation is centralized under `--docsRoot=docs`, matching the settled location in `spec-megamono-0004`. Init does not reopen the centralized-versus-colocated decision.

## Existing documentation

Existing docs are inventoried but never moved automatically. The survey classifies high-confidence candidates—ADR/decision directories, RFC/research directories, records already carrying lifecycle metadata, and numbered records under recognized `specs`, `plans`, `decisions`, `audits`, `research`, or `reports` directories. Numbered specifications receive a deterministic stable-ID proposal derived from the workspace scope and ordinal. Low-confidence files remain listed as unclassified.

When adopted specifications use a stable product identifier rather than repository-qualified Nx project names, the repository may add an explicit `health.projectAliases` mapping. Health expands that reviewed mapping during coverage checks; workspace initialization does not infer aliases from similar prefixes or rewrite existing document metadata.

`--docsAdoptionMap=<json>` applies an explicitly reviewed path-to-metadata map during the docs module. The survey's `adoptionTemplates.documentation` object has the accepted outer shape and provides deterministic starter metadata for every high-confidence classification. Every entry must provide a complete valid lifecycle record after merging with existing front matter; unsafe or missing paths, malformed lifecycle IDs, incomplete metadata, and duplicate IDs are plan conflicts. Application changes only front matter and preserves the document's stable path and body. A partially adopted corpus is valid: existing docs may remain where they are while new Megamono records use the canonical corpus.

For each Render service without `rootDir`, the survey emits `adoptionTemplates.render.serviceProjects`. A sole exact Nx project reference in the service's declared build/start/pre-deploy commands seeds its project and root; absent or ambiguous evidence remains a `<review-…>` placeholder. Selecting inference requires the reviewed map through `--renderServiceProjects='<json>'`. Init rejects unknown services, missing projects, unsafe roots, and roots that differ from Nx project configuration before mutation, then records the mapping only in the `@megamono/nx-render` plugin options. It never adds `rootDir` to the repository-owned Blueprint or changes the command working directory.

The docs plan discovers Content Collections loaders anywhere in the workspace and checks requested TypeScript aliases and output paths before acceptance. The survey identifies repository-owned loaders and supplies copy-ready separate `--docsLoader`, `--docsModule`, and `--docsOutput` flags instead of merely reporting the collision. When an application already owns the conventional loader, Megamono selects or accepts those separate values. `--docsLoaderMode=adopt` is allowed only for an explicitly selected loader that already exposes the compatible repository and archive collections; adopted loader bytes remain repository-owned. The `docs` module owns its repository-docs loader/configuration plumbing only when it creates those complete files. This does not include content-level emissions owned by Playstack. `docs/DESIGN.md` and every generated document skeleton are seeded and immediately repository-owned. Indexes are derived. The IA directories themselves confer no ownership over their contents.

## Existing database projects

`megamono add database <name> --adapter=prisma|drizzle` accepts `--schema=<path>` and otherwise detects established adapter layouts before proposing a new project. A root `prisma/schema.prisma` is adopted in place with its migration history, generated client ownership, package scripts, Docker commands, and CI commands untouched. Megamono adds only the bounded Nx validation project. For an established Prisma layout, Playstack artifact composition remains deferred unless an existing target is retained or the repository explicitly supplies a compatible `--target`; structural adoption alone never implies that a new fragments directory participates in the Prisma schema input. An explicit Prisma target must contain the configured schema entry, so `prisma` is valid for `prisma/schema.prisma` while `prisma/models` is rejected. Existing Prisma and TypeScript specifiers are reused; adopting Prisma 6 never proposes Prisma 7. ORM upgrades are separate explicit repository work.

Repositories that deliberately want the context-package convention run a second, explicit operation:

```text
megamono add database primary --adapter=prisma --relocate --dry-run
megamono add database primary --adapter=prisma --relocate --yes
```

The default destination is `libs/prisma/primary`, with the complete schema and migrations under `libs/prisma/primary/prisma`. `--directory` selects another project root. Relocation preserves migration bytes and installed dependency specifiers, converts an already adopted root project to the context project, updates exact command references and the Playstack target, and writes compatible root and project-local Prisma configuration. It does not execute validation, generation, migration creation, or migration application during the tree mutation. An optional `--client-output=src/generated` updates the existing `generator client` output explicitly; without that flag, generated-client ownership and application imports remain unchanged. The same relocation command is idempotent after completion.

When no established layout is selected, the adapter default is `libs/<adapter>/<name>` with a separate package, schema or schema-module root, migrations, generated output, and Nx project for every logical context. The generator registers the exact nested root in npm, pnpm, Yarn, or Bun workspace configuration rather than assuming `packages/*`. Generated Nx targets invoke installed adapter binaries directly and never run a package-manager dependency-status preflight.

## Package sources and CI

Yalc is a development transport only. `--packageRegistries='{"@megamono":"https://…","@playstack":"https://…"}'` records scope routing in `megamono.json` and a managed, non-secret `.npmrc` section. Authentication tokens and environment bindings remain repository/CI-owned. Package-source policy has four explicit profiles: `development` permits local references, `migration` permits and warns with exact replacement locators, `ci` rejects local references except exact fixture locators approved in configuration, and `release` rejects every local reference without exceptions. `megamono:check --ci` is retained as the `ci` alias, while `CI=true` selects `ci` only when no explicit profile is passed. CI and release require the recorded manager's lockfile and verify every configured scope route. All profiles inspect every package manifest's dependency fields, npm/Yarn `overrides` and `resolutions`, package-level pnpm overrides/catalogs, and root `pnpm-workspace.yaml` overrides/catalogs so a package-manager redirect cannot hide a development source.

An existing repository-contained `.tgz` with an exact semantic version in its filename is accepted by the `ci` profile. Other CI exceptions are exact `<manifest>#<dependency-location>` locators under `packageSources.profiles.ci.approved`; approval is deliberately address-specific and also permits the required Yalc state when every detected Yalc reference is approved. The `release` profile ignores approvals and rejects tarballs, Yalc, links, portals, and file dependencies. Workspace protocol references remain valid for packages built from the same repository. The check never contacts a registry, opens an archive, or prints credentials; application and CI policy remain responsible for provenance and artifact signing.

## Existing agent files

- If `AGENTS.md` is absent, the `agents` module creates a seeded repository-owned file containing a managed Megamono section. If present, init appends only that delimited managed section after preview approval and preserves all existing content outside it.
- Generated instructions reference `docs/INDEX.md` only when that index exists. An agents-only adoption instead points to its seeded `docs/DESIGN.md` and existing repository guidance.
- If `CLAUDE.md` is absent, init creates the supported pointer to `AGENTS.md` as a managed artifact. An existing pointer remains repository-owned and unchanged. A substantive `CLAUDE.md` or `.cursorrules` is never replaced or merged automatically; the survey reports duplicated instructions and a follow-up proposal.
- Existing skills with a conflicting name block installation of that managed skill. Init never relies on undefined duplicate-name precedence.

## Lint adoption

Fresh `create-megamono` workspaces use the default severities from `spec-megamono-0006`. An existing workspace may adopt newly enabled structural rules at warning severity so the adoption commit does not fail on pre-existing violations.

Flat ESLint configuration receives the Megamono plugin wiring. A workspace using `.eslintrc*` keeps that configuration byte-for-byte and records an `eslint-rule-wiring` capability reduction with migration guidance; project tags, `megamono:check`, and other structural validation remain available. Init never performs an implicit ESLint flat-config migration.

The adoption decision records the affected rules, initial counts, and the intended ratchet. The health report keeps the temporary warning overrides visible until each becomes an error or receives a separate accepted decision. Stylistic warnings remain warnings.

## Health and external commands

The `health` module emits the local target and scheduled workflow but does not run or publish health findings during initialization. The completion report prints the exact local command and offers it as a separate next step.

All file/config preflight completes before the Nx tree is flushed. Mutation requires the active Node and selected package-manager versions to satisfy both Megamono's supported ranges and valid repository declarations; a dry run carries the same host-readiness issues into its conflict report. Package installation and any ecosystem command run last, as required by `spec-megamono-0000`. Init never commits, pushes, opens a pull request, invokes a model, contacts Springbar, runs a database migration, or deploys.

## Re-running and recovery

Init is idempotent and resumable. A later run detects installed modules, skips current managed artifacts, regenerates derived artifacts, and plans only missing or safely upgradable managed pieces. Seeded and ejected artifacts are never rewritten. A modified managed artifact is preserved, reported with a diff, and points to `workspace-eject`; `--force` cannot reclaim it. A missing managed artifact is recreated only in an explicitly confirmed plan for its selected module.

The completion summary lists modules adopted or skipped, paths added or modified, conventions retained, confidence gaps, and follow-up commands. `--report=<path>` persists the same Markdown only when explicitly requested. If an external command fails after tree flush, `MEGAMONO-RECOVERY.md` records the completed steps and exact retry command; init never attempts an automatic rollback.

## V1 decisions

- `workspace-init` is the only canonical generator name; `@megamono/workspace:init` is not an alias. `megamono init` delegates to that generator and is a CLI command, not a second generator alias.
- `megamono add <module>` is a CLI route into `workspace-init --only=<module>`, `megamono add app <type>` routes into the canonical `app` generator, and `megamono add database <name>` routes into the canonical database generator. The CLI owns no mutation templates.
- Survey classification is conservative and proposal-only. Init never migrates existing docs.
- Existing substantive agent files are preserved for explicit follow-up rather than merged by heuristic.
- `ci` is an independent module and uses a dedicated managed workflow; init never takes ownership of an existing repository workflow.
- Init offers but does not run repository health after adoption.
- Existing Nest libraries are never renamed by init.
- Partial module adoption is supported and recorded in `megamono.json`.
- Core adoption supports Nx 17–23 without forcing a repository upgrade; async language inference begins at Nx 18.
- Unsupported target metadata is omitted by installed-Nx capability, and generated workflows inherit repository toolchain declarations.
- Legacy `.eslintrc*` configuration is retained with an explicit capability reduction.
- `.megamono/artifacts.json` is the sole authority for Megamono workspace-artifact ownership. Playstack artifact state remains external.
- `workspace-eject` is the only general ownership transition in V1; there is no implicit re-adoption or force-reclaim path.

## Acceptance criteria

- New, established, and mixed-platform Nx fixtures produce stable survey JSON and the correct module availability.
- `--survey` is byte-for-byte stable and writes no file, cache, lockfile, branch, or dependency.
- Guided preview and non-interactive execution produce the same ordered plan for equivalent answers.
- Dirty/default-branch execution, unsupported baselines, unresolved decisions, conflicting owned paths, and substantive alternate agent files fail or defer exactly as specified before mutation.
- Each module is independently idempotent; every supported module subset either works or reports its documented capability reduction.
- Survey fixtures exclude ignored Swift `.build` dependency documentation and other repository-ignored output.
- Expo and React Native applications infer `platform:mobile`; native Swift/Xcode applications retain `platform:apple`.
- Existing project names, roots, valid tags, targets, docs, and agent content survive unchanged unless their exact edit was approved in preview.
- Every emitted artifact is classified as managed, managed-section, seeded, or derived; registry hashes, delimiters, IDs, and ordering are deterministic.
- Updating pristine managed artifacts succeeds, while modified, seeded, and ejected artifacts remain byte-for-byte unchanged; derived artifacts regenerate from canonical input.
- `workspace-eject --dry-run` and execution produce the same ownership plan, preserve content, and never affect Playstack-owned artifacts.
- Init never moves an existing path, and docs classification never applies during init.
- Temporary structural warnings remain visible to health until ratcheted or covered by an accepted decision.
- A failed external command writes recovery guidance without committing, pushing, or rolling back repository-owned changes.
- Playstack capability handoff passes explicit Nx project roots, resolves a sole candidate deterministically, and exits `4` before Playstack mutation when automated selection is ambiguous.
- A composite Playstack `--dry-run` performs no package installation and delegates only read-only Playstack planning commands.
- A direct-package yalc handoff validates the complete local closure before init and hydrates it through the selected package-manager adapter without requesting an unpublished Playstack dependency from the registry; packed npm and pnpm fixtures remain the exhaustive registry-escape contract.
