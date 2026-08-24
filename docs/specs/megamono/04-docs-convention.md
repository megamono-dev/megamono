---
id: spec-megamono-0004
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [docs, agents, lifecycle, architecture]
summary: Defines the two documentation corpora, repository taxonomy, metadata schemas, lifecycle transitions, and retrieval model.
date: 2026-08-23
supersedes: null
references:
  [
    spec-megamono-0000,
    spec-megamono-0005,
    spec-megamono-0006,
    spec-megamono-0008,
    spec-megamono-0011,
  ]
external_references: [playstack:02-auth, playstack:10-event-store]
---

# 04 — Docs Convention (`@megamono/plugin`)

## Premise

Docs exist as **context for the agent**, not as process. The test for any rule in this spec is: _does this make an agent produce more consistent work six months from now?_ If not, cut it.

This is deliberately not a documentation-culture initiative. The default mode is to build. Docs earn their place by making the building better.

## Two corpora

The foundational distinction, and the one everything else hangs off:

|           | **Repo-level**                                                                          | **Content-level**                               |
| --------- | --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Purpose   | Understanding and maintaining the repo                                                  | Published and rendered by consuming apps        |
| Audience  | Maintainers and agents                                                                  | End users                                       |
| Location  | `docs/`                                                                                 | `libs/content/`, or per-app content directories |
| Read as   | Plain markdown on disk, no build required                                               | Typed import, built                             |
| Published | Only by explicit opt-in (see Visibility)                                                | Always — that's the point                       |
| Schema    | `id`, `type`, `status`, `visibility`, `projects`, `topics`, `summary`, lifecycle fields | Defined by the consuming content library        |

They overlap in format and share almost nothing else. Two schemas, not a shared base with extensions — the shared thing is the _pattern_, not the fields.

### The direction rule

> **A repo-level doc may reference a content-level doc. A content-level doc may never reference a repo-level one.**

The asymmetry follows from publication. Repo docs are internal by default, so a content doc pointing at one either leaks internal reasoning into a published artifact or produces a dead link at build time. The reverse is always safe — the target is public by definition.

A decision record citing a published guide as evidence is a legitimate and expected case. Support it explicitly rather than tolerating it.

## Repo-level: the taxonomy

Buckets are cheap to add and expensive to live with. Every additional directory raises the cost of the placement decision, and an ambiguous taxonomy means the `docs-placement` skill guesses — which is worse than four obvious buckets.

So the list is derived from two questions, not brainstormed:

1. **Durable or point-in-time?** Edited as reality changes, or true-as-of-a-date and never touched again?
2. **Intent, judgement, or observation?** What should be, what we concluded, or what we found?

```
docs/
  specs/          # intent — what we intend to build
    <project>/
  plans/          # intent — how we're getting there, right now
    <project>/
  decisions/      # judgement — what we chose and why
  audits/         # judgement — evaluation against a stated standard
  research/       # exploration — findings without a verdict
  reports/        # observation — usually machine-generated
  archives/       # cold storage, mirrors the structure above
    specs/
    plans/
    research/
  DESIGN.md
  INDEX.md        # generated
AGENTS.md         # entry point
```

| Directory    | Durable?                        | Kind                         | Lifecycle                                                                         |
| ------------ | ------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `specs/`     | Durable                         | Intent — what it should be   | Edited in place                                                                   |
| `plans/`     | Status-tracked                  | Intent — how we get there    | Archived on terminal status                                                       |
| `decisions/` | Body-immutable                  | Judgement — what we chose    | Body append-only; lifecycle metadata may advance                                  |
| `audits/`    | Immutable                       | Judgement against a standard | Append-only, dated                                                                |
| `research/`  | Body-immutable after completion | Exploration, no verdict      | `active` may become `complete`; completed body is append-only and feeds decisions |
| `reports/`   | Immutable                       | Observation                  | Append-only, retention-pruned                                                     |

### Why `research/` is separate from `decisions/`

A decision record answers _what we chose_. Research often reaches no verdict at all, and the decision that follows is unreadable without it — the competitive analysis behind a positioning call, a library evaluation, a survey of prior art.

Collapsing research into decisions either bloats the decision record past the point anyone reads it, or loses the evidence entirely. Keep them separate and let decisions cite research by ID.

### Why `audits/` is separate from `reports/`

An audit is judgement against a **stated standard**; a report is observation. `playstack:10-event-store` produces the first real audit in this repo — a ten-item checklist evaluating shipped packages against a written spec. That is not a report, and it is not a decision.

Audits are low-volume and inherently dated. They are not archived; a later audit names the earlier audit in `supersedes`, and retrieval derives the reverse relationship without editing the earlier body.

### Deliberately excluded

**Runbooks** are imperative procedure rather than description — a genuine seventh category, but not one to create before operational procedures actually accumulate.

**Postmortems** fold into `reports/` as incident reports until frequency justifies splitting.

## Plans and status

Plans are not simply ephemeral. A completed plan still tells the story of why the work took the shape it did — that value is **archival**. A live plan tells you what to do next — that value is **operational**.

Deleting on completion loses the first. Keeping everything in one flat directory degrades the second.

The resolution is status _plus physical separation_. Status says where a plan is in its life; location controls what an agent loads by default.

```yaml
status: backlog | in-progress | on-hold | completed | aborted
```

Five, not seven. States that don't change behaviour become states nobody maintains accurately.

- **`deployed`** was cut. Deployment is a fact about a release; a plan will be stale about it within a day. If it matters, it belongs in the plan body or a report.
- **`closed`** was cut. It overlaps `completed` and `aborted` without adding a distinction anyone can state cleanly.

### `aborted` is the one to protect

An abandoned plan with the reason recorded is the most useful archived plan there is — it is the artifact that stops an agent proposing the same approach six months later.

**Abort requires a reason.** A status flip with no `aborted_because` is a lint error, not a warning. Without it the record is indistinguishable from abandonment-by-neglect, which carries no signal.

### Active vs. archived

`backlog`, `in-progress`, and `on-hold` stay in `docs/plans/`. A terminal transition is performed by `megamono-docs:archive`, which changes the status and moves the file to `docs/archives/plans/` in one operation. A terminal plan left in the hot corpus is a validation error.

`on-hold` is **active but excluded from "what's in flight"** — it is waiting on something, not dormant. That distinction is a retrieval filter, not a location.

## Archiving

`docs/archives/` mirrors the hot structure. Path alone then tells you both what a thing is and that it is cold, without reading front matter.

(Colocated `docs/plans/archive/` was considered and rejected. The exclusion glob is a wash — `docs/archives/**` and `docs/*/archive/**` are equally cheap — so this comes down to legibility, and a single visible archive root wins.)

**It is not a universal sink.** Three types do not archive:

- **`decisions/` never move.** Superseded records stay in the corpus because "has this been decided before" is the highest-value query in the system. Status filtering keeps them out of the default view.
- **`reports/` need retention, not archival.** The scheduled health workflow reports to GitHub and creates no repository file. `docs/reports/` is only for explicitly persisted outputs from commands run with `--output=docs/reports/<file>.md`; those files use the retention window below.
- **`audits/`** are low-volume. A newer audit supersedes an older one through the newer document's `supersedes` field; neither moves.

So the archive realistically holds `plans/`, `specs/`, and `research/`. The mirrored name should not be read as implying otherwise.

### Cross-references must be IDs

**Archiving breaks inbound links.** A decision citing `docs/plans/foo.md` dies the moment that plan moves — and decisions are append-only, so they cannot cleanly be rewritten.

Therefore: **documents reference each other by stable ID, never by path.**

```yaml
id: plan-synth-20260823-auth-rollout
references: [decision-20260820-session-storage]
external_references: [playstack:02-auth]
```

IDs survive archiving and renames both. They also make reference integrity checkable — see `spec-megamono-0011`, where the content-collections graph turns an unresolved ID into a build failure rather than something discovered months later.

ID formats are stable and generated:

| Type     | Format                              |
| -------- | ----------------------------------- |
| Spec     | `spec-<project>-NNNN`               |
| Plan     | `plan-<project>-YYYYMMDD-<slug>`    |
| Decision | `decision-YYYYMMDD-<slug>`          |
| Audit    | `audit-<target>-YYYYMMDD`           |
| Research | `research-YYYYMMDD-<slug>`          |
| Report   | `report-<producer>-<UTC timestamp>` |

Generators normalize slugs and refuse an existing ID; they never silently choose a different ID. `references` resolves across the hot and archive collections. `external_references` contains qualified IDs (`<system>:<id>`) and is syntax-checked but not locally resolved.

## Visibility

Publishing repo-level docs is not a violation of the direction rule, provided it is deliberate. A public changelog of decision records, or architectural reasoning surfaced as writing, is exactly the sawdust strategy — the byproduct of building becoming the content.

The failure mode is publishing _by accident_, because an import happened to typecheck.

So: **default deny, explicit per-document opt-in.**

```yaml
visibility: internal # default — and the default is the point
visibility: public # a deliberate act, per document
visibility_reviewed_at: 2026-08-23T14:00:00Z # required when public
```

Lint enforcement (`spec-megamono-0006`):

| Rule                                          | Severity  | Why                                           |
| --------------------------------------------- | --------- | --------------------------------------------- |
| Public-facing app imports an `internal` doc   | **Error** | A leak, not a style problem                   |
| Content-level doc references a repo-level doc | Warning   | Direction rule; usually a mistake, not a leak |

Internal tooling — a docs viewer, a dashboard — has no such restriction. The distinction is per-app, declared by tag. Public applications import from the generated `content-collections/public-repo-docs` entry point, which contains only `visibility: public` records. The unrestricted `content-collections/repo-docs` entry point is rejected in a public-facing project. This makes the boundary statically enforceable without attempting to infer which entries an aggregate import later filters.

**Residual risk, unsolved by lint:** a doc marked `public` gets edited six months later with internal detail, and nothing rechecks it. Flipping to public is a moment of attention; _staying_ public is not. This needs a periodic skill check rather than a lint rule.

## Decision records

The observed failure this addresses: an agent contradicting a decision made earlier in the same repo, mid-spec, because nothing recorded the decision anywhere it reliably reads.

Format is deliberately minimal — heavy ADR templates don't get written. Once a decision reaches `accepted` or `deferred`, its body is immutable. Superseding creates a new decision with `supersedes: <old-id>`; the index derives `superseded_by` for the old record. The old file's body and front matter are not rewritten.

```markdown
# 0007 — Metering at ingest, never delivery

**Status:** accepted
**Date:** 2026-08-20
**Supersedes:** —

## Decision

Meter webhook volume at ingest only.

## Why

Delivery fan-out would make a single inbound event arbitrarily
billable. Metering at ingest keeps pricing predictable and
matches the customer's mental model of "events I sent you."

## Consequences

Delivery infrastructure cost is absorbed, not passed through.
Pricing tiers must be set with fan-out headroom.
```

### Informed deferral

A first-class status. When a decision is knowingly postponed, record it _as a decision_ with the migration path documented — not as an absence.

```markdown
**Status:** deferred
**Revisit when:** a second consumer needs this
**Migration path:** extract to @structured-ld, scope already reserved
```

This is the existing working pattern (`@structured-ld` scope reservation, the `src/core/` vs `src/react/` boundary enforced by ESLint from day one). Making it a documented status means the agent can distinguish "we haven't thought about it" from "we thought about it and chose not to yet" — which are very different inputs to a proposal.

## Retrieval

Structure is only half the problem. The other half is **how an agent finds the right document without reading all of them.**

A repo with forty decision records and six spec suites cannot be loaded wholesale into context. If the answer to "what did we decide about auth" is "read `docs/decisions/`," the convention has failed.

### Front matter

```yaml
---
id: decision-20260820-meter-at-ingest
type: decision # spec | plan | decision | audit | research | report
status: accepted
visibility: internal
projects: [synth, quickzones]
topics: [auth, sessions]
summary: Meter webhook volume at ingest rather than delivery fan-out.
date: 2026-08-20
supersedes: null
references: []
external_references: []
---
```

`topics` is the important field and the one that needs discipline. A controlled vocabulary — built-in Megamono topics plus repository extensions in `megamono.json`, all lint-enforced — beats free-form tagging, which drifts into `auth`, `authentication`, and `Auth` within a month.

The built-in vocabulary is: `agents`, `apple`, `architecture`, `bootstrap`, `cargo`, `ci`, `content-collections`, `convert`, `dependencies`, `docs`, `email`, `generators`, `git`, `graph`, `health`, `import`, `integrations`, `lifecycle`, `lint`, `migration`, `nx`, `observability`, `plans`, `playstack`, `positioning`, `release`, `skills`, and `testing`. Repositories extend it with normalized lowercase slugs; an extension may not alias or case-duplicate a built-in topic.

Specifications may additionally declare a strict, machine-readable architecture contract. Each endpoint must appear in the specification's `projects` list. An allowed dependency is an expected directed Nx graph edge; a forbidden dependency is an invariant that the directed edge must remain absent. The lists reject self-edges, duplicates, and an edge appearing in both lists. The field is optional, spec-only, and never inferred from prose.

```yaml
projects: [web, api]
architecture:
  allowed_dependencies:
    - from: web
      to: api
  forbidden_dependencies:
    - from: api
      to: web
```

### Status vocabularies and type-specific fields

| Type     | Allowed statuses                                            | Additional fields                                                            |
| -------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Spec     | `draft`, `accepted`, `superseded`, `retired`                | `supersedes` when applicable; optional `architecture` dependency contract    |
| Plan     | `backlog`, `in-progress`, `on-hold`, `completed`, `aborted` | `branch?`, `completed_at?`, `aborted_because?`                               |
| Decision | `proposed`, `accepted`, `deferred`, `rejected`              | deferred requires `revisit_when` and `migration_path`; superseded is derived |
| Audit    | `current`                                                   | `standard`, `supersedes?`; superseded is derived                             |
| Research | `active`, `complete`                                        | `supersedes?`; superseded is derived                                         |
| Report   | `generated`                                                 | `producer`, `generated_at`, `retention_days`                                 |

`branch` is the exact Git ref associated with a plan and is optional for backlog plans. It is required once a plan becomes `in-progress`. Terminal plans require `completed_at`; aborted plans additionally require `aborted_because`.

`visibility_reviewed_at` is forbidden on internal documents and required on public documents. Any content change to a public document without advancing that timestamp is a validation error.

### The index

A generated `docs/INDEX.md`: every document, one line each, with type, status, projects, topics, and a one-sentence summary.

This is the file an agent reads first — small enough to load cheaply, complete enough to decide what to open next. Regenerated by `npm exec nx run megamono-docs:index` and checked in, so it is readable without running anything.

Summaries come from front matter, not body parsing. Parsed summaries drift the moment someone edits a heading.

**`INDEX.md` covers the hot corpus only.** Archives get their own index, and `reports/` is excluded from the default view entirely. An index that grows without bound defeats its own purpose.

### Query paths

| Question                             | Path                                           |
| ------------------------------------ | ---------------------------------------------- |
| "What decisions touch auth?"         | Filter `INDEX.md` by topic, open the matches   |
| "What's the current state of Synth?" | Project index → spec suite + in-progress plans |
| "Has this been decided before?"      | Topic filter across `accepted` and `deferred`  |
| "Why was this built this way?"       | Archive index → completed and aborted plans    |

The third matters most. Catching a **deferred** decision is the highest-value retrieval in the system — the difference between "we haven't considered this" and "we considered it, chose to wait, and documented the migration path."

The fourth is what archiving buys. It is a deliberate, cold query — never part of the default context.

### Superseding

A superseded decision stays in the corpus. The replacement declares `supersedes`; the derived graph presents the earlier decision as superseded and supplies its forward pointer without mutating the earlier record.

Retrieval filters superseded records out of the default view and surfaces them only when a chain is being followed deliberately.

## `DESIGN.md`

Repo-wide design brief, optionally per-surface. Read by the agent **before any UI work**.

Contents: aesthetic direction, typographic system, spacing scale, the named influences, and — critically — an explicit _not this_ list.

The specific failure being mitigated: a build straying from the design vision over the course of implementation, requiring an architectural pivot to recover (the documented Prismark case). A design brief and screen inventory prevented recurrence there; this generalizes it.

```markdown
# Design

## Direction

Refined minimalism with typographic confidence.

## Influences

Dieter Rams, Paul Rand, Massimo Vignelli, Anton Repponen, Claudio Guglieri.

## Not this

Gradient meshes. Glassmorphism. Template SaaS layouts.
Decorative motion. Icon-per-feature marketing grids.

## System

Type scale: ...
Spacing: ...
Color: ...
```

## `AGENTS.md`

The entry point. Single source. `CLAUDE.md` is always emitted as a one-line import/pointer to `AGENTS.md` so Claude Code receives the same rules; it is never a second copy.

Contents:

- Repo shape: what's in `apps/`, `libs/`, `packages/`, and why
- The two corpora and the direction rule
- Where to read before working (specs → decisions → in-progress plans)
- Where to write, and when
- Library placement rules and dependency direction
- The generator commands, so the agent uses them instead of hand-rolling structure
- Conventions the linter enforces

## Tooling

Generators, the archiving skill and executor, the content-collections graph, and the content-lib generators are specified in `spec-megamono-0011`.

## V1 location decision

Specs and plans are centralized under `docs/specs/<project>/` and `docs/plans/<project>/`. Per-project generated indexes preserve ownership and local discoverability. Colocated project docs are content-level or implementation notes only; they are not part of the repo-level corpus in v1.

## Acceptance criteria

- Every corpus document validates against the type-specific schema above.
- Every internal reference resolves across hot and archived documents; duplicate IDs fail validation.
- Public apps can import the public entry point and cannot import the unrestricted entry point.
- Completing or aborting a plan through the archive executor leaves no terminal plan in the hot corpus.
- `INDEX.md` is deterministic and a second generation produces no diff.
- Plain Markdown files remain understandable with `node_modules` and generated artifacts removed.
