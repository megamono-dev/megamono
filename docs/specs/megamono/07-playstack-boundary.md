---
id: spec-megamono-0007
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [architecture, playstack, dependencies, generators]
summary: Defines the repo-shaping versus product-shaping boundary and the complete runtime-package emission registry.
date: 2026-08-23
supersedes: null
references:
  [
    spec-megamono-0000,
    spec-megamono-0001,
    spec-megamono-0002,
    spec-megamono-0003,
    spec-megamono-0011,
    spec-megamono-0012,
  ]
external_references:
  [
    playstack:01-overview,
    playstack:02-auth,
    playstack:03-accounts,
    playstack:05-provider-abstractions,
    playstack:06-webhooks,
    playstack:07-media,
    playstack:11-content,
    playstack:12-observability,
    playstack:20-admin,
    playstack:21-notifications,
    playstack:26-extension,
    playstack:27-validation,
    playstack:39-i18n,
    playstack:45-cli,
  ]
---

# 07 — The Megamono / Playstack Boundary

## The rule

> **Megamono shapes the repository. Playstack shapes the product.**

When code runs is incidental. Build-time schema fragments and transforms are Playstack when they define product behavior; a generator that places them is Megamono. Megamono is a dev dependency. Playstack is a runtime/build dependency of the generated product.

## Adjudicated cases

| Thing                                      | Home      | Reasoning                                      |
| ------------------------------------------ | --------- | ---------------------------------------------- |
| Nx generators (all)                        | Megamono  | Shape repository files and graph configuration |
| `create-megamono`                          | Megamono  | Bootstraps a repo                              |
| Docs IA, skills, hooks                     | Megamono  | Governs the repo                               |
| Lint rules, tag taxonomy                   | Megamono  | Governs the repo                               |
| CI workflow generation                     | Megamono  | Structural; makes `affected` pay off           |
| Release / versioning / yalc                | Megamono  | Repo mechanics                                 |
| `@playstack/auth` implementation           | Playstack | Runs in production                             |
| Auth wiring into a repo                    | Megamono  | Generator                                      |
| Chakra theme package                       | Playstack | Ships to the browser                           |
| Where the theme lives + who consumes it    | Megamono  | Structure                                      |
| Prisma schema fragments                    | Playstack | Define product data behavior                   |
| Prisma library layout + client namespacing | Megamono  | Structure                                      |
| Requested services and app candidates      | Megamono  | Declares the generated workspace's needs       |
| Springbar config and running services      | Springbar | Owns its format and product behavior           |

### The auth case, spelled out

It was genuinely ambiguous. The `User` / `Account` / `AccountMember` pattern is a _convention_ — which sounds like Megamono. But the Nest implementation is runtime code — which is Playstack.

Resolution: **Megamono generates the wiring; Playstack provides the package it wires to.**

Same for the Chakra theme, and same for Prisma.

## What Megamono actually emits

**Megamono depends on nothing in Playstack.** No `@megamono/*` package lists a Playstack package in its own dependencies. Generators _emit_ code that imports Playstack — a template string, not a dependency edge.

That distinction is what keeps the direction rule true in practice rather than only on paper. An agent auditing this should check `package.json`, not grep for the string.

### The canonical list

| Playstack package          | Generator                               | Purpose                                     | Required tier | V1 state                                             |
| -------------------------- | --------------------------------------- | ------------------------------------------- | ------------- | ---------------------------------------------------- |
| `@playstack/content`       | `@megamono/plugin:content-lib`          | Content transforms                          | Free          | Gated on external fixture contract                   |
| `@playstack/observability` | `@megamono/plugin:integration-sentry`   | Shared Sentry conventions                   | Free          | Gated on external fixture contract                   |
| `@playstack/extension`     | `@megamono/nx-extension`                | Auth handoff, messaging, storage            | Free          | Gated on external fixture contract                   |
| `@playstack/auth`          | `@megamono/plugin:playstack-auth`       | Identity runtime and Prisma fragment        | Free          | Gated on external fixture contract                   |
| `@playstack/accounts`      | `@megamono/plugin:playstack-accounts`   | Tenancy runtime and Prisma fragment         | Free          | Gated on external fixture contract                   |
| `@playstack/webhooks`      | `@megamono/plugin:playstack-webhooks`   | Webhook receipt runtime and Prisma fragment | Free          | Gated on external fixture contract                   |
| `@playstack/cache`         | `@megamono/plugin:playstack-cache`      | Cache provider wiring                       | Free          | Gated on external fixture contract                   |
| `@playstack/media`         | `@megamono/plugin:playstack-media`      | Media runtime and Prisma fragment           | Free          | Gated on external fixture contract                   |
| `@playstack/mail`          | `@megamono/plugin:integration-postmark` | Postmark mail driver wiring                 | Free          | Gated on external fixture contract                   |
| `@playstack/notifications` | `@megamono/plugin:emails`               | Typed delivery request and recipient locale | Free          | Gated on external fixture contract                   |
| `@playstack/validation`    | `@megamono/plugin:emails`               | Runtime props validation                    | Free          | Gated on external fixture contract                   |
| `@playstack/i18n`          | `@megamono/plugin:emails`               | Recipient-locale catalog rendering          | Free          | Gated on external fixture contract                   |
| `@playstack/cli`           | Playstack-wiring generators             | Package-owned artifact sync and merge       | Free          | Gated on external CLI fixture contract               |
| `@playstack/admin`         | Reserved `playstack-admin` generator    | Headless admin runtime                      | Free          | Not published in v1                                  |
| `@playstack/admin-ui`      | `playstack-admin --ui=chakra`           | Optional compositions                       | Pro allowed   | Not published in v1                                  |
| `@playstack/queues`        | Reserved `playstack-queues` generator   | Queue runtime                               | Free          | No accepted external package contract; not published |

### Delegating package-owned mutations

`@playstack/cli` is the universal path for artifacts that a Playstack package owns, including Prisma fragments, email templates, content configuration, and locale catalogs. A Megamono generator installs or invokes that CLI in the generated workspace rather than copying its merge, drift, ejection, or update logic.

Megamono adds only the information the package CLI cannot know: it resolves the target project and conventional path from the Nx graph, records the explicit target in `playstack.json`, and wires Nx targets around the package operation. The CLI accepts those paths without reading Nx, `megamono.json`, or Megamono package state. This keeps the same package usable in a non-Nx application.

A generator that requires a package-owned artifact remains outside the published collection until `playstack:45-cli` supplies the installable package, compatible command contract, stable exit classifications, and fixture used by the Megamono acceptance suite. Gated generators must not carry a private copy of the missing mutation logic.

### The tier constraint

`playstack:01-overview` establishes the **Megamono floor**: a scaffolded app must build without a subscription, or `create-megamono` stops being a credible free tool and the funnel in `spec-megamono-0001` breaks.

> **Anything a generator emits by default is pinned to the Free tier.**

This is a real constraint on Playstack's tiering decisions, not a preference. Moving `@playstack/content` to Plus would silently break every scaffolded content library.

**This table is the enforcement point.** A generator cannot enter the published collection until its row is present, its external fixture contract passes, and every default dependency is available without authentication or payment.

### The admin generator is the case to watch

`playstack:20-admin` reserves `@megamono/plugin:playstack-admin`, scaffolding an app that imports `@playstack/admin` (headless) and `@playstack/admin-ui` (Chakra compositions). It is not published in v1; the external contract and Free-tier rule must be satisfied first.

Being an explicitly invoked generator does not bypass the floor: its default output must still install and render without a subscription.

**Resolution:** the admin generator emits the **headless layer by default**, with the Pro compositions behind a flag or a follow-up step. A scaffolded admin app should render — plainly — without a subscription.

## Dependency direction — one-directional, strictly

Megamono may know about Playstack. **Playstack must never know Megamono exists.**

```
@megamono/*  ──knows about──▶  @playstack/*
@playstack/* ──── never ────▶  @megamono/*
```

Violating this couples a runtime library to a build tool, and anyone using Playstack outside an Nx repo pays for it. That would defeat the point of publishing Playstack at all.

Enforce it in `megamono:check` against package manifests and the Nx graph, not by grepping template source.

## Integration generators

Megamono ships generators that install and wire Playstack packages. This is a nice proof of the boundary: Playstack ships the runtime; Megamono knows how to place it in a repo.

```
npm exec nx g @megamono/plugin:playstack-auth
npm exec nx g @megamono/plugin:playstack-accounts
npm exec nx g @megamono/plugin:playstack-webhooks
npm exec nx g @megamono/plugin:playstack-cache
npm exec nx g @megamono/plugin:playstack-media
```

Each generator, typically:

1. Installs the package
2. Generates the Nest feature library (`@[repo]/nest-[feature]`)
3. Wires the module into the API app
4. Calls `@playstack/cli` to synchronize the package-owned fragment into `prisma/models/<package>.prisma` in the chosen Prisma project
5. Validates the combined schema with the repository's configured Prisma command
6. Prints the exact migration command but never applies or creates a database migration automatically
7. Creates a proposed decision record noting what will be installed and why; the user accepts it explicitly

### Prisma targeting

The adaptive-prompting rule in practice:

- **One** Prisma project in the graph → use it silently
- **Two or more** → ask which
- `--prisma-project=<name>` flag skips the prompt for scripting

Recorded in `megamono.json` so subsequent generators don't re-ask.

V1 requires Prisma `>=6.7` native multi-file support. Repositories configured for a compose step fail preflight as unsupported rather than receiving a second composition mechanism.

## The Springbar boundary (adjacent, same shape)

> **Megamono declares what services a project needs. Springbar runs them.**

Megamono records requested services and generated app candidates in `megamono.json`. When Springbar is selected during `create-megamono`, the post-bootstrap handoff calls Springbar's MCP `inspect_candidates` and then `setup_workspace` with the selected candidates, explicit service versions, and dependents. Springbar owns, validates, and atomically materializes its configuration; Megamono does not serialize `springbar.toml` or define a second canonical Springbar schema.

The handoff is optional and belongs only to new-workspace creation. `workspace-init` never contacts Springbar, and choosing no runner leaves the service declaration in `megamono.json`. An unavailable or read-only MCP, daemon failure, or ambiguous candidate match leaves the created workspace intact and returns the retry payload defined by `spec-megamono-0002`.

Megamono must not grow orchestration, health checks, tunnels, or process management — all of that is Springbar's product surface.

## The Relaypath boundary (adjacent, in Playstack's docs)

> **Playstack receives webhooks. Relaypath delivers them.**

Detailed in `playstack:06-webhooks`.

## The general pattern

Three boundaries, one shape:

| Declares / receives           | Runs / delivers               |
| ----------------------------- | ----------------------------- |
| Megamono service requirements | Springbar config and services |
| Playstack                     | Relaypath                     |
| Megamono repository wiring    | Playstack product behavior    |

In each case the left side is thinner than it wants to be, and holding that line is what keeps the products from eating each other.

## Acceptance criteria

- The emitted-package registry contains every `@playstack/*` import or install produced by a template; a fixture scans generated output and fails on an unregistered package.
- A generator with a default dependency above the Free tier is excluded from the published collection.
- Every published Playstack generator passes against the package's external fixture contract and supported version range.
- Package-owned artifacts are produced through `@playstack/cli`; Megamono adds graph-aware target selection and Nx wiring without duplicating package merge or update logic.
- No published `@playstack/*` package manifest or graph node depends on `@megamono/*`.
- Prisma generators are idempotent, select or require a target deterministically, validate the combined schema, and never connect to a database.
- Springbar selection performs the MCP handoff after successful workspace creation, while Megamono never writes Springbar configuration directly; handoff failure is non-fatal and retryable.
- The reserved queues and admin generators are absent from the v1 generator collection.
