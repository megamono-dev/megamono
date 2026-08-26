---
id: spec-megamono-0002
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [generators, bootstrap, nx, agents]
summary: Defines the new-workspace bootstrap flow, supported prompts, emitted structure, and integration boundaries.
date: 2026-08-23
supersedes: null
references:
  [
    spec-megamono-0000,
    spec-megamono-0004,
    spec-megamono-0005,
    spec-megamono-0006,
    spec-megamono-0012,
    spec-megamono-0014,
  ]
external_references: []
---

# 02 — `create-megamono`

## Why this exists as a binary

General rule for this project: **an Nx plugin already is the CLI.** `npm exec nx g @megamono/plugin:target` covers almost everything. Do not ship a separate binary unless something genuinely cannot be expressed as a generator or executor.

`create-megamono` is the legitimate exception. Bootstrapping a _new_ repo cannot be an Nx generator, because Nx isn't installed yet. `create-nx-workspace` is the precedent.

It is also the piece Nx structurally cannot take. `create-nx-workspace --preset` already scaffolds apps and libs. What it does not do — and has no opinion about — is the agent substrate: `AGENTS.md`, skills, the docs IA, `DESIGN.md`. That's the differentiated surface.

## Shape: guided, not preset

Not a fixed preset. A guided setup that asks a handful of good questions and composes the answer.

The design tension is a combinatorial matrix that becomes unmaintainable. The line:

- **Fixed (the opinionated spine):** docs and agent structure, conventions, lint rules, library boundaries, release mechanics.
- **Variable:** which platforms are in play, whether there's a Nest API, which services, which integrations, and whether the workspace uses pnpm or npm. pnpm is the default per `spec-megamono-0000`.

### Adaptive prompting

The general principle for the whole generator suite:

> **Infer when the answer is unambiguous. Ask when it isn't. Always allow an override flag.**

Nothing is more irritating than a tool interrogating you about something it could have worked out from the graph.

## The multi-app gap

`create-nx-workspace` today gives you either a `packages/` directory for an npm monorepo, or scaffolding for **a single app**. Everything after that is manual.

Megamono guides through **multiple apps and services up front**:

```
? What are you building? (space to select, enter to confirm)
  ◉ Web app (Next.js, Pages Router)
  ◉ API (NestJS)
  ◉ Worker
  ◯ Mobile (Expo)
  ◯ Desktop (Tauri)
  ◯ Apple native (Swift)
  ◯ Marketing site
```

Then services:

```
? Which services does this project need?
  ◉ PostgreSQL 17
  ◉ Redis
  ◯ ClickHouse
  ◯ Typesense
```

Then conventions, then integrations.

### V1 app outputs

The repository name becomes the package scope and default project-name prefix after normalization. Each selected surface emits one project:

| Selection    | Default project  | Implementation                                                              |
| ------------ | ---------------- | --------------------------------------------------------------------------- |
| Web app      | `<repo>-web`     | Next.js Pages Router app under `apps/web`                                   |
| API          | `<repo>-api`     | Thin Nest app under `apps/api`; features live in libraries                  |
| Worker       | `<repo>-worker`  | TypeScript Cloudflare Worker under `apps/worker`                            |
| Mobile       | `<repo>-mobile`  | Expo app under `apps/mobile`                                                |
| Desktop      | `<repo>-desktop` | Tauri app under `apps/desktop`, registered through `@megamono/nx-cargo`     |
| Apple native | `<repo>-apple`   | Xcode/Swift app under `apps/apple`, registered through `@megamono/nx-apple` |
| Marketing    | `<repo>-site`    | Next.js Pages Router app under `apps/site`                                  |

At least one app is required. Selecting Desktop or Apple installs the matching inference plugin. App names and directories have explicit override flags; collisions are detected before any files are written.

Desktop scaffolding invokes the exact `create-tauri-app` version in `@megamono/plugin/compatibility.json` with the selected package manager, `vanilla-ts` template, and Tauri 2. The bootstrap then normalizes the upstream output to `apps/desktop`: the JavaScript package, Cargo package, Tauri product, and inferred Nx project are all named `<repo>-desktop`; the application identifier is `com.<repo>.desktop`; `apps/*` is registered in the selected workspace format; and `@megamono/nx-cargo` is added to `nx.json` with `scope:<repo>` and `tauriTargetName:tauri-build`. The distinct target name preserves the upstream `tauri` script without colliding with the cacheable inferred Tauri build. Every JavaScript and Rust dependency emitted by the upstream template is replaced with its exact tested compatibility pin before installation or graph construction.

### CLI contract

```text
npx create-megamono <name>
  --directory <path>
  --apps web,api,worker,mobile,desktop,apple,site
  --services postgres,redis,clickhouse,typesense
  --service-runner none|springbar
  --integrations sentry
  --interactive true|false
  --install true|false
  --package-manager pnpm|npm
  --local-packages registry|yalc
  --verify none|config|build
  --cleanup-on-failure
  --dry-run
```

Defaults are `--service-runner=none`, no integrations, `--install=true`, `--package-manager=pnpm`, `--local-packages=registry`, and `--verify=config`. Non-interactive mode requires `name` and `apps`; all other omitted values use those defaults. `--verify=config` runs formatting, docs validation, `megamono:check`, and graph creation. `--verify=build` additionally runs affected build/test/lint targets for generated projects.

`--local-packages=yalc` is a development-only override for exercising unpublished Megamono packages in integration repositories. Third-party scaffold dependencies still come from their exact compatibility pins. Before staging, the binary resolves `yalc dir` and requires the exact compatible versions of `@megamono/plugin` plus each selected platform plugin. It then adds those packages as local dev dependencies and hydrates their transitive registry dependencies with the selected package manager before invoking any generator. A missing executable, package, or exact version exits `3` without creating the staging directory. The default registry flow never reads the yalc store.

For pnpm, bootstrap records the exact tested manager version and configures `allowBuilds` before adding plugins or invoking generators. The allowlist contains only lifecycle packages exercised by the pinned scaffold matrix and lives in the compatibility registry; an unlisted lifecycle script fails the transaction instead of being approved implicitly.

The integration prompt and flag enumerate only generators currently present in the published collection. Reserved names such as Fathom, Postmark, and Stripe are not accepted as bootstrap options until their availability gate in `spec-megamono-0000` passes.

## The Nest feature-library convention

Nest features live in feature-scoped libraries named `@[repo]/nest-[feature]`, composed into the main API module. Nothing substantive lives in the API app directory.

**This is the default. Do not ask.** It's a genuinely good pattern and being opinionated is the entire pitch. Leave it configurable in `megamono.json` for people who disagree; don't spend a prompt on it.

## Emitted agent files

| File              | Emit?                       | Notes                                                          |
| ----------------- | --------------------------- | -------------------------------------------------------------- |
| `AGENTS.md`       | **Yes — the single source** | Portable repository instructions                               |
| `CLAUDE.md`       | **Yes, as a pointer only**  | Imports/refers to `AGENTS.md`; never a second copy             |
| `DESIGN.md`       | **Yes**                     | See below                                                      |
| `.agents/skills/` | Yes                         | Canonical cross-agent skill source; see `spec-megamono-0005`   |
| `.claude/skills`  | Yes                         | Relative symlink to `.agents/skills` for Claude Code discovery |
| `docs/` IA        | Yes                         | See `spec-megamono-0004`                                       |

**Do not ship `AGENTS.md` and `CLAUDE.md` as separate opinions.** Two rule bodies mean divergence. `AGENTS.md` owns the content; `CLAUDE.md` contains only the supported import/pointer syntax.

`DESIGN.md` earns its slot specifically: the documented failure mode is a build straying from the design vision over time (the Prismark case). A design brief that lives in the repo and is read by the agent before UI work is a direct mitigation.

## Services & Springbar

Springbar is a **first-party option**, and this is defensible rather than promotional: the scaffolder just created a set of services, and Springbar solves the "now run them" problem it created. That's completing a workflow.

If selected, the final post-commit step asks Springbar's MCP to inspect the generated workspace and then calls `setup_workspace` with the exact generated app candidates, requested services, tested versions, and named dependents. Megamono does not construct `springbar.toml`; Springbar owns and validates that format and materializes its configuration atomically.

Services bind to generated backend surfaces (`api` and `worker`) when either exists. If the workspace has no backend surface, they bind to all selected app candidates. Candidate names come from `inspect_candidates`, matched against the generated project names and `apps/<surface>` directories; an ambiguous or missing match refuses only the optional Springbar handoff rather than guessing.

If no runner is selected, service requirements remain in `megamono.json` and Springbar's MCP is not contacted. Service versions are explicit and never `latest`; PostgreSQL defaults to 17 while the other service versions come from `@megamono/plugin/compatibility.json`.

**Boundary:** _Megamono declares what services a project needs. Springbar runs them._ Megamono must not grow service orchestration.

## Integrations: category first, options within

The rule, modelled on Laravel Sail (pick your database, your search provider, your mailer — and nobody reads it as Laravel selling you anything, because the choices are genuine):

> **Offer the category. List real options. Own products earn their slot on merit, not by being the default.**

```
? Error monitoring
  ◯ None
  ◯ Sentry
```

The Sentry row appears only when its external fixture gate passes. Future categories such as analytics and response caching must offer genuine vendor alternatives before first-party products appear; reserved integration names are not displayed.

**What must not happen:** a setup wizard that offers Basemarks and Pregraph with no alternatives. Nothing about scaffolding requires analytics. The moment a developer smells placement in a setup flow, the tool loses the credibility that is the entire point of shipping it free.

Honest cross-promotion is the docs and the philosophy essay.

## Transaction and failure behavior

The binary creates the workspace in a sibling staging directory. It performs all scaffolding, installation, and requested verification there, then atomically renames the staging directory to the requested destination. The destination must not exist or must be empty. On failure, the destination is untouched and the staging directory is retained with `MEGAMONO-RECOVERY.md`; `--cleanup-on-failure` may remove it.

The optional Springbar MCP handoff runs only after that atomic commit because Springbar registers the final absolute workspace path. It is a post-bootstrap integration, not part of the filesystem transaction. An unavailable/read-only MCP, stopped Springbar daemon, or candidate mismatch leaves the successfully created workspace intact and prints an actionable retry payload; it never creates a second staging recovery directory or directly writes a partial Springbar manifest.

The binary never initializes or modifies an existing workspace. Existing Nx workspaces use:

```text
npm exec nx g @megamono/plugin:workspace-init
```

Its survey, modular adoption, conflict, and recovery contract is normative in `spec-megamono-0014`.

That generator refuses a workspace already carrying `megamono.json` unless it is performing a schema migration.

## V1 decisions

- pnpm and npm are supported. pnpm is the default; other or conflicting lockfiles fail preflight with an explicit compatibility message.
- Selecting `apple` requires macOS. On Linux it exits `3` before staging; other selections remain supported.
- The binary creates new workspaces only; `workspace-init` owns existing workspaces.
- No analytics or first-party product integration is selected by default.
- Generated code targets the compatibility ranges in `spec-megamono-0000`; it never resolves unbounded `latest` versions.

## Acceptance criteria

- Every app selection alone and the all-app combination passes `--verify=config` in a fresh fixture.
- Non-interactive creation with complete flags never reads stdin; missing required flags exits `4` before creating the destination.
- Dry-run and execution produce the same ordered plan.
- `--service-runner=springbar` places an `inspect_candidates` → `setup_workspace` handoff after the atomic commit; `runner=none` never contacts Springbar.
- The Springbar setup payload selects only requested generated apps, pins every requested service version, and binds services to API/worker candidates when present or all selected candidates otherwise.
- If Springbar is unavailable or candidate matching is ambiguous, workspace creation still succeeds and reports a retryable handoff without a partial `springbar.toml`.
- A forced failure during install or verification leaves the requested destination untouched and writes a recovery report in staging.
- Re-running against a non-empty destination exits `3` without modifying it.
- `AGENTS.md` contains the rules and `CLAUDE.md` contains only the pointer/import.
- No generated manifest uses an unbounded dependency range, and no secret value appears in generated files or process arguments.
- The final workspace passes docs validation, structural checks, graph construction, and a selected-package-manager install from a clean cache.
