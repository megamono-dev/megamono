---
id: spec-megamono-0009
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [convert, migration, generators, git]
summary: Defines planned, reversible conversion of an existing single-project npm repository into a Megamono workspace.
date: 2026-08-23
supersedes: null
references:
  [
    spec-megamono-0000,
    spec-megamono-0001,
    spec-megamono-0003,
    spec-megamono-0004,
    spec-megamono-0006,
    spec-megamono-0008,
    spec-megamono-0010,
    spec-megamono-0014,
  ]
external_references: []
---

# 09 — Convert: Existing Repo → Megamono

## Why this exists

`spec-megamono-0001` positions Megamono against Polygraph as: _Polygraph makes fragmentation tolerable; Megamono removes the fragmentation._

That claim creates an obligation. If the answer to multi-repo sprawl is "consolidate instead," consolidation has to be tractable — otherwise the positioning is a slogan. Convert and import (`spec-megamono-0010`) are what make it real.

**Convert is the more common entry point.** The typical adopter is not consolidating twelve repos. They have one repo with one app, they are about to add a second surface, and they want structure before the mess rather than after it.

## Invocation and prerequisites

Convert is an Nx generator, so the source repository first commits the result of `nx init` and installs `@megamono/plugin` as a dev dependency. This separates Nx adoption from Megamono's structural move and gives the conversion branch a clean rollback point.

```text
npm exec nx g @megamono/plugin:convert \
  --app-name=<name> \
  --source=. \
  --destination=apps/<name> \
  --interactive=true \
  --accept-plan=false \
  --verify=config \
  --dry-run
```

`--interactive=false` requires `--accept-plan=true` plus explicit resolutions for every detected collision or proposed extraction. `--verify` accepts `none`, `config`, or `build`; the default is `config`. The generator never runs `nx init`, changes Git branches, commits, or pushes.

## Convert vs. import

Two operations, deliberately separate.

|                           | **Convert** (`spec-megamono-0009`)   | **Import** (`spec-megamono-0010`) |
| ------------------------- | ------------------------------------ | --------------------------------- |
| Shape                     | In-place restructure                 | Absorb repo B into repo A         |
| Repo identity             | Stays the same repo                  | B ceases to exist independently   |
| History                   | Already intact — nothing to preserve | Must be grafted; the hard part    |
| Dependency reconciliation | Single tree, no conflict             | Two trees that disagree           |
| Difficulty                | Moderate, mostly mechanical          | High                              |

Convert-then-import is the natural sequence: make the repo a valid host, then absorb into it. Import assumes convert has already happened.

An established Nx workspace whose structure should remain in place uses `workspace-init` (`spec-megamono-0014`) instead. Convert is for a single npm package or plain npm workspaces that run `nx init` only as the prerequisite to structural conversion; it is not the adoption path for a working Nx monorepo.

## What convert does

The repo stays the repo. Git history is untouched — this is a restructure, not a migration. Which means the genuinely hard problem in `spec-megamono-0010` simply does not arise here.

Five phases.

### Phase 1 — Detect

Infer the current shape before changing anything. Package manager, framework, existing build tooling, test runner, whether a monorepo tool is already present, non-JS surfaces sitting in the tree.

Output is a plan the user reads and approves. **Nothing is written in this phase.** Conversion touches the root of an existing working repo; a silent restructure is unacceptable even if correct.

### Phase 2 — Restructure

The app moves into `apps/<name>/`. Shared code, if identifiable, moves into `libs/`. Path aliases replace relative imports that now cross the new boundary.

Two rules:

- **Moves use the Nx virtual tree rename operation.** Git records the resulting delete/add pairs as renames when similarity permits; `git log --follow` must work for unchanged and mechanically rewritten files in the fixture suite.
- **Extraction into `libs/` is proposed, never automatic.** Detecting "this looks shared" is heuristic. Getting it wrong produces a library boundary that doesn't match how the code is actually used, and boundaries are expensive to undo once lint enforces them. Propose; let the human confirm.

### Phase 3 — Targets

Whatever build setup existed becomes applicable Nx targets: `build`, `test`, and `lint`, plus `deploy` only when the source already has a deploy command, per the target contract in `spec-megamono-0003`.

The existing commands are wrapped, not replaced. A convert that rewrites someone's working build is a convert that gets reverted. Optimization comes later, deliberately, once the graph is trusted.

### Phase 4 — Conventions

The Megamono layer lands: `docs/` IA, `AGENTS.md`, `DESIGN.md`, the lint rules from `spec-megamono-0006`, `megamono.json`.

**Lint rules install in warning mode.** An existing codebase will violate the boundary rules immediately — that is expected, not a failure. Failing CI on the conversion commit teaches the adopter that Megamono broke their repo. Warn, report the count, let them ratchet to error when they have burned the violations down.

### Phase 5 — Seed the docs corpus

The one phase that is genuinely Megamono rather than generic Nx adoption.

Generate an initial `DESIGN.md` scaffold, a first decision record documenting the conversion itself, and `docs/INDEX.md`.

That first decision record matters more than it appears. It establishes the corpus, gives the retrieval paths in `spec-megamono-0004` something to return, and — pointedly — means the repo's first recorded decision is _"we adopted this structure, for these reasons."_ An agent working in the repo six months later can find it.

## After convert

The repo is now a host. `create-megamono`'s generators apply, new apps scaffold into `apps/`, and the existing app keeps its full history alongside them.

This is the answer to "I want a second surface but I don't want to start over."

## Non-JS surfaces

If detection finds a `Package.swift`, `Cargo.toml`, or `composer.json`, convert should install the corresponding inference plugin where one exists (`spec-megamono-0003`).

Where the plugin is not built yet, convert should say so explicitly rather than silently producing a graph with missing edges. A partial graph that looks complete is the failure mode the health checks in `spec-megamono-0008` also have to defend against — better to be told the Swift edges are absent than to trust an `affected` result that quietly isn't.

## Failure and reversibility

- **Refuse on a dirty working tree.** No exceptions.
- **Operate on a branch**, never on the default branch.
- Print a conversion summary: what moved where, what was wrapped, and what was proposed but skipped. `--report=<path>` may persist the same Markdown to an explicit path; no temporary root document is created by default.
- **The revert is discarding the unmerged conversion branch after returning to its recorded base.** Because the whole operation is file moves and additions inside one repo, reversibility is free. Preserve that property — no operation in convert should be irreversible.

If execution fails after the Nx tree flushes, the generator writes `MEGAMONO-RECOVERY.md` in the working tree with the failed phase and exact verification command. It never attempts an automatic rollback, because doing so could erase a diagnostic change. The preflight clean-tree rule makes discarding the conversion branch safe.

## V1 decisions

- V1 supports one package or plain pnpm/npm workspaces after `nx init`. The detected manager is preserved and written to `megamono.json`. Detection of Lerna, Turborepo, Rush, Yarn, Bun, conflicting lockfiles, or another workspace orchestrator produces an analysis report and refuses before mutation with `convert-unsupported-orchestrator` (programmatic classification `3`; Nx generator process status `1`, per `spec-megamono-0000`).
- No library extraction is automatic. A proposal requires at least two statically identified consumers and explicit approval or a non-interactive `--extract=<source>:<destination>` mapping.
- `--verify=config` runs docs validation, `megamono:check`, graph construction, and local health analysis. Health findings appear in the conversion summary and never create or update a GitHub issue during convert.
- A source-root file is classified before moving. Repository infrastructure (`.github`, editor config, licenses, root manifests, Git files, and Nx files) remains at root; app-owned framework and source files move. Unclassified files are unresolved decisions, not guessed moves.

## Acceptance criteria

- Single-package and plain pnpm/npm-workspace fixtures convert with preserved commands, project names, and graph edges.
- Dirty trees, default-branch execution, unsupported orchestrators, ambiguous files, and unresolved non-interactive choices exit before mutation.
- Dry-run and execution produce the same ordered move/update plan.
- Every source build/test/lint command has a behaviorally equivalent target; deploy is emitted only when detected.
- `git log --follow` crosses representative file moves in the history fixture.
- Running convert a second time is a no-op, and a failure after tree flush writes a recovery file without committing or reverting changes.
- `--verify=build` proves the converted app builds and tests from a clean selected-package-manager install.
