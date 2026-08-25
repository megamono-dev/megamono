---
id: spec-megamono-0014
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [generators, lifecycle, docs, agents, lint]
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
external_references: []
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
npm exec nx g @megamono/plugin:workspace-init
```

V1 requires the baseline from `spec-megamono-0000`: Node 24, npm 11, Nx 23.1, TypeScript 6.0, and macOS or Linux. A non-npm lockfile, unsupported Nx version, malformed project graph, dirty worktree, or execution on the default branch refuses before mutation. `--survey` is read-only and may run on a dirty or default-branch worktree.

## Additive and modular

> **Init never moves an existing path. It adds governance layers and changes an existing file only after identifying the exact edit in its preview.**

Every execution installs a small baseline: `megamono.json`, the `megamono` project with `check` and `import` targets, plugin compatibility metadata, and the selected module records. Modules are otherwise independently selectable:

| Module      | Adds or configures                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs`      | Centralized corpus directories, Content Collections config, indexes, and `megamono-docs` targets (`spec-megamono-0004`, `spec-megamono-0011`) |
| `agents`    | A managed section in `AGENTS.md`, a safe `CLAUDE.md` pointer when possible, and `docs/DESIGN.md`                                              |
| `lint`      | Project-tag completion, structural checks, docs validation, and ESLint wiring (`spec-megamono-0006`)                                          |
| `skills`    | Managed portable skills under `.agents/skills` and the `.claude/skills` projection (`spec-megamono-0005`)                                     |
| `health`    | The deterministic scheduled health workflow and local health target (`spec-megamono-0008`)                                                    |
| `inference` | Supported Apple or Cargo plugins when corresponding manifests are detected (`spec-megamono-0003`)                                             |

```text
npm exec nx g @megamono/plugin:workspace-init --only=docs,agents
```

`--only` accepts a comma-separated set of module names. Omitting it starts the guided flow. Selecting a module never silently selects another: when a capability is reduced because another module is absent, the preview names the reduction. For example, `health` without `docs` disables the spec-drift and stale-plan checks but can still run dependency-alignment and orphan checks.

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
npm exec nx g @megamono/plugin:workspace-init --survey
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

## Existing agent files

- If `AGENTS.md` is absent, the `agents` module creates it. If present, init appends only a delimited managed section after preview approval and preserves all existing content above it.
- If `CLAUDE.md` is absent, init creates the supported pointer to `AGENTS.md`. An existing pointer remains unchanged. A substantive `CLAUDE.md` or `.cursorrules` is never replaced or merged automatically; the survey reports duplicated instructions and a follow-up proposal.
- Existing skills with a conflicting name block installation of that managed skill. Init never relies on undefined duplicate-name precedence.

## Lint adoption

Fresh `create-megamono` workspaces use the default severities from `spec-megamono-0006`. An existing workspace may adopt newly enabled structural rules at warning severity so the adoption commit does not fail on pre-existing violations.

The adoption decision records the affected rules, initial counts, and the intended ratchet. The health report keeps the temporary warning overrides visible until each becomes an error or receives a separate accepted decision. Stylistic warnings remain warnings.

## Health and external commands

The `health` module emits the local target and scheduled workflow but does not run or publish health findings during initialization. The completion report prints the exact local command and offers it as a separate next step.

All file/config preflight completes before the Nx tree is flushed. Package installation and any ecosystem command run last, as required by `spec-megamono-0000`. Init never commits, pushes, opens a pull request, invokes a model, contacts Springbar, runs a database migration, or deploys.

## Re-running and recovery

Init is idempotent and resumable. A later run detects installed modules, skips current managed artifacts, and plans only missing or safely upgradable pieces. An edited managed file is preserved and reported; taking ownership uses the package's explicit ejection mechanism rather than `--force`.

The completion summary lists modules adopted or skipped, paths added or modified, conventions retained, confidence gaps, and follow-up commands. `--report=<path>` persists the same Markdown only when explicitly requested. If an external command fails after tree flush, `MEGAMONO-RECOVERY.md` records the completed steps and exact retry command; init never attempts an automatic rollback.

## V1 decisions

- `workspace-init` is the only canonical generator name; `@megamono/workspace:init` is not an alias.
- Survey classification is conservative and proposal-only. Init never migrates existing docs.
- Existing substantive agent files are preserved for explicit follow-up rather than merged by heuristic.
- Init offers but does not run repository health after adoption.
- Existing Nest libraries are never renamed by init.
- Partial module adoption is supported and recorded in `megamono.json`.

## Acceptance criteria

- New, established, and mixed-platform Nx fixtures produce stable survey JSON and the correct module availability.
- `--survey` is byte-for-byte stable and writes no file, cache, lockfile, branch, or dependency.
- Guided preview and non-interactive execution produce the same ordered plan for equivalent answers.
- Dirty/default-branch execution, unsupported baselines, unresolved decisions, conflicting owned paths, and substantive alternate agent files fail or defer exactly as specified before mutation.
- Each module is independently idempotent; every supported module subset either works or reports its documented capability reduction.
- Existing project names, roots, valid tags, targets, docs, and agent content survive unchanged unless their exact edit was approved in preview.
- Init never moves an existing path, and docs classification never applies during init.
- Temporary structural warnings remain visible to health until ratcheted or covered by an accepted decision.
- A failed external command writes recovery guidance without committing, pushing, or rolling back repository-owned changes.
