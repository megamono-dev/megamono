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
  ]
external_references: [playstack:45-cli]
---

# 14 — Init: Existing Nx Workspace → Megamono

## Three entry points

| Situation                           | Path                                     |
| ----------------------------------- | ---------------------------------------- |
| New repository                      | `create-megamono` (`spec-megamono-0002`) |
| Existing npm repository, not yet Nx | `nx init`, then convert (`0009`)         |
| Existing, established Nx workspace  | `workspace-init` (this spec)             |

`create-megamono` never modifies an existing repository. Convert owns structural adoption, including moving a single application into the accepted workspace shape. `workspace-init` owns an Nx workspace whose project structure already works and needs only Megamono's repository-governance layers.

## Invocation and prerequisites

```text
npm install --save-dev @megamono/plugin
npm install --global @megamono/cli
megamono init
```

The direct generator invocation remains supported for repository-local automation:

```text
npm exec nx -- generate @megamono/plugin:workspace-init
```

`megamono init` is a thin global dispatcher. It requires the repository-local plugin, selects the local package manager from the lockfile, forwards all init options, and returns the local Nx process status. It does not install dependencies or weaken the preflight below. After initialization, the same dispatcher exposes additive repository and application operations without duplicating generator behavior.

```text
megamono add app web
megamono add app api --name=admin-api
megamono add docs
megamono add ci
megamono add skills
```

Module add commands delegate to `workspace-init --only=<module>`. Application add delegates to the canonical `@megamono/plugin:app` generator from `spec-megamono-0003`. Add commands require the initialized baseline rather than silently running init, inherit the same clean-worktree and branch safety rules, preview by default, and support `--dry-run` plus fully explicit `--interactive=false --yes` automation.

### Optional Playstack handoff

Existing monorepos may adopt repository governance and then run Playstack's package-owned setup in one command:

```text
megamono init \
  --playstack \
  --playstack-packages=auth,accounts \
  --local-packages=yalc
```

Megamono completes first. The dispatcher normalizes concise product names and full `@playstack/*` package names to canonical package IDs, then installs only missing requested Playstack packages from the selected source and invokes the repository-local `playstack init`. It does not interpret Playstack artifacts or write `playstack.json`. Registry is the default source; yalc is an explicit all-local contract and fails preflight when any requested artifact is absent from the yalc store.

When a terminal is interactive, a bare `--playstack-packages` opens a multiselect of supported Playstack products. The chosen short names enter the same normalization and preflight path as explicit values. Non-interactive callers must provide a comma-separated value; a valueless selector exits `2` instead of waiting for input.

For a survey, no packages are installed. An already-installed Playstack CLI contributes its own read-only survey; otherwise the Megamono report lists the deferred package and command plan.

Existing-workspace adoption uses the adoption baseline from `spec-megamono-0000`: Node `>=18.18 <25`, npm `>=9 <12` or pnpm `>=8 <12`, Nx `>=17 <24`, TypeScript `>=5.2 <7`, and macOS or Linux. Inference plugins require Nx 18 or newer; an Nx 17 workspace can adopt the core modules and receives an explicit capability reduction for detected Apple, Cargo, or Cloudflare manifests. An unsupported or ambiguous lockfile, unsupported toolchain, malformed project graph, dirty worktree, or execution on the default branch refuses before mutation. `--survey` is read-only and may run on a dirty or default-branch worktree.

## Additive and modular

> **Init never moves an existing path. It adds governance layers and changes an existing file only after identifying the exact edit in its preview.**

Every execution installs a small baseline: `megamono.json`, the `megamono` project with `check` and `import` targets, plugin compatibility metadata, and the selected module records. Modules are otherwise independently selectable:

| Module      | Adds or configures                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs`      | Centralized corpus directories, Content Collections config, indexes, and `megamono-docs` targets (`spec-megamono-0004`, `spec-megamono-0011`) |
| `agents`    | A managed section in `AGENTS.md`, a safe `CLAUDE.md` pointer when possible, and `docs/DESIGN.md`                                              |
| `ci`        | A dedicated affected-CI workflow owned by Megamono; existing repository workflows remain untouched                                            |
| `release`   | Nx Release groups and tag strategy for publishable packages, a private prerelease workflow, and yalc-from-dist local package vetting          |
| `lint`      | Project-tag completion, structural checks, docs validation, and ESLint wiring (`spec-megamono-0006`)                                          |
| `skills`    | Managed portable skills under `.agents/skills` and the `.claude/skills` projection (`spec-megamono-0005`)                                     |
| `health`    | The deterministic scheduled health workflow and local health target (`spec-megamono-0008`)                                                    |
| `inference` | Supported Apple or Cargo plugins when corresponding manifests are detected (`spec-megamono-0003`)                                             |

```text
npm exec nx g @megamono/plugin:workspace-init --only=docs,agents
```

`--only` accepts a comma-separated set of module names. Omitting it starts the guided flow. Selecting a module never silently selects another: when a capability is reduced because another module is absent, the preview names the reduction. For example, `health` without `docs` disables the spec-drift and stale-plan checks but can still run dependency-alignment and orphan checks.

The `ci` module writes `.github/workflows/megamono-ci.yml`; it never replaces or inserts unbounded text into an existing general-purpose workflow. The generated workflow inherits the workspace's committed Node version from `.node-version`, `.nvmrc`, or `engines.node`, and its package-manager version from `packageManager`. When Node is undeclared, init chooses the tested fallback for the installed Nx major. When the survey finds equivalent affected-CI coverage, it recommends skipping the module and reports the retained repository-owned workflow. An occupied `megamono-ci.yml` path is an owned-path conflict, not permission to overwrite it.

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

- resolved Nx project names, roots, types, targets, and tags;
- npm, Node, Nx, and TypeScript versions;
- supported and unsupported non-JavaScript manifests;
- existing docs roots, corpus-like directories, and Markdown files;
- existing `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, and skill directories;
- existing CI, health, ESLint, Content Collections, and Megamono configuration;
- every path or config key a selected module would add or modify.

```text
megamono init --survey
```

`--survey` prints the report and exits with zero writes, no dependency installation, no generated cache, and no Git operation. `--format=json` emits a stable machine-readable form for portfolio triage; the default is human-readable Markdown.

## Guided flow

The default flow follows the adaptive-prompting rule from `spec-megamono-0002`:

1. Show the survey before asking a question.
2. Ask which modules to adopt. Safe additive modules may be recommended, but any module that edits an existing file starts unchecked.
3. Ask only about unresolved choices for the selected modules.
4. Show the complete ordered plan and diff summary.
5. Require explicit confirmation, then apply the same plan.

Inference is never a prompt. Lockfiles identify the package manager, resolved Nx metadata identifies projects and targets, manifests identify relevant inference plugins, and existing tags identify the current vocabulary. A prompt is permitted only when two valid outcomes remain.

The preview may be skipped only with `--yes`. `--yes` is not an answer to an ambiguity: non-interactive execution must also provide `--only` and every option named as unresolved by the survey. Missing input exits with programmatic classification `4` and the stable diagnostic `workspace-init-decision-required`.

## Existing conventions

Init adapts rather than normalizing for its own sake:

- Existing project names, roots, target names, and library names remain unchanged.
- Existing `type:`, `scope:`, `platform:`, and `visibility:` tags remain unchanged when valid. Missing required tags are proposed using `--defaultScope` and `--defaultPlatform`; conflicting vocabularies are reported rather than renamed.
- The Nest feature-library convention applies to newly generated libraries only. Renaming existing libraries and imports is outside init.
- Supported `Package.swift` and `Cargo.toml` surfaces produce an inference-plugin offer. A surface without a shipped plugin is reported as a graph-confidence gap.

Generated documentation is centralized under `--docsRoot=docs`, matching the settled location in `spec-megamono-0004`. Init does not reopen the centralized-versus-colocated decision.

## Existing documentation

Existing docs are inventoried but never moved or rewritten by init. The survey classifies only high-confidence candidates—ADR/decision directories, RFC/research directories, and records already carrying lifecycle metadata—and emits a proposed stable-ID mapping. Low-confidence files remain listed as unclassified.

Applying that mapping is a separate, explicitly reviewed docs-migration operation. This preserves init's no-moves guarantee and avoids a heuristic rewrite of repository-owned content. A partially adopted corpus is valid: existing docs may remain where they are while new Megamono records use the canonical corpus.

The `docs` module owns its repository-docs loader/configuration plumbing only when it creates those complete files. This does not include content-level emissions owned by Playstack. `docs/DESIGN.md` and every generated document skeleton are seeded and immediately repository-owned. Indexes are derived. The IA directories themselves confer no ownership over their contents.

## Existing agent files

- If `AGENTS.md` is absent, the `agents` module creates a seeded repository-owned file containing a managed Megamono section. If present, init appends only that delimited managed section after preview approval and preserves all existing content outside it.
- If `CLAUDE.md` is absent, init creates the supported pointer to `AGENTS.md` as a managed artifact. An existing pointer remains repository-owned and unchanged. A substantive `CLAUDE.md` or `.cursorrules` is never replaced or merged automatically; the survey reports duplicated instructions and a follow-up proposal.
- Existing skills with a conflicting name block installation of that managed skill. Init never relies on undefined duplicate-name precedence.

## Lint adoption

Fresh `create-megamono` workspaces use the default severities from `spec-megamono-0006`. An existing workspace may adopt newly enabled structural rules at warning severity so the adoption commit does not fail on pre-existing violations.

Flat ESLint configuration receives the Megamono plugin wiring. A workspace using `.eslintrc*` keeps that configuration byte-for-byte and records an `eslint-rule-wiring` capability reduction with migration guidance; project tags, `megamono:check`, and other structural validation remain available. Init never performs an implicit ESLint flat-config migration.

The adoption decision records the affected rules, initial counts, and the intended ratchet. The health report keeps the temporary warning overrides visible until each becomes an error or receives a separate accepted decision. Stylistic warnings remain warnings.

## Health and external commands

The `health` module emits the local target and scheduled workflow but does not run or publish health findings during initialization. The completion report prints the exact local command and offers it as a separate next step.

All file/config preflight completes before the Nx tree is flushed. Package installation and any ecosystem command run last, as required by `spec-megamono-0000`. Init never commits, pushes, opens a pull request, invokes a model, contacts Springbar, runs a database migration, or deploys.

## Re-running and recovery

Init is idempotent and resumable. A later run detects installed modules, skips current managed artifacts, regenerates derived artifacts, and plans only missing or safely upgradable managed pieces. Seeded and ejected artifacts are never rewritten. A modified managed artifact is preserved, reported with a diff, and points to `workspace-eject`; `--force` cannot reclaim it. A missing managed artifact is recreated only in an explicitly confirmed plan for its selected module.

The completion summary lists modules adopted or skipped, paths added or modified, conventions retained, confidence gaps, and follow-up commands. `--report=<path>` persists the same Markdown only when explicitly requested. If an external command fails after tree flush, `MEGAMONO-RECOVERY.md` records the completed steps and exact retry command; init never attempts an automatic rollback.

## V1 decisions

- `workspace-init` is the only canonical generator name; `@megamono/workspace:init` is not an alias. `megamono init` delegates to that generator and is a CLI command, not a second generator alias.
- `megamono add <module>` is a CLI route into `workspace-init --only=<module>`, while `megamono add app <type>` routes into the canonical `app` generator; neither command owns mutation templates.
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
- Existing project names, roots, valid tags, targets, docs, and agent content survive unchanged unless their exact edit was approved in preview.
- Every emitted artifact is classified as managed, managed-section, seeded, or derived; registry hashes, delimiters, IDs, and ordering are deterministic.
- Updating pristine managed artifacts succeeds, while modified, seeded, and ejected artifacts remain byte-for-byte unchanged; derived artifacts regenerate from canonical input.
- `workspace-eject --dry-run` and execution produce the same ownership plan, preserve content, and never affect Playstack-owned artifacts.
- Init never moves an existing path, and docs classification never applies during init.
- Temporary structural warnings remain visible to health until ratcheted or covered by an accepted decision.
- A failed external command writes recovery guidance without committing, pushing, or rolling back repository-owned changes.
