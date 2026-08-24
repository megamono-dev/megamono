---
id: spec-megamono-0001
type: spec
status: accepted
visibility: public
visibility_reviewed_at: 2026-08-23T00:00:00Z
projects: [megamono]
topics: [positioning, architecture, nx]
summary: Defines Megamono's product boundary, competitive position, dependency risk, and commercial framing.
date: 2026-08-23
supersedes: null
references:
  [
    spec-megamono-0000,
    spec-megamono-0002,
    spec-megamono-0006,
    spec-megamono-0007,
    spec-megamono-0008,
    spec-megamono-0009,
    spec-megamono-0010,
  ]
external_references: []
---

# 01 — Megamono: Philosophy & Positioning

## What Megamono is

Megamono is a **philosophy and approach** for structuring and maintaining a large monorepo, plus the Nx tooling that makes the philosophy enforceable.

It is a devDependency. It never ships to production. It shapes the repo; it does not run inside the product.

## What Megamono is not

- Not a hosted service.
- Not a paid product.
- Not a replacement for Nx. It is a layer on top of Nx.
- Not a "manage your monorepo" platform. That space is being taken (see Competitive, below).

## The thesis

Nx is excellent at JS/TS and has effectively no opinion about two things:

1. **Non-JS surfaces.** Swift, Rust, PHP, Go, Kotlin — these live in monorepos constantly, and Nx either can't see them or sees them as opaque blobs. The graph edges are missing, so `affected` degrades to "this one project changed."
2. **The repo's information architecture.** Where specs live. Where plans live. Where decisions are recorded. How an agent knows which of those to read and which to update.

Megamono fills both gaps, and the second one is the more original half.

### Docs as agent substrate

The core insight: documentation in a large repo is not process overhead, it is **context for the agent**. Specs, plans, and decision records exist so that an agent working in the repo produces consistent work six months after the human forgot the reasoning.

This reframes a lot. It means:

- Docs have a defined location and shape, because an agent needs to find them deterministically.
- Docs have lifecycle rules — when to write, when to update, when to notice drift.
- Doc maintenance is a generator/skill concern, not a discipline concern.

The failure mode this addresses is concrete and observed: an agent contradicting a decision made earlier in the same repo, because nothing recorded the decision in a place the agent reliably reads.

## Competitive position

### What Polygraph actually is

**Nx Cloud Polygraph** launched June 2026. It is a suite within the Nx Cloud dashboard, described in Nx's own docs as an **Nx Enterprise** feature set — not a general free tier. (An earlier draft of this document described it as usage-metered with a free tier. That was wrong and is corrected here.)

Three components:

| Feature               | What it does                                               |
| --------------------- | ---------------------------------------------------------- |
| **Workspace graph**   | Visualizes dependencies _across_ separate repositories     |
| **Conformance rules** | Publish a rule once, enforce it org-wide across every repo |
| **Custom workflows**  | Scheduled or triggered runs, including agentic auto-fix    |

The positioning is a "synthetic monorepo" — stitching poly-repos together so AI agents get cross-boundary visibility plus memory that survives sessions. Nx frames it as a meta-harness rather than an agent.

### Why this is not the same market

The instinct was to read this as the Aspire → Springbar trajectory risk: well-funded incumbent takes the generic layer for free. On inspection it isn't.

**Polygraph exists because organizations have many repos and cannot consolidate them.** The reasons are political, organizational, and historical — team boundaries, acquisitions, compliance separation. Polygraph makes a fragmented reality tolerable by reconstructing, at the dashboard layer, the coherence a monorepo would have given natively.

**Megamono solves the same problem by not having it.** A team genuinely running one monorepo gets very little from a cross-repo graph, because the thing Polygraph reconstructs, they already have.

This also explains the Enterprise pricing cleanly. Cross-repo coordination is an org-scale problem. Nobody buys it for one repo.

> **Polygraph makes fragmentation tolerable. Megamono removes the fragmentation.**

That framing is stronger than "complementary, not competing," and it should be the line used publicly.

### The consequence for positioning

Megamono must still never be positioned as "manage a large monorepo" — that phrasing invites the comparison and loses it on resources. Position on the three specific gaps: **non-JS graph edges**, **docs-as-agent-substrate**, and **consolidation itself** (see `spec-megamono-0009` and `spec-megamono-0010`).

If the answer to Polygraph is "consolidate instead," then Megamono is obligated to make consolidating tractable. That is why convert and import are first-class specs rather than nice-to-haves.

### The one genuine overlap to watch

**Conformance rules.** Publishing a rule once and enforcing it broadly is a good idea that works perfectly well single-repo, and it lands directly on Megamono's lint layer (`spec-megamono-0006`). Today it is gated behind Enterprise. If it ever ships outside Enterprise, the lint layer's differentiation narrows to the specific rules — platform boundaries, docs front matter, Playstack/Megamono direction — rather than the mechanism.

Nothing in Polygraph touches non-JS graph edges or the docs substrate.

## Dependency risk

Megamono's fate is tied to Nx's.

Every distinctive capability in this suite depends on Nx APIs — `createNodes` and `createDependencies` for graph inference, the plugin architecture for generators, and the project graph for `affected`. There is no meaningful portability story. Turborepo has no equivalent surface (see "Nx vs. Turborepo" below), so a migration would not be a port; it would be a rewrite of the premise.

Concrete exposures:

- **API churn.** Inference APIs have changed shape more than once. Wave 1 generators sit directly on them.
- **Commercial gravity.** Nx Cloud is the revenue engine. Features that would strengthen the OSS core may be routed to Cloud instead — conformance rules are already an example.
- **Strategic drift.** If Nx's centre of gravity moves to cross-repo and agent orchestration, single-repo ergonomics may get less attention, not more.

This is accepted, not solved. It is recorded here so it is never rediscovered as a surprise. Mitigation is limited to keeping the _conventions_ (docs IA, decision records, boundary rules) expressible independently of Nx, so the philosophy survives even if the tooling has to be rebuilt.

### Nx vs. Turborepo — resolved

**Stay on Nx.** Turborepo is a deliberately thin task runner with caching: no equivalent plugin architecture, code generation, or project-graph inference surface. Every distinctive Megamono capability depends on synthesizing projects and edges from a `Package.swift` or `Cargo.toml`.

Accepted tradeoffs: Nx is heavier and more opinionated, and Nx Cloud is a commercial gravity well.

## Commercial framing

**OSS funnel play.** Free packages, free CLI, MIT.

The addressable market — teams running large Nx monorepos on roughly this stack — is narrow. This is not a revenue line against the $30K/month target. It belongs in the `react-structured` / `react-fathom` mold: credibility, distribution, and cross-promotion.

The adjacency is the real payoff. Nx/Nest/Chakra developers are the audience for Queuebert, Basemarks, and especially Springbar.

The funnel logic: **the philosophy essay travels, the generators convert.** `monorepo.tools` is the closest precedent for how the content half works.

Honest cross-promotion is the docs and the philosophy content — not the setup wizard. See `spec-megamono-0002`, "Integrations."

### Paid tier / hosted GitHub App — declined, with reasoning

The question was raised whether scheduled health workflows (`spec-megamono-0008`) could support a paid subscription or a hosted GitHub App.

The commercial logic is real: scheduled runs need compute, and a GitHub App is a clean install story. It is a legitimate product shape in the abstract. It is declined here for two reasons.

**It walks into Polygraph.** Custom workflows — scheduled, triggered, agentic — are already one of Polygraph's three pillars, backed by Nx's funding and Enterprise sales motion. A paid hosted Megamono service competes there directly, on their terms, in the exact fight this document scopes Megamono to avoid.

**It corrupts the funnel.** Free-and-MIT is what makes Megamono's opinionated defaults readable as opinions. The moment a paid tier exists, every default reads as an upsell path — including the Springbar and Queuebert placements that `spec-megamono-0002` is deliberately careful about. The credibility is the asset; a small subscription line would be bought at its expense.

**The defensible version:** workflows run in the user's own CI, free, using compute they already pay for. If a hosted option ever appears, it is packaged convenience — never capability withheld from the free path.

**Revisit trigger:** if a non-trivial number of adopters are running the workflows and asking specifically for hosting (not features), the convenience framing can be tested. Not before.

## Assets

| Asset                 | Status                                                                               |
| --------------------- | ------------------------------------------------------------------------------------ |
| `megamono.com`        | Registered. **Canonical.**                                                           |
| `megamono.dev`        | Not part of the product surface; do not link, market, or renew on Megamono's behalf. |
| `@megamono` npm scope | Claimed                                                                              |

### TLD note

The prior portfolio convention (`.dev` canonical for developer tooling, `.com` 301-redirecting) is dropped for Megamono — but not for SEO reasons. Google treats new gTLDs the same as `.com`/`.org`; keyword TLDs give no ranking advantage or disadvantage. There is no ranking dial to optimize.

What varies is human: perceived trust, click-through, link willingness. The only thing that genuinely matters technically is **consolidation** — one canonical host, 301 everything else, never let two versions index.

`megamono.com` is canonical. Do not register a second TLD to redirect; it buys nothing measurable and adds a renewal to a portfolio already at ~803 domains.

## Naming

"Megamono" is descriptive and self-aware. That ages badly for a _product_ and well for a _methodology_ — cf. 12-Factor, local-first, POSSE. Since Megamono is a methodology with tooling attached, the name works.

(An earlier objection to the name was raised on the grounds that it reads as a category joke and collides with Mono the .NET runtime. That objection was withdrawn once the methodology framing was clear. The collision risk remains real for search but is manageable given `megamono.com` is held outright.)

## Relationship to Playstack

The clean test:

> **Megamono shapes the repository. Playstack shapes the product.**

Full boundary treatment in `spec-megamono-0007`.

## V1 scope

V1 is the package set and compatibility baseline in `spec-megamono-0000`. It is successful when a user can bootstrap or initialize an Nx repository, discover Apple and Cargo projects with correct graph edges, enforce the docs and dependency conventions locally, and run the workflow without a hosted Megamono service.

## Acceptance criteria

- Every published package is MIT and works without an Nx Enterprise or Megamono subscription.
- No `@megamono/*` package is required by generated production code.
- Public documentation uses `megamono.com` as the only canonical host.
- Positioning copy uses the repository/product distinction and does not claim generic large-monorepo management.
- Hosted execution, cross-repository graph management, and runtime product packages are absent from v1.
