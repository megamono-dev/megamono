---
id: spec-megamono-0006
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [lint, ci, release, architecture]
summary: Defines deterministic enforcement layers, project tags, CI generation, release mechanics, and repository configuration.
date: 2026-08-23
supersedes: null
references:
  [
    spec-megamono-0000,
    spec-megamono-0002,
    spec-megamono-0004,
    spec-megamono-0007,
    spec-megamono-0011,
    spec-megamono-0014,
  ]
external_references: [playstack:39-i18n, playstack:43-events]
---

# 06 — Conventions, Lint, CI & Release (`@megamono/plugin`)

## The sleeper

Everyone scaffolds. Almost nobody keeps the repo honest six months later.

Scaffolding decays the moment someone adds a library by hand. If Megamono only generates structure, it's a template — and templates rot. The enforcement layer is what makes it a philosophy rather than a starter kit.

This is the most defensible package in the suite, and the least obvious.

## Deterministic enforcement layers

Deterministic checks run on every pull request, but not every check belongs in ESLint.

| Layer              | Owns                                                                                                         | Target                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| ESLint plugin      | TypeScript imports, Node built-ins, deep relative imports, JSX literals                                      | Each project's `lint` target |
| Structural checker | Project tags, naming, manifest dependencies, platform/project graph boundaries, Megamono/Playstack direction | `megamono:check`             |
| Docs validator     | Front matter, lifecycle, topics, IDs, references, visibility entry points                                    | `megamono-docs:validate`     |

The structural checker uses the Nx project graph but remains MIT and local; it does not require Nx Enterprise Conformance.

### Tag taxonomy

Generated and enforced:

```
type:app | type:feature | type:ui | type:data | type:util
scope:<product>
platform:web | platform:node | platform:worker | platform:apple
platform:rust | platform:php | platform:extension
visibility:public | visibility:internal # apps only
capability:theme-tokens            # optional platform-neutral util library
```

Every project has exactly one `type:` and one `scope:` tag. Executable projects have exactly one `platform:` tag; libraries have zero or one, where zero means platform-neutral. Every app has exactly one visibility tag; non-app projects have none. `capability:theme-tokens` is allowed only on a platform-neutral `type:util` library and must be unique when present.

Dependency direction is fixed:

- A scope imports itself or `scope:shared`; `scope:shared` never imports a product scope.
- `type:app` may import any type in its allowed scope.
- `type:feature` may import `ui`, `data`, and `util`, but not another feature.
- `type:ui` and `type:data` may import `util`; neither imports the other.
- `type:util` imports only `type:util`.
- A platform-tagged project imports the same platform or a platform-neutral project. `worker` never imports `node`; `extension` never imports `node` unless code lives in a separate build-time project.

When `structure-review` recommends extracting or moving a project, it must propose the complete tag change needed to preserve this matrix. A recommendation that would immediately fail deterministic checks without naming the required tag or dependency correction is incomplete.

### Megamono versus Playstack rules

The ownership sorting test is:

> **Would this rule mean anything in a repository with zero Playstack packages installed?**

Yes means Megamono owns it. No means the applicable Playstack lint package owns it. Megamono may generate the workspace wiring for a Playstack-owned preset, but it does not duplicate the rule or make Playstack depend on Megamono.

### Rules

| Rule                       | Layer               | Severity                      | Enforces                                                          |
| -------------------------- | ------------------- | ----------------------------- | ----------------------------------------------------------------- |
| `module-boundaries`        | ESLint + structural | Error                         | Type/scope direction for source and inferred graph edges          |
| `no-deep-relative-imports` | ESLint              | Error                         | Cross-project imports use the path alias                          |
| `require-tags`             | Structural          | Error                         | Exact tag cardinality and allowed values                          |
| `naming-convention`        | Structural          | Error                         | Nest features match `@[repo]/nest-[feature]`                      |
| `megamono-dev-only`        | Structural          | Error                         | `@megamono/*` appears only in root `devDependencies`              |
| `playstack-direction`      | Structural          | Error                         | No `@playstack/*` manifest or graph edge depends on `@megamono/*` |
| `platform-boundary`        | ESLint + structural | Error                         | Platform capability rules above                                   |
| `docs-*`                   | Docs validator      | Error except corpus direction | Schema, lifecycle, vocabulary, reference, and visibility rules    |
| `docs-corpus-direction`    | Docs validator      | Warning                       | Content-level docs do not reference repo-level IDs or paths       |
| `no-bare-jsx-strings`      | ESLint              | Warning                       | User-facing strings go through `t()`                              |

The docs rules exist to keep retrieval working (`spec-megamono-0004`), and each addresses a failure that is silent rather than loud:

- **Topic drift.** Free-form tagging becomes `auth`, `authentication`, and `Auth` within a month, at which point topic filtering returns partial results — the worst failure mode, because it looks like it worked.
- **Dangling references.** ID-based cross-referencing is what lets archiving move a document without rewriting every citation. It only holds if unresolved IDs fail the build.
- **Visibility leaks.** Publishing a repo-level doc is legitimate when deliberate; the failure is publishing one because an import happened to typecheck. Error, not warning — a leak is not a style problem.
- **Missing abort reasons.** An aborted plan without a reason is indistinguishable from neglect, and carries no signal. The reason is the entire archival value.

`no-bare-jsx-strings` exists so the i18n _discipline_ holds while the portfolio still ships English only (`playstack:39-i18n`). Retrofitting i18n means fixing every hard-coded string, every concatenated sentence, and every physical CSS property; enforcing the habit early makes adding a locale a translation task rather than a refactor.

`docs-corpus-direction` and `no-bare-jsx-strings` are the two warnings in the set. All structural rules are errors by default.

Public-facing vs. internal is declared per-app by Nx tag, the same mechanism as `platform-boundary` below. Implementation detail in `spec-megamono-0011`.

That last one is worth calling out: Cloudflare Workers compatibility is a **forcing function for genuine runtime agnosticism**. If a core library can build for a Worker, it's actually portable. Encoding that as a lint rule turns an architectural principle into something that fails CI.

## CI workflow generation

Emitted per repo, tuned to the selected platforms.

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0
- run: pnpm install --frozen-lockfile
- uses: nrwl/nx-set-shas@v5
- run: pnpm exec nx affected -t lint test build
```

The CI job grants `contents: read` and `actions: read`; pull-request and merge-queue jobs also grant `pull-requests: read`. No generic CI job has write permission.

Deployment is a separate job, never part of the generic CI command. It runs only on the default branch, declares a GitHub Environment per destination, uses environment protection for production, and invokes the selected package manager's Nx execution command after CI succeeds. A repository may omit deploy entirely. The example above is pnpm-specific. npm emits `npm ci` and `npm exec nx --`; Yarn emits its version-appropriate immutable/frozen install and `yarn nx`; Bun emits `bun install --frozen-lockfile` and `bunx nx`.

### The `affected` base — pin this

Nx computes affected from a git diff base. The failure modes:

- **Long-lived branches** — base drifts, over-reports until everything is affected
- **Squash merges** — history rewritten, base commit no longer exists, silent under-reporting
- **Shallow clones** — CI can't reach the base at all

Do not leave this for users to discover. The generated GitHub workflow uses `actions/checkout@v7` with `fetch-depth: 0`, pins `nrwl/nx-set-shas@v5`, and documents the convention in `AGENTS.md`. Pull requests compare against their base branch; default-branch runs compare against the last successful workflow run.

### Polyglot CI

Platform selection drives separate jobs: Linux/Node for web, Node, Worker, Cargo and PHP projects; macOS for Apple projects. A lightweight graph-planning job computes whether each job has affected targets before the expensive toolchain setup. Jobs do not attempt to change runner OS dynamically.

**Apple-specific note:** `xcodebuild -downloadComponent MetalToolchain` if the Xcode installation is wiped by auto-update. Worth generating as an explicit CI step rather than assuming the runner image has it.

## Release & versioning

Repo mechanics, so this is Megamono rather than Playstack — even though what it releases are Playstack packages.

### Local package vetting (yalc)

Hard-won conventions, generated rather than rediscovered:

- Run `yalc` from `dist/packages/<name>`, **not** from source
- Add `.yalc/**` to `namedInputs` so Nx cache invalidation notices linked changes
- Gitignore `.yalc/` and `yalc.lock`
- Do **one** real prerelease publish before flipping anything to `latest`

### Prerelease dist-tags

The dogfooding strategy starts with public npm prereleases under the canonical package names and the `next` dist-tag. Plain installs remain unaffected until a stable version is deliberately promoted to `latest`; testers select `@next` or pin an exact prerelease. This exercises the final registry, CI, deployment, and installation path without distributing long-lived private-registry credentials.

The fixed `megamono` group contains `@megamono/cli`, `@megamono/plugin`, `@megamono/nx-apple`, `@megamono/nx-cargo`, and `@megamono/nx-cloudflare`. `create-megamono` retains its independently tagged release group, while the same workflow versions, validates, and publishes both groups. Later accepted packages join the appropriate public group only after their packed fixtures pass.

One manually dispatched workflow owns both channels. It derives prerelease ID, npm dist-tag, GitHub Release type, and public access from a `next | latest` choice; those values cannot drift independently. `next` accepts only `prerelease` or an exact `X.Y.Z-next.N`, runs from `main` or `release/*`, and creates a GitHub prerelease that is not marked latest. `latest` accepts only stable semver bumps or exact stable versions, runs from `main`, and refuses unless every current package version is a prerelease exactly equal to its npm `next` version. A repository-wide concurrency lock prevents either channel from racing another version mutation.

GitHub environments provide the external protection layer. `npm-next` permits `main` and protected `release/*` branches. `npm-latest` permits only `main`, requires reviewers, and should prevent self-approval. The workflow also enforces those ref rules in code, requires a clean checkout after its packed fixtures, and pushes its version commit back to the selected authorized branch rather than unconditionally targeting `main`.

Publishing uses npm trusted publishing from `megamono-dev/megamono/.github/workflows/release.yml`, with `id-token: write`, Node 24, and npm 11.5.1 or newer. Because npm permits only one trusted publisher per package, its optional environment field remains unset; the repository's two GitHub environments still gate their respective jobs. Public-repository publication receives npm provenance automatically. A temporary npm token may bootstrap trust configuration outside this workflow, but no long-lived publish token belongs in the committed release path.

GitHub Packages is not used for Megamono because its npm namespace would have to match the repository owner (`megamono-dev`), which would force a temporary `@megamono-dev/*` rename. A self-hosted registry remains unnecessary.

The generator emits the release config, the tag strategy, and the CI job.

Lint preset changes follow the same compatibility rule as other validation contracts: adding a warning-only diagnostic is a minor release; adding a default error, promoting a warning to an error, or tightening an existing error so previously valid code fails is a breaking release. Existing-workspace adoption may still introduce that diagnostic through the warning-and-ratchet contract below.

## `megamono.json`

Repo-level config recording the choices made at scaffold time, so generators added later stay consistent with the repo's conventions rather than re-prompting.

```jsonc
{
  "$schema": "./node_modules/@megamono/plugin/schemas/megamono.schema.json",
  "version": 1,
  "conventions": {
    "nestFeatureLibraries": true,
    "docsLocation": "centralized",
    "packageManager": "npm",
    "apps": {
      "web": {
        "router": "pages",
        "src": true,
        "ui": "chakra",
        "e2e": "playwright",
      },
      "api": { "framework": "nest", "featureLibraries": true, "e2e": "jest" },
    },
    "rules": {
      "no-bare-jsx-strings": { "severity": "warning" },
    },
  },
  "platforms": ["web", "node", "apple", "rust"],
  "topics": { "extend": ["auth", "billing", "sessions"] },
  "docs": { "reportRetentionDays": 84 },
  "health": {
    "cadence": "weekly",
    "checks": {
      "dependency-alignment": true,
      "spec-drift": true,
      "stale-plans": true,
      "orphaned-libraries": true,
      "integration-template-drift": true,
    },
  },
  "databases": {
    "primary": { "adapter": "prisma", "project": "database-primary" },
    "analytics": { "adapter": "drizzle", "project": "database-analytics" },
  },
  "services": { "runner": "springbar" },
  "ports": { "web": 4200, "site": 4201, "api": 3000 },
}
```

Database names are stable identifiers shared with the corresponding Playstack configuration. `megamono.json` owns the Nx project mapping; `playstack.json` owns the package-artifact target within that project. A generated Playstack target omits `packages` so installed artifact packages are discovered; a repository may later add a non-empty `packages` object as an explicit allowlist. Megamono never emits an empty allowlist because Playstack correctly interprets it as no packages. Megamono health rejects adapter disagreement or a Playstack target outside the selected project rather than guessing which configuration wins.

Fresh database projects use `libs/<adapter>/<name>` and an explicitly registered package-manager workspace entry. Commands inside Nx targets invoke workspace binaries directly because Nx already places `node_modules/.bin` on `PATH`; package-manager execution wrappers are reserved for top-level orchestration and must not trigger dependency reconciliation during validation or generation.

Prisma uses native multi-file schema support and requires Prisma `>=6.7`; each Playstack fragment remains an independent `.prisma` file. Drizzle uses exported TypeScript schema modules under a configured schema directory. Megamono scaffolds those native formats and never implements a cross-ORM composition or translation layer.

The deprecated `prisma.projects` input is accepted for one compatibility window only when `databases` is absent. It normalizes each project into a same-named Prisma database target. Configuring both shapes is an error, and every new write emits only `databases`.

This is what makes adaptive prompting possible (`spec-megamono-0002`): a generator reads `megamono.json`, and only asks when the config genuinely doesn't determine the answer.

Application presets and assigned ports are repository conventions, not `create-megamono` state. `@megamono/plugin:app` records each accepted assignment before another app can claim it. A named additional instance receives the next deterministic free port in its platform range unless the caller supplies a unique explicit port. Existing valid assignments are never renumbered because a later app sorts earlier by name.

## Rule overrides

Structural rules default to errors and stylistic rules to warnings. Every rule is individually configurable. Disabling a structural rule requires `{ "severity": "off", "decision": "decision-..." }`; validation fails if that decision ID does not resolve. Warning rules may be disabled without a decision.

Freshly created workspaces use those defaults immediately. Convert and workspace-init may introduce a structural rule as a temporary warning when an existing workspace already violates it, but the adoption decision must record the rule, initial finding count, and ratchet plan. Repository health keeps that override visible until it becomes an error or a later accepted decision explicitly retains it.

## Acceptance criteria

- A fixture for every allowed and forbidden dependency in the type/scope/platform matrix produces the expected diagnostic.
- Graph-only Apple, Cargo, and PHP edges are checked even when ESLint sees no TypeScript import.
- A Playstack package depending on any Megamono package fails `megamono:check`.
- A structural rule cannot be disabled without a valid decision ID.
- Existing-workspace warning overrides require an adoption decision and remain visible in repository health until resolved.
- Generated CI uses full history and `nx-set-shas@v5`, separates deploy from CI, and emits only jobs required by configured platforms.
- `megamono.json` validates before any generator reads it; unknown `version` values fail with a migration instruction.
- Release dry runs and local-registry e2e tests complete before the workflow can publish a `latest` tag.
