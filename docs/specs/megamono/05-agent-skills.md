---
id: spec-megamono-0005
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [agents, skills, lifecycle, ci]
summary: Defines portable review skills, their triggers, permissions, outputs, and automation boundaries.
date: 2026-08-23
supersedes: null
references:
  [
    spec-megamono-0000,
    spec-megamono-0004,
    spec-megamono-0006,
    spec-megamono-0008,
    spec-megamono-0011,
    spec-megamono-0012,
    spec-megamono-0014,
  ]
external_references: [playstack:01-overview, playstack:28-mcp]
---

# 05 — Agent Skills & Invocation Points (`@megamono/plugin`)

## Division of labour

Two enforcement layers, and keeping them separate is the design:

| Layer                                 | Handles                   | Why                                                          |
| ------------------------------------- | ------------------------- | ------------------------------------------------------------ |
| **Lint rules** (`spec-megamono-0006`) | Deterministic, mechanical | Free to run, no context cost, catches every file every time  |
| **Skills** (this doc)                 | Judgement calls           | Expensive; reserve for things a rule genuinely cannot decide |

A skill that has to check import paths on every file burns context on something a rule catches for free. Let the deterministic layer be deterministic and save the agent's attention for structural questions:

- Is this new library in the right place?
- Does this dependency direction make sense?
- Has the plan drifted from what's actually built?
- Is this spec now contradicted by the code?
- Should this be a new library, or does it belong in an existing one?

## The skills

### `structure-review`

Triggered when a library or app is added or moved.

Checks placement against the repo's stated conventions, the naming pattern (`@[repo]/nest-[feature]` for Nest features), tag assignment, and whether the new boundary is justified or whether existing code should have absorbed it.

Encodes the extraction rule explicitly: **extract to a shared layer only when a second consumer justifies it.** A library created for one consumer gets flagged, not blocked — with the "informed deferral" alternative offered (keep it local, reserve the scope, document the migration path).

When extraction or relocation is appropriate, the recommendation includes the complete `type:`, `scope:`, `platform:`, and capability-tag changes required by `spec-megamono-0006`. A structural recommendation that would immediately fail deterministic boundaries without explaining the corresponding tag or dependency change is incomplete.

### `plan-sync`

Triggered on branch open and at task boundaries.

On branch open: read `docs/plans/<project>/current.md`, read relevant specs and decisions, orient. On task completion: update the plan to reflect what was actually built, not what was intended.

### `drift-check`

The valuable one, and the hardest.

Triggered on PR open. Compares the diff against the relevant spec and decision records, and reports:

- Code that contradicts an accepted decision (with the decision number)
- Spec sections now stale relative to the implementation
- Plans describing work already completed or abandoned

**It reports. It does not auto-edit specs.** A spec silently rewritten to match the code is worse than no spec — it launders drift into intent.

### `decision-capture`

Triggered when a PR contains a choice that looks structural — a new dependency, a changed boundary, an abandoned approach.

Prompts: _should this be a decision record?_ The failure mode being addressed is decisions made in a PR description and lost when the PR is merged.

### `docs-placement`

Small but constantly useful. When the agent is about to write documentation, routes it to the correct location and type rather than dropping a markdown file wherever it's working.

### `archive-review`

Triggered on the scheduled health cadence (`spec-megamono-0008`).

Flags plans in a terminal status still sitting in the hot corpus, specs describing projects no longer in the graph, and research superseded by a later decision. Proposes; the executor moves (`spec-megamono-0011`).

### `visibility-recheck`

Triggered on the scheduled cadence.

`spec-megamono-0004` names the gap this closes: **flipping a doc to `visibility: public` is a moment of attention; staying public is not.** A document marked public a year ago may have accumulated internal detail since, and no lint rule can judge that.

Reviews public repo-level docs for content that reads as internal — customer names, unreleased plans, security specifics — and reports rather than reverting.

### `dependency-review`

Triggered on the scheduled cadence, consuming the alignment findings in `spec-megamono-0008`.

The mechanical comparison is deterministic and belongs to the checks; the **judgement** is whether a divergence is intentional. That means reading `docs/decisions/` for a recorded deferral before reporting anything — which is what keeps the weekly issue quiet enough to stay read.

## Invocation points, not hidden hooks

Skills are discovered from their descriptions and invoked explicitly by a person or an agent. A Git event cannot itself invoke a portable skill: doing so would require choosing a model runner, credentials, permissions, and a cost policy that this repository does not own.

V1 therefore records **recommended invocation points** rather than pretending they are automatic hooks:

| Moment                   | Recommended skill                                           | Automated in v1?                                               |
| ------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------- |
| Start work on a branch   | `plan-sync` (orient)                                        | No; agent description match or explicit invocation             |
| Before writing docs      | `docs-placement`                                            | No; agent description match or explicit invocation             |
| Before requesting review | `drift-check`, `decision-capture`, `structure-review`       | No; explicit invocation in the PR checklist                    |
| After merge              | `plan-sync`                                                 | No; archive executor remains explicit                          |
| Weekly health run        | `archive-review`, `visibility-recheck`, `dependency-review` | No model call; deterministic checks identify review candidates |

Generated CI runs deterministic validation and `megamono-docs:health`. It never sends repository content to a model and never requires an AI-provider secret. Generated local git hooks run deterministic lint only and are opt-in via `npm run megamono:hooks:install`; installing the plugin must not mutate a developer's global Git configuration.

The weekly health issue may say that an agent review is due and include the exact skill name and candidate documents. A maintainer then invokes the skill. Automatic agent execution is deferred until a separate runner contract specifies provider choice, data handling, permissions, budgets, timeouts, and failure reporting.

### Sequencing

**Spec this now, ship it second.** It depends on the docs convention (`spec-megamono-0004`) existing first — there is nothing to check drift _against_ until specs, plans, and decisions have defined homes.

Order: docs IA → skills → hooks.

## MCP — deferred, with a trigger

**Status: informed deferral.** Megamono does not ship its own MCP server in the first cut.

_(Distinct from `playstack:28-mcp`, which covers Commune **products** shipping MCP servers. That is a different concern — tools exposed to AI clients, not agents working on this repo — and the two should not be conflated.)_

### Why not

Nx already publishes an MCP server exposing the project graph, project details, and generator metadata. Megamono's generators register with Nx automatically, which means **they are already discoverable through Nx's MCP** — no additional server required to make an agent aware of them.

Shipping a second MCP would give an agent two servers with overlapping views of the same repo. That's not additive; it's a source of contradiction. The agent has to decide which one to trust for graph questions, and there's no principled basis for that decision.

### What's actually missing

The gap is not the graph. It's the docs corpus — the retrieval described in `spec-megamono-0004`. Nx's MCP knows nothing about specs, plans, or decision records, and "what decisions touch auth" is a genuinely useful query that nothing currently answers.

### Why a skill first

That query is small. `INDEX.md` plus front-matter filtering is a grep and a read — it does not need a server, an index, or a protocol. A skill that knows the retrieval paths covers it, ships in a fraction of the time, and degrades gracefully to instructions any agent can follow.

Building an MCP for it first would be infrastructure ahead of demonstrated need, which is the exact pattern the "Great Enough" principle exists to catch.

### Promotion trigger

Revisit when **any** of these becomes true:

- `INDEX.md` grows large enough that loading it is itself a context cost (rough threshold: a few hundred documents)
- Retrieval needs real search — semantic matching, ranking, fuzzy topic resolution — rather than structured filtering
- A second consumer wants the corpus: an agent working across repos, or a tool outside the Nx harness
- Nx's MCP proves insufficient for generator discovery in practice

Any one of those makes the server worth its cost. None of them are true yet.

### Migration path

The skill defines the query interface. An MCP server, if built, implements the same interface over a real index. Because the skill's contract is the three query paths in `spec-megamono-0004`, promoting it later is an implementation swap rather than a redesign — the calling convention doesn't change.

Keep the retrieval logic in a standalone module rather than inline in the skill prompt, so the eventual server can consume it directly.

## What a skill actually is

The gap this section closes: this spec names skills and their behaviour, so it must also define what a skill _is_ as an artifact — its format, where it lives, how an agent finds it, and how a repo takes ownership of one.

### Format

A directory with a `SKILL.md` and optional supporting files:

```
skills/
  drift-check/
    SKILL.md          # front matter + instructions
    reference.md      # detail loaded only when needed
```

Front matter carries the portable Agent Skills fields `name` and `description`. Provider-specific invocation controls are not used in shipped skills. **The description is the hardest part** — too vague and it fires constantly, too narrow and it never fires.

**Progressive disclosure:** `SKILL.md` stays small and points at reference files. A skill whose entire content loads on every invocation is a context cost paid whether or not it was needed.

### Where they live

The canonical repository location is:

```text
.agents/skills/<name>/SKILL.md
```

Codex discovers `.agents/skills` from the working directory through the repository root. Claude Code uses the same Agent Skills format but discovers `.claude/skills`; on supported macOS and Linux workspaces, `workspace-init` emits `.claude/skills` as a relative symlink to `../.agents/skills`. There is one source tree, not two copies to drift. Other agents can read the same Markdown through `AGENTS.md` even when they do not implement automatic discovery.

Those locations follow the current [Codex skill discovery](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) and [Claude Code skill discovery](https://code.claude.com/docs/en/skills#where-skills-live) contracts. The fixture suite treats a path change in either tool as a compatibility failure, not as permission to duplicate the skill tree.

Skills are templates inside `@megamono/plugin` and are installed into the repository by `workspace-init`, never loaded from `node_modules` at runtime. Each installed skill is a `managed` entry in `.megamono/artifacts.json` under the ownership contract in `spec-megamono-0014`; its entry covers the complete skill directory as a stable, path-sorted hash set.

Codex does not define override precedence for duplicate names; duplicate names can both appear. Consequently, a repository must not create two skills with the same `name`. To customize a generated skill, run `npm exec nx g @megamono/plugin:skill-eject --name=<name>`. It delegates to the same transition as `workspace-eject --artifact=skill.<name>`, preserves every skill file, records the entry as ejected, and makes the checked-in copy repository-owned. Future upgrades recognize it as ejected and never overwrite it. New repository-specific skills use unique names.

### Versioning

Skills version with `@megamono/plugin`. Managed copies record their source version and template hash, so `spec-megamono-0008` can report a skill that has fallen behind. An ejected copy is intentionally excluded from that drift finding.

Prerelease workspaces that contain the legacy sibling `.megamono-skill.json` provenance are migrated deterministically into `.megamono/artifacts.json` after validating the sidecar and installed hash. Migration changes provenance only, never skill content. Invalid or conflicting legacy provenance is reported and preserved for explicit repair.

Managed-skill findings use the existing `spec-drift` health check rather than adding a sixth check. Missing, outdated, modified, or invalid managed copies receive stable `managed-skill:<state>:<name>` fingerprints. Ejected skills are repository-owned and intentionally silent. A decision suppressing one of these findings carries the `skills` topic.

`megamono:check` validates all installed skill entrypoints, including repository-owned and third-party skills, for portable front matter, directory/name agreement, and unique names. Managed provenance affects upgrades and health reporting only; it never exempts a skill from the repository-wide format contract.

### Relationship to package-level skills

Playstack may ship agent skills too, including guidance for its eject and merge workflow. **Same format, different corpus, and deliberately not the same package.**

Megamono's skills govern the repo and are installed into it. Playstack's travels with the packages, because it must work for a consumer who has never heard of Megamono — the plain-Vite-app test from `playstack:01-overview` applies to skills as much as to code.

**The format is the shared thing.** Repository-governance skills are installed into the repository; Playstack product skills may be distributed through a dedicated `@playstack/skills` package and synchronized by `@playstack/cli`. Ownership of the corpus determines distribution.

`@megamono/plugin:playstack-skills` installs and invokes that package-owned synchronization contract for a Megamono workspace, but the resulting Playstack skill files remain Playstack-owned. They are not registered in `.megamono/artifacts.json`, and Megamono does not copy the sync, update, merge, or ejection logic. The published generator is backed by the stable `playstack skills sync` command and a packed npm/pnpm fixture that consumes the Playstack packages through yalc.

### Prior art

shadcn ships `shadcn/skills` on the same premise — an agent that does not know a tool's conventions will fetch raw files from GitHub, hand-patch generated code, and reimplement things a config option already covers.

**This is not speculative tooling.** It is the mechanism by which conventions written in `docs/` actually reach the agent doing the work, which is the entire premise of `spec-megamono-0004`.

## Risks

- **Noise.** A drift-check that fires on every PR with low-signal findings gets ignored within two weeks, and then it's worse than nothing. Tune hard toward precision over recall. Better to miss drift than to cry wolf.
- **Cost.** Agent invocations are not free. The lint layer must absorb everything it possibly can, and the PR checklist keeps agent review explicit.
- **Autonomy boundary.** Skills report and propose. They do not edit specs or decisions unattended. `plan-sync` may edit a non-terminal plan only when explicitly invoked; terminal transitions still use the archive executor.

## V1 decisions

- Hooks are opt-in and deterministic. V1 never invokes a model from Git hooks or CI.
- Skill content is portable Agent Skills Markdown. `.agents/skills` is canonical and `.claude/skills` is a symlink projection.
- Every skill includes at least five positive and five negative example prompts. The package test suite runs the same prompt set through Megamono's deterministic, provider-neutral discovery evaluator and fails when a positive example is not selected or a negative example is selected. Runtime agents continue to discover portable skills from front-matter descriptions; CI does not make a model or network call.
- Managed skills upgrade only when their stored template hash matches; ejected skills are never changed.
- Skill ownership uses the common Megamono artifact registry and ejection library; the legacy per-skill sidecar is migration input only.

## Acceptance criteria

- A generated workspace exposes every skill to Codex from `.agents/skills` and to Claude Code through the symlink without duplicate content.
- Each `SKILL.md` validates against the Agent Skills format and has unique `name` metadata.
- Positive and negative trigger fixtures pass for every skill.
- Installing or updating the plugin does not install hooks, invoke a model, or require provider credentials.
- Updating a pristine managed skill applies the template update; updating an edited or ejected skill leaves it untouched and reports the reason.
- `skill-eject` and `workspace-eject --artifact=skill.<name>` produce the same registry transition and preserve identical skill bytes.
- Deterministic CI remains usable when all AI tools and credentials are absent.
