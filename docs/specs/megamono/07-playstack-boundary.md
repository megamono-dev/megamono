---
id: spec-megamono-0007
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [architecture, playstack, dependencies, generators]
summary: Defines the repo-shaping versus product-shaping boundary and the complete package-emission registry.
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
    spec-megamono-0014,
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

| Thing                                        | Home      | Reasoning                                      |
| -------------------------------------------- | --------- | ---------------------------------------------- |
| Nx generators (all)                          | Megamono  | Shape repository files and graph configuration |
| `create-megamono`                            | Megamono  | Bootstraps a repo                              |
| `megamono add app`                           | Megamono  | Adds an application composition root           |
| `megamono add database`                      | Megamono  | Adds or adopts a named database project        |
| Docs IA, skills, hooks                       | Megamono  | Governs the repo                               |
| Repository lint rules, tag taxonomy          | Megamono  | Governs the repo                               |
| Playstack-specific lint rules and skills     | Playstack | Govern Playstack product packages and usage    |
| Wiring Playstack lint and skills             | Megamono  | Shapes repository configuration                |
| CI workflow generation                       | Megamono  | Structural; makes `affected` pay off           |
| Release / versioning / yalc                  | Megamono  | Repo mechanics                                 |
| `@playstack/auth` implementation             | Playstack | Runs in production                             |
| Product capability recipes and app bindings  | Playstack | Product behavior and its prerequisites         |
| Database project/path selection              | Megamono  | Repository structure                           |
| Chakra theme package                         | Playstack | Ships to the browser                           |
| Where the theme lives + who consumes it      | Megamono  | Structure                                      |
| ORM-specific database-schema artifacts       | Playstack | Define product data behavior                   |
| Database project layout + client namespacing | Megamono  | Structure                                      |
| Requested services and app candidates        | Megamono  | Declares the generated workspace's needs       |
| Springbar config and running services        | Springbar | Owns its format and product behavior           |

### The auth case, spelled out

It was genuinely ambiguous. The `User` / `Account` / `AccountMember` pattern is a _convention_ — which sounds like Megamono. But the Nest implementation is runtime code — which is Playstack.

Resolution: **Playstack owns product-capability recipes and runtime wiring; Megamono creates the application and database structure those recipes target.**

The same ownership test applies to Chakra and database adapters: Playstack owns runtime behavior and package artifacts, while Megamono owns repository placement and target configuration. The selected adapter remains visible; neither product promises portable queries across ORMs.

The command sequence makes this boundary visible: `megamono add app api` creates and governs the composition root; `playstack add auth` adds product behavior within it. The optional Playstack handoff retained by `megamono init` is a compatibility shortcut that delegates to the package-owned CLI after Megamono completes. It does not make Playstack capability installation part of the `app` generator.

## What Megamono may emit or delegate

**Megamono depends on nothing in Playstack.** No `@megamono/*` package lists a Playstack package in its own dependencies. Generators _emit_ code that imports Playstack — a template string, not a dependency edge.

That distinction is what keeps the direction rule true in practice rather than only on paper. An agent auditing this should check `package.json`, not grep for the string. The registry also retains reserved legacy generator records for stable diagnostics; those entries do not mean Megamono installs the corresponding package.

### The canonical list

| Playstack package          | Generator                                             | Purpose                                               | Required tier | V1 state                                               |
| -------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | ------------- | ------------------------------------------------------ |
| `@playstack/chakra`        | `@megamono/plugin:theme`                              | Semantic tokens and Chakra composition API            | Free          | Gated on external fixture contract                     |
| `@playstack/content`       | `@megamono/plugin:content-lib`                        | Content transforms                                    | Free          | Available; packed npm/pnpm yalc fixture passed         |
| `@playstack/observability` | `@megamono/plugin:integration-sentry`                 | Shared Sentry conventions                             | Free          | Gated on external fixture contract                     |
| `@playstack/extension`     | Future `@megamono/nx-extension:playstack` integration | Auth handoff, messaging, storage                      | Free          | Gated; base WXT generation has no Playstack dependency |
| `@playstack/auth`          | Package-owned `playstack add auth`                    | Identity runtime and database-schema artifacts        | Free          | Megamono legacy name reserved; delegated to Playstack  |
| `@playstack/accounts`      | Package-owned `playstack add accounts`                | Tenancy runtime and database-schema artifacts         | Free          | Megamono legacy name reserved; delegated to Playstack  |
| `@playstack/webhooks`      | Future package-owned capability                       | Webhook receipt runtime and database-schema artifacts | Free          | Megamono legacy name reserved                          |
| `@playstack/cache`         | Future package-owned capability                       | Cache provider wiring                                 | Free          | Megamono legacy name reserved                          |
| `@playstack/media`         | Future package-owned capability                       | Media runtime and database-schema artifacts           | Free          | Megamono legacy name reserved                          |
| `@playstack/mail`          | `@megamono/plugin:integration-postmark`               | Postmark mail driver wiring                           | Free          | Gated on external fixture contract                     |
| `@playstack/notifications` | `@megamono/plugin:emails`                             | Typed delivery request and recipient locale           | Free          | Gated on external fixture contract                     |
| `@playstack/validation`    | `@megamono/plugin:emails`                             | Runtime props validation                              | Free          | Gated on external fixture contract                     |
| `@playstack/i18n`          | `@megamono/plugin:emails`                             | Recipient-locale catalog rendering                    | Free          | Gated on external fixture contract                     |
| `@playstack/cli`           | Playstack-wiring generators                           | Package-owned artifact sync and merge                 | Free          | Available for verified skills sync; other uses gated   |
| `@playstack/lint`          | `@megamono/plugin:playstack-lint`                     | Playstack-specific ESLint presets                     | Free          | Available; packed npm/pnpm yalc fixture passed         |
| `@playstack/skills`        | `@megamono/plugin:playstack-skills`                   | Playstack product guidance                            | Free          | Available; packed npm/pnpm yalc fixture passed         |
| `@playstack/admin`         | Reserved `playstack-admin` generator                  | Headless admin runtime                                | Free          | Not published in v1                                    |
| `@playstack/admin-ui`      | `playstack-admin --ui=chakra`                         | Optional compositions                                 | Pro allowed   | Not published in v1                                    |
| `@playstack/queues`        | Reserved `playstack-queues` generator                 | Queue runtime                                         | Free          | No accepted external package contract; not published   |

### Delegating package-owned mutations

`@playstack/cli` is the universal path for artifacts that a Playstack package owns, including ORM-specific database-schema artifacts, email templates, content configuration, and locale catalogs. A Megamono generator installs or invokes that CLI in the generated workspace rather than copying its merge, drift, ejection, or update logic.

Megamono adds only the information the package CLI cannot know: it resolves the target project and conventional path from the Nx graph, records the explicit target in `playstack.json`, and wires Nx targets around the package operation. The CLI accepts those paths without reading Nx, `megamono.json`, or Megamono package state. This keeps the same package usable in a non-Nx application.

Package-owned emissions remain entirely outside the Megamono artifact registry from `spec-megamono-0014`. Megamono never mirrors their hashes, bases, managed/ejected state, or update history into `.megamono/artifacts.json`; it treats the `@playstack/cli` result and exit classification as the authority.

The same rule applies to Playstack lint and skill integrations. Megamono may install `@playstack/lint`, add its preset to repository ESLint configuration, or invoke `playstack skills sync`; Playstack owns the rules, skill corpus, sync output, and update behavior. Megamono owns only the deterministic workspace plan and surrounding Nx wiring.

The same rule now governs product-capability installation. A concise `--playstack-packages=auth,accounts` selection is dispatched as package-owned `playstack add` commands; Megamono does not translate those names into direct package installs or carry a private copy of their recipes. Megamono does resolve the repository information Playstack intentionally does not understand: the exact web and API project roots from the Nx graph. It passes those roots as `--web=<root>` and `--api=<root>` on each delegated command. Conventional `apps/web` and `apps/api` roots win, a sole tagged candidate is automatic, and ambiguity prompts or requires `--playstack-web|api=<root>` in automation. `false` deliberately omits a surface.

A fully qualified `@playstack/*` value remains an explicit direct-install escape hatch for compatibility testing and intentionally skips recipe behavior. In registry mode the selected package manager owns ordinary dependency resolution. In yalc mode Megamono owns only this escape hatch's transport safety: before mutation it validates the complete required local Playstack dependency/peer closure, then installs required third-party packages, links every missing local artifact at its validated version, and converts copied internal dependency edges to sibling `file:` references before hydration. Concise capabilities still delegate their entire closure to Playstack.

A generator that requires a package-owned artifact remains outside the published collection until `playstack:45-cli` supplies the installable package, compatible command contract, stable exit classifications, and fixture used by the Megamono acceptance suite. Gated generators must not carry a private copy of the missing mutation logic.

### The tier constraint

`playstack:01-overview` establishes the **Megamono floor**: a scaffolded app must build without a subscription, or `create-megamono` stops being a credible free tool and the funnel in `spec-megamono-0001` breaks.

> **Anything a generator emits by default is pinned to the Free tier.**

This is a real constraint on Playstack's tiering decisions, not a preference. Moving `@playstack/content` to Plus would silently break every scaffolded content library.

**This table and its packaged projection in `@megamono/plugin/emissions.json` are the enforcement point.** A generator cannot enter the published collection until its row is present, its external fixture contract passes, and every default dependency is available without authentication or payment. Reserved records preserve diagnostics and boundary intent but authorize no emission. The packaged registry is authoritative for tooling; this table explains the same contract to maintainers.

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

## Capability handoff

Megamono exposes Playstack setup only as an optional orchestration handoff:

```text
megamono init --playstack-packages=auth,accounts
playstack add auth
playstack add accounts
```

The first form completes Megamono initialization, installs the local Playstack CLI when needed, resolves the selected application roots from the local Nx graph, delegates the concise selections and explicit roots to the latter package-owned commands, and then runs `playstack init`. Playstack installs capability packages, creates product libraries, binds application surfaces, synchronizes package-owned artifacts, and reports its own recovery steps. Megamono does not duplicate those mutations under Nx generator names.

The legacy canonical names `playstack-auth`, `playstack-accounts`, `playstack-webhooks`, `playstack-cache`, and `playstack-media` remain reserved only so old automation receives a stable boundary diagnostic. They are absent from the published Nx collection and are not an implementation backlog for Megamono.

### Database targeting

The adaptive-prompting rule in practice:

- **One** compatible named database → use it silently
- **Two or more** → ask which
- `--database=<name>` skips the prompt for scripting

Megamono records the selected target in `megamono.json` for repository-owned operations. Playstack records its artifact destination under the same logical name and owns any capability-time prompt or selection; neither tool infers a business-purpose name beyond the `primary` setup default.

Megamono records the logical name, adapter, and Nx project in `megamono.json`; Playstack records the exact artifact destination under the same logical name. New Playstack targets omit `packages`, so installed schema-bearing packages are discovered by default. An explicit non-empty `packages` object is a repository-authored allowlist and Megamono preserves it; an empty object must never be generated because it means “synchronize nothing.” Prisma v1 targets require Prisma `>=6.7` native multi-file support and select the complete schema-folder root containing the datasource-bearing schema entry. A nested fragments-only target fails Megamono preflight rather than producing a misleading zero-application-file compatibility result. Drizzle targets require exported TypeScript schema modules compatible with the configured dialect. Repositories configured for a custom compose or cross-ORM translation step fail preflight rather than receiving a second composition mechanism.

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

- The emitted-package registry contains every `@playstack/*` import or install produced by a template, including dev-only lint and skill packages; a fixture scans generated output and fails on an unregistered package.
- A generator with a default dependency above the Free tier is excluded from the published collection.
- Every available Megamono generator that wires a Playstack package passes against the package's external fixture contract and supported version range; product capabilities remain delegated to Playstack.
- Package-owned artifacts are produced through `@playstack/cli`; Megamono adds graph-aware target selection and Nx wiring without duplicating package merge or update logic.
- Capability handoff passes explicit Nx-resolved surface roots, prompts on ambiguity, and requires the corresponding path flag in automation rather than guessing.
- Direct-package yalc fixtures fail on any registry fallback and prove every required local Playstack edge is linked before package-manager hydration.
- Megamono never registers or manages a Playstack-owned emission in `.megamono/artifacts.json`.
- No published `@playstack/*` package manifest or graph node depends on `@megamono/*`.
- Database-aware generators are idempotent, select or require a compatible named target deterministically, omit package allowlists for discovery by default, validate only through the configured adapter's static contract, and never connect to a database.
- Springbar selection performs the MCP handoff after successful workspace creation, while Megamono never writes Springbar configuration directly; handoff failure is non-fatal and retryable.
- The reserved queues and admin generators are absent from the v1 generator collection.
