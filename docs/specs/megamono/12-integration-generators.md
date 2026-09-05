---
id: spec-megamono-0012
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [generators, integrations, observability, lint, skills, ci]
summary: Defines versioned third-party integrations and Playstack-owned lint and skill wiring.
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
    spec-megamono-0011,
  ]
external_references:
  [
    playstack:05-provider-abstractions,
    playstack:06-webhooks,
    playstack:12-observability,
    playstack:45-cli,
  ]
---

# 12 — Integration Generators

## What these are

Generators that add a third-party service to an **existing** app:

```text
npm exec nx g @megamono/plugin:integration-sentry --project=synth-web
```

Distinct from the Integrations section in `spec-megamono-0002`, which offers categories during initial scaffolding. That is a choice made once, at repo creation. This is a different moment — an app already exists, it needs Sentry, and the conventions should be applied uniformly rather than re-derived by hand or by an agent.

## The split

Same shape as the content generators in `spec-megamono-0011`:

| Layer                                                | Owner                                        |
| ---------------------------------------------------- | -------------------------------------------- |
| Generator machinery, file emission, Nx target wiring | **Megamono**                                 |
| Runtime conventions the emitted code imports         | **Playstack** (`playstack:12-observability`) |
| The vendor SDK itself                                | The vendor                                   |

The generator is Megamono because Nx generator machinery is devDependency-only — Playstack cannot ship one without knowing Nx exists, which `spec-megamono-0007` prohibits.

What it _emits_ is Playstack. A generator emitting a runtime import is the allowed direction.

## The wizard problem

Sentry maintains `@sentry/wizard`, and the obvious design is to invoke it and layer conventions on top. Vendor owns setup, Playstack owns conventions, Megamono owns wiring — clean division, no staleness liability.

**It does not work here.** The wizard assumes a single-project repo: it looks for `package.json`, framework config, and dependencies at the directory it runs in. In an Nx workspace, dependencies live in a root `package.json` while the framework config lives in `apps/<name>/`, so neither location presents the shape it expects. Running it scoped to the app directory misdetects; running it at the root targets the wrong thing.

The same assumption breaks most vendor CLI setup tools in a monorepo.

### Consequence: own the templates

So the generator emits its own files. Which means **the staleness liability comes back**, and it needs an explicit mitigation rather than good intentions.

> **A stale generator is worse than no generator.** It produces confidently wrong setup that looks official, and the person running it has no reason to doubt it.

Sentry's Next.js integration has changed shape more than once — config files to instrumentation hooks, and so on. A generator encoding today's practice is wrong within a year unless something watches it.

### Mitigation

**1. Templates declare the SDK range they target.**

```json
{ "targets": { "@sentry/nextjs": "^10.0.0" } }
```

**2. A health check flags drift.** Added to `spec-megamono-0008`: if the installed SDK major has moved past what the template targets, report it. Weekly, to the health issue, alongside dependency alignment — which is the same class of problem and should not be a second channel.

**3. Template ownership stays with Megamono.** The package-owned update workflow in `playstack:45-cli` synchronizes Playstack emissions; it does not update Megamono-owned third-party integration templates. A template change is implemented and fixture-tested in this repository, then distributed in a new `@megamono/plugin` release. Health diagnoses consumer drift but never mutates the installed integration.

This rule applies to Megamono-authored third-party integrations. It does not transfer ownership of Playstack application wiring into Megamono. A Playstack package may publish a digest-pinned `playstack.integration.json` template; `playstack-integrate` validates and ejects that package resource into application ownership while Playstack remains the upstream template authority. The Megamono package retains only the versioned schema consumer, Nx surface mapping, conflict plan, and selected migration record.

**4. The wizard remains the reference.** Not invoked, but periodically run in a scratch single-project repo and diffed against the templates. This is a maintainer task, not automation, and should be documented as such rather than pretended away.

**5. Generated files carry a provenance comment** — template version and the SDK range it targeted. Otherwise there is no way to tell a hand-modified file from a stale generated one.

## What the generator does beyond setup

If it only wrote the vendor's boilerplate it would be hard to justify. The value is in what the wizard does not know about:

- **Nx targets** — sourcemap upload wired as a build target with correct `dependsOn`, so it runs after build and participates in caching and `affected`
- **Config placement** — DSNs, org/project mapping, and environment naming into the shared config library rather than duplicated per app (`playstack:12-observability`, "Where constants live")
- **Surface detection** — Next Pages Router, Nest, Expo, and Worker surfaces each need different files; the generator infers from the project graph rather than asking
- **CI wiring** — auth tokens as secrets, release creation on deploy
- **Conventions applied** — the emitted config imports `@playstack/observability`, so scrubbing, tagging, and filters are shared rather than per-app

That list is the actual product. "Sets up Sentry" is not.

## Generator set

| Generator                              | Emits                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `integration-sentry --project=<app>`   | Per-surface Sentry config, sourcemap target, CI secrets, `@playstack/observability` wiring |
| `integration-fathom --project=<app>`   | `react-fathom` setup, site ID into shared config                                           |
| `integration-postmark --project=<app>` | Mail driver config per `playstack:05-provider-abstractions`                                |
| `integration-stripe --project=<app>`   | Client, webhook endpoint per `playstack:06-webhooks`, CLI forwarding for local dev         |
| `playstack-lint`                       | `@playstack/lint` installation and warning-first ESLint preset wiring                      |
| `playstack-skills`                     | `@playstack/cli` invocation that synchronizes the `@playstack/skills` corpus               |

Sentry first. It is on every deployable surface, so it has the most consumers and exercises the surface-detection problem hardest.

### Playstack lint and skill wiring

The two workspace-level Playstack integrations make the ownership boundary concrete:

- `@megamono/plugin:playstack-lint` installs `@playstack/lint` as a root dev dependency and adds its consumer preset to the existing ESLint configuration. It never copies rules into `@megamono/plugin`.
- `@megamono/plugin:playstack-skills` installs the compatible Playstack CLI/skills packages when required and delegates synchronization to `playstack skills sync`. It does not place Playstack-owned files in the Megamono artifact registry.

Both generators require at least one installed `@playstack/*` product package other than the CLI, lint, or skills packages. If none exists, preflight exits `3` without mutation and explains that configuration for an unused product family is intentionally omitted. Each generator is explicit; `workspace-init`, `convert`, and an unrelated Playstack package generator never enable either integration silently.

The lint generator begins in warning mode so first-time wiring does not fail CI on the installation commit. Its plan records the initial finding count and ratchet path under the same decision-backed override contract as `spec-megamono-0006`. Tightening severities remains an explicit repository decision after the Playstack rules are visible.

The skills generator delegates destination, provenance, drift, and ejection behavior to the Playstack CLI. Megamono supplies only the repository root and package-manager-aware invocation. A missing CLI, unsupported package-contract version, destination conflict, or nonzero sync result is reported using the common recovery report after file preflight; Megamono does not fall back to copying bundled skill templates.

Both generator names are included in the published collection because `@playstack/lint`, `@playstack/skills`, and the applicable `@playstack/cli` command now have compatible Free-tier contracts. The acceptance fixture installs packed Megamono output, consumes Playstack packages from yalc, and exercises npm and pnpm workspaces.

### Ordering note

Each generator should be viable independently. Resist a shared "integration framework" until the third one is written — the abstraction is not visible from one example, and the same platform-boundary-before-abstraction rule applies here as everywhere else.

## Idempotency

These run against existing apps, which makes re-running a realistic scenario — after an SDK major, or when a template updates.

- **Detect prior installation** and offer to update rather than duplicating
- **Never silently overwrite a modified file.** Diff, show it, ask.
- **Refuse on a dirty working tree**, same rule as `spec-megamono-0009`
- Additive changes to shared config, never wholesale replacement

Application integration generators accept `--project`, `--surface`, `--config-project`, `--interactive`, `--dry-run`, and `--force`. `--surface` is inferred only when exactly one supported surface is present; an ambiguous or unknown project requires the option and exits `4` in non-interactive mode. `--force` applies only to files with a Megamono provenance record and still prints the diff; it never replaces an unowned file.

The workspace integrations instead expose:

```text
npm exec nx g @megamono/plugin:playstack-lint \
  --preset=recommended|all \
  --interactive=true \
  --dry-run

npm exec nx g @megamono/plugin:playstack-skills \
  --interactive=true \
  --dry-run
```

Lint wiring defaults to the package's `recommended` preset and warning mode; `all` is explicit. Workspace integrations do not accept Megamono `--force`: conflicts are either preserved by Megamono or delegated to the Playstack package's explicit ownership contract.

Generators emit secret **names**, never values:

| Integration | Secret names                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| Sentry      | `SENTRY_AUTH_TOKEN`; DSN, org, and project use typed non-secret config unless the consuming platform requires otherwise |
| Fathom      | None; site ID is public config                                                                                          |
| Postmark    | `POSTMARK_SERVER_TOKEN`                                                                                                 |
| Stripe      | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                                                                            |

## V1 decisions and sequencing

### Consumer verification and CI composition

`--verification` maps every active `package:integration:test` requirement to an
existing `project:target`. `--verificationProject` selects the existing Nx
project receiving a non-cached `playstack-verify` aggregation target. Mapping
arbitrary shell commands, missing targets, incomplete requirements, or another
verification aggregator is refused. The selected targets and their tests remain
application-owned; declaring a mapping does not claim that the test passed.

With an explicit `--ciWorkflow=.github/workflows/ci.yml --ciJob=quality`, the
generator appends one idempotent verification step to that job after preview and
confirmation. The job must already have a steps sequence. It preserves existing
steps, comments, jobs, triggers, permissions, secrets, and release ownership;
missing workflows and reusable-workflow jobs are not silently replaced. The
step resolves installed Nx through its package manifest and uses Node directly,
without a package-manager install or registry lookup. The repository must supply
its normal toolchain and dependency-install steps. Existing conflicting targets
or verification steps require review before any mutation.

### Reviewed existing-integration equivalences

`playstack-integrate --equivalences='<json>'` accepts application-reviewed
equivalences without changing the package-authored manifest schema:

```json
{
  "auth.allowedOrigins": "AUTH_ALLOWED_ORIGINS",
  "StorageModule": "existing:libs/storage/src/storage.module.ts#PackageStorageModule",
  "@playstack/nest-storage:nest-storage:storage-module": "existing:libs/storage/src/storage.module.ts"
}
```

Environment keys must be active manifest requirement keys and values must be
variable names, never credentials. Module/provider keys must be active declared
symbols, and mappings identify an existing workspace file and exported symbol.
Template keys use `package:integration:template`; an explicit mapping reuses the
application file instead of emitting that template. Reused Nest controllers must
statically cover the integration's declared routes. Unknown keys, missing files,
missing exports, and unsafe paths fail before writes. Plans record the reviewed
authority and reused-file digest; ordinary source-reference detection is not an
equivalence decision. Environment mappings document the binding for application
composition; they do not text-replace arbitrary package template source.

Equivalence does not certify behavioral compatibility, bypass verification, or
transfer ownership. Existing files remain application-owned and unchanged.

- Wave 1 implements `integration-sentry` for Next.js Pages Router, Nest, Expo, and Cloudflare Worker projects. A surface combination without a maintained fixture is refused rather than partially configured.
- Fathom, Postmark, and Stripe names and option contracts are reserved for later waves. They do not appear in the published generator collection until their templates and referenced Playstack fixtures pass the same acceptance suite.
- Playstack lint and skills wiring are published after passing their external package fixtures. They remain independently runnable and are never an implicit side effect of another generator.
- Templates version with `@megamono/plugin`; every template also declares an independent template revision and compatible SDK range. A template change requires a plugin release, avoiding a second distribution channel.
- Playstack's package-owned update workflow never rewrites Megamono integration templates. Template drift remains diagnosis-only until a maintainer releases and explicitly runs an updated Megamono generator.
- On-demand diagnosis uses `npm exec nx run megamono-docs:health -- --checks=integration-template-drift --no-issue`. It shares the scheduled health implementation and never mutates integrations.

## Acceptance criteria

- Sentry fixtures for all four supported surfaces generate, build, and exercise a captured test error and sourcemap association without real credentials.
- Re-running unchanged is a no-op; update mode changes only pristine managed files and refuses modified or unowned files unless its scoped force contract is satisfied.
- Dry-run and execution produce the same plan, including manifest edits, targets, config fields, and workflow secret names.
- Ambiguous surfaces and missing external Playstack fixtures fail before mutation in non-interactive mode.
- No secret value is accepted as an option, written to disk, included in a process argument, or captured in a snapshot.
- The health check identifies fixtures whose installed SDK falls outside the template range and stays silent within the range.
- Playstack artifact updates leave Megamono-owned integration files unchanged; only an explicit generator update can apply a newer template.
- Lint wiring is warning-first, records its ratchet, scopes `recommended` to installed packages, and becomes a no-op when already configured.
- Skills wiring invokes the package-owned sync command, leaves its output outside `.megamono/artifacts.json`, and fails rather than substituting Megamono-owned copies when the command contract is unavailable.
