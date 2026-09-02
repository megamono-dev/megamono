---
id: spec-megamono-0003
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [generators, nx, apple, cargo, graph]
summary: Defines language-plugin graph contracts, first-party library generators, wave sequencing, and acceptance surfaces.
date: 2026-08-23
supersedes: null
references:
  [
    spec-megamono-0000,
    spec-megamono-0006,
    spec-megamono-0007,
    spec-megamono-0014,
    spec-megamono-0015,
  ]
external_references: [playstack:26-extension]
---

# 03 — Generator Roadmap

## The actual product

Scaffolding a project in language X is a thin wrapper around that ecosystem's own init command. **The value is the graph edge.**

Nx needs to know that touching a shared package marks the dependent apps as affected. Without that, `affected` degrades to "this project changed" and the entire monorepo proposition collapses for non-JS surfaces.

So every language plugin is two pieces:

1. **Inference** — `createNodes` points at existing manifests and emits only the targets the project can actually run, without a hand-written `project.json`.
2. **Graph edges** — `createDependencies` parses local manifest/project references and emits validated static dependencies.

Piece 2 is the hard part and the whole moat.

The implementation follows Nx's current [language-support plugin contract](https://nx.dev/docs/kb/add-language-support) for the pinned Nx major.

## Universal target contract

Every ecosystem uses the same names when it supports the capability:

| Target   | Purpose                                                                  |
| -------- | ------------------------------------------------------------------------ |
| `build`  | Produce the artifact                                                     |
| `test`   | Run the ecosystem's test runner                                          |
| `lint`   | Run the ecosystem's linter/formatter check                               |
| `deploy` | Ship it; emitted only when `megamono.json` configures a provider/command |

Uniform names are what make affected commands work across a polyglot repo. A missing capability means a missing target, not a placeholder that fails at runtime. The variation lives **inside** the inferred command:

- Laravel → Forge / Envoyer deploy hook
- Go → container build + registry push
- Swift → Fastlane lane / TestFlight upload
- Tauri → signed bundle + update manifest
- Next.js → Vercel

All targets declare explicit inputs. `build`, archive, package, and deploy targets declare outputs; read-only lint/test targets declare none. Build and test are cached; deploy is never cached. Continuous preview/dev targets set `continuous: true` and are never dependencies of CI targets.

## Database project generator

`@megamono/plugin:database` creates or adopts a named Nx database project independently of the database service that may run it. Its v1 adapters are Prisma and Drizzle. Each adapter owns an explicit compatibility record containing its packages, configuration files, static validation command, and migration-generation command for display only.

The generator records `{ adapter, project }` under the user-supplied logical database name in `megamono.json`. Names are arbitrary normalized slugs; Megamono suggests `primary` but never enumerates database purposes. The same logical name keys the Playstack database target, whose exact schema destination remains authoritative in `playstack.json`. For Prisma, that destination is the complete schema-folder root containing the configured schema entry; Megamono rejects a nested destination that would exclude application-owned schema files from compatibility inspection. A newly written target omits `packages`, enabling Playstack's installed-package artifact discovery; an existing explicit package allowlist is retained unchanged. Fresh adapter projects default to `libs/<adapter>/<name>` with package and Nx identities `<adapter>-<name>` so primary, analytics, events, and other repository-defined contexts own separate schemas, migrations, and generated clients. `--directory`, `--project`, and `--scope` keep that convention optional, while adopted projects retain their established locations and Nx names. Repeating the generator is a no-op when those contracts match and a preflight conflict when a path, project, adapter, or Playstack target disagrees.

The generator exposes static `build` and `validate` targets and may expose an adapter-native `generate` target for generated clients or types. It never exposes an Nx target that implicitly runs a database migration. Migration generation and application remain explicit application-owned ORM commands.

Prisma adoption and relocation are distinct operations. Adoption keeps the established schema, migration, generated-client, CI, and Docker ownership in place. `--relocate` moves the complete schema directory into the named context project only after the dry-run and clean-worktree preflights pass, updates literal command references, and preserves root CLI discovery through `prisma.config.ts`. Existing Prisma and TypeScript versions are retained. `--client-output` is optional because changing where Prisma generates a client can require application import migrations; omission preserves the existing client contract.

### `affected` caveat to pin in docs

Nx computes affected from a **git diff base**. On long-lived branches and squash-merged history this produces surprises — either over-reporting or silently under-reporting.

Do not leave this to each user to discover. Pin the base convention explicitly in the generated CI workflow and document it. (See `spec-megamono-0006`.)

---

## Wave 1 — build first

### `@megamono/nx-apple`

Swift, SwiftUI, Xcode projects, Swift packages.

- `createNodes` discovers `Package.swift`, `.xcodeproj/project.pbxproj`, and `.xcworkspace/contents.xcworkspacedata`.
- Discovery precedence is workspace → project → package within one directory, producing one Nx project rather than three overlapping nodes.
- `swift package dump-package` supplies package metadata. A small parser for the `XCLocalSwiftPackageReference` section of `project.pbxproj` supplies app→local-package edges; workspace file references supply workspace→project edges.
- Swift package inspection uses deterministic temporary cache, configuration, security, and scratch paths outside the repository and bounds subprocess diagnostics. Read-only graph, health, and unrelated generator planning must not write to global SwiftPM caches or flood their primary result with cache-permission output.
- `createDependencies` resolves every local path to the Nx project rooted at that path and validates the edge. This is the prize — touching SynthKit must mark both Synth and Synth Lens affected.
- Targets: `xcodebuild` build/test, SwiftLint, archive + Fastlane deploy.
- Validation surface: eight Apple targets in the portfolio (Synth, Synth Lens, Quickzones Mac + iOS companion, Casters, Portals, Springbar iOS companion, Termvisor iOS).

The plugin accepts `scheme`, `configuration`, `destination`, `derivedDataPath`, and optional Fastlane lane overrides in its `nx.json` plugin options. Mature Apple workspaces may instead define a `targets` map whose repository-chosen target names independently select `build`, `test`, `archive`, or `deploy`, an Xcode project/workspace, scheme, configuration, destination, derived-data path, Fastlane lane, and dependencies. This supports Mac, iOS, direct, App Store, performance, and other repository-defined schemes without Megamono inventing their vocabulary. Invalid mappings are omitted with an `apple-target` diagnostic. If more than one shared scheme can build the project and neither a default scheme nor named mappings are configured, graph creation still succeeds but executable targets are omitted with an actionable diagnostic from `megamono:check`.

**Why first:** hardest, most differentiated, and the only one with a deep dogfooding surface. Prior art is essentially nonexistent for Swift/Xcode in Nx.

### `@megamono/nx-cargo`

Rust and Tauri.

- `createNodes` runs `cargo metadata --format-version 1 --no-deps` once per Cargo workspace and creates one Nx project per workspace package; a virtual workspace root is not a project.
- `createDependencies` maps workspace members and dependencies with a local `path` to static Nx edges, including target-specific and development dependencies.
- Targets: `cargo build/test/clippy`, `tauri build`.
- Prior art from `@monodon/rust` may be reused when license-compatible, but the accepted public contract is this package and the Nx 18–23 API bridge in `spec-megamono-0000`.
- Validation surface: four Tauri surfaces (Springbar, Prismark, Xtension, Promptvisor components).

Cargo target options include `package`, `target`, `features`, `allFeatures`, `noDefaultFeatures`, `profile`, and `targetDir`. Inferred commands always pass `--package` so one Nx task does not accidentally rebuild the whole Cargo workspace.

---

## First-party TypeScript library generators

### `@megamono/plugin:app`

The application generator is the canonical application-structure primitive for both new and existing workspaces:

```text
npm exec nx g @megamono/plugin:app --type=web --name=web --interactive=false --yes
```

V1 supports `web`, `site`, `api`, `worker`, `mobile`, `desktop`, and `apple`. It reads `megamono.json`, derives a conventional name and root when omitted interactively, and composes the maintained ecosystem generator with Megamono-owned post-processing. Web and site use the Pages Router, `src/`, Chakra UI, ESLint, and Playwright. API uses Nest plus a feature library rather than retaining substantive code in the application composition root. Mobile composes Expo and receives `platform:mobile`; Worker, Apple, and desktop delegate to the corresponding Megamono language plugin or scaffold adapter. Every project receives the accepted `platform`, `scope`, `type`, and `visibility` tags.

The generator inventories project names, roots, targets, ports, and required plugins before mutation. An equivalent existing project is a no-op; an occupied name or root with a different contract is a preflight conflict. The default project basename equals the app type, `--name` supports additional instances, and explicit `--directory` and `--port` values must be unique and workspace-safe. Automatic ports use the stable registry in `megamono.json`, so generation order does not change an existing assignment.

Source templates are seeded and repository-owned after creation. Generator reruns validate their project contract but never replace modified application source. Project configuration and explicitly registered managed sections follow the ownership rules in `spec-megamono-0014`. The generator supports the common interactive, non-interactive, confirmation, dry-run, recovery, and idempotency contract from `spec-megamono-0000`.

`create-megamono` installs prerequisites and calls this generator once per selected app. The dedicated CLI exposes the same primitive as `megamono add app <type>`. Packed equivalence fixtures compare project graph metadata, package manifests, lint/test targets, feature-library edges, starter files, and rerun stability across both entry points.

These generators are distinct from language plugins. Nx already understands their source language, so they scaffold an accepted repository shape and its dependency direction rather than repairing project inference.

### `@megamono/plugin:theme`

The theme generator creates one repository-owned token contract and the selected Chakra system compositions:

```text
libs/theme-tokens  # palette, type scale, spacing, and radii values
libs/theme-site    # optional site composition: generous type and wide measure
libs/theme-app     # optional application composition: denser product UI
```

`theme-tokens` is tagged `type:util`, `scope:shared`, and `capability:theme-tokens`, with no platform tag. Each selected system library is tagged `type:ui`, `scope:shared`, and `platform:web`. A system may import `theme-tokens`; the token contract never imports a system, and the two systems never import one another. Each system owns its recipes so a marketing-site decision cannot silently alter application UI.

The generator emits `createSystem` composition through `@playstack/chakra`, project metadata, path aliases, build/test/lint targets, and neutral seed values intended to be replaced by the repository. Playstack owns semantic token names and the composition API; Megamono owns the project layout, tags, aliases, and consumer wiring. The generator is excluded from the published collection until `@playstack/chakra` publishes a Free-tier compatibility contract and fixture under a non-conflicting qualified spec ID.

```text
npm exec nx g @megamono/plugin:theme \
  --systems=site,app \
  --directory=libs \
  --site-project=<optional-project> \
  --app-project=<optional-project> \
  --interactive=true \
  --dry-run
```

At least one value in `--systems=site,app` is required. A named consumer must exist, be a web application, and match the corresponding selected system. In interactive mode, a consumer is inferred only when exactly one eligible project exists; ambiguity exits `4` before mutation in non-interactive mode. Omitting a consumer creates the selected libraries and aliases without rewriting an application.

The small Chakra module emitted by `@megamono/plugin:app` remains valid starter composition. The theme generator replaces its imports only when the caller selects that generated application and the starter artifact remains pristine under `spec-megamono-0014`; a modified or repository-owned starter is preserved and receives an actionable migration diff. The generator never deletes an unowned theme module.

This is an early library generator but not a Wave 1 language-plugin prerequisite. It follows the common generator execution contract in `spec-megamono-0000`, including deterministic planning, idempotency, dry-run parity, and conflict safety.

---

## Wave 2 — after Wave 1 proves the pattern

### `@megamono/nx-laravel`

- Inference from `composer.json`.
- **Graph edges: Composer `path` repositories.** Same shape as SPM, different manifest.
- Generates the shared package properly — path repository wired into every consuming app, PSR-4 autoload configured. This is the fiddly bit people get wrong.
- **Blade component library:** a Composer package with a service provider registering a component namespace, so multiple apps get `<x-yourpkg-button>` without duplication. The service provider registration is exactly the part people fumble; generate it.
- **NativePHP:** a native app needs its own Laravel instance (it bundles a PHP runtime into a desktop/mobile shell — you do not want the public API sharing that binary). The monorepo answer: two Laravel apps plus a shared Composer package holding models, DTOs, validation. Same pattern as SynthKit across Synth and Synth Lens.
- **Inertia:** the one genuine cross-language edge. React/TS pages built by Vite, consumed by a Laravel app — an Nx React library legitimately feeds a Laravel project. Support explicitly. Bonus: one shared React component library can serve an Inertia app and a Next site simultaneously.

**Sequencing note.** Honest self-assessment was "I could see myself potentially using it here and there." That's not enough dogfooding to find the sharp edges, and it's exactly how a plugin ships, gets a few stars, and rots. Build it on the proven Wave 1 foundation, and ship it when someone asks.

**Distribution note.** The strategic case is stronger than the usage case: an existing PHP meetup organizer role and standing in the Laravel/PHP community. Laravel devs take opinionated tooling seriously in a way generic Nx marketing never reaches. Better to show the meetup something real than a demo.

### `@megamono/nx-gradle-plus`

Android and Kotlin use official `@nx/gradle` in v1. `@megamono/nx-gradle-plus` is not reserved or published until a fixture proves a missing graph edge that cannot be contributed upstream.

---

## `@megamono/nx-extension`

Browser extensions as first-class Nx projects, built on **WXT**.

WXT is the accepted framework contract (`playstack:26-extension`): Vite-based, cross-browser manifest generation, and typed WebExtension APIs. Competing frameworks are out of scope for this generator.

### What the generator does

- Scaffolds a WXT project as an Nx app with `build`, `test`, and `lint`; `deploy` appears only when a store configuration exists.
- `build` is an aggregate target depending on `build-chrome` and `build-firefox`, each with distinct outputs.
- `package` depends on `package-chrome`, `package-firefox`, and `package-firefox-source`, producing store-ready archives.
- Leaves product behavior optional; a future compatible `@playstack/extension` capability is added separately through Playstack rather than required by the structural generator.
- CI declares store credential secret names and protected environments; it never writes credential values.

### Why the graph edge matters

An extension usually shares code with the app it supports — types, an API client, validation schemas. Without a real project, touching a shared library does not mark the extension affected, and it ships against a stale contract.

This is the same argument as every other inference plugin in this document: **scaffolding is the visible part, graph edges are the value.**

### Safari is a different shape

Safari extensions require an Xcode wrapper app and App Store distribution. That places them in the Apple wave above, not here — a Safari target means a bundle ID, a signing identity, and App Store Connect.

The generator should emit the Chrome and Firefox targets, and **say plainly that Safari is a separate project** rather than silently producing an incomplete cross-browser story.

### Consumers

OpenGraphs (shipping, 200+ users), Timespans, and Basemarks. Horizens is not a committed v1 consumer.

**Implemented public-validation package.** The plugin discovers hand-authored `wxt.config.*` projects on Nx 18–23 and the generator creates WXT 0.21.4 projects through `megamono add app extension`. WXT 0.21 application generation requires Node 22 or newer even though adoption-time inference remains available on the package's wider Node range. A packed local-registry fixture gates release participation.

## Implemented public-validation package — `@megamono/nx-cloudflare`

Cloudflare Workers remain JavaScript projects, but their service, Durable Object, Workflow, Tail Worker, and Queue relationships live in Wrangler configuration rather than imports. That makes them a graph-repair problem, not merely another JavaScript scaffolder.

`spec-megamono-0015` promoted this package out of the demand-driven list and defines its `createNodes`/`createDependencies` contract, inferred targets, normalized binding metadata, health integration, and deliberately thin generators. The implementation and packed-package fixture now live in this repository, and the package is part of the public `megamono` release group. Actual npm availability remains a release event rather than unfinished generator work.

## Documented, demand-driven

Spec the pattern; the manifest parser generalizes. Each should be a weekend, not a project, once Wave 1 lands.

| Ecosystem          | Manifest / edge source                   | Note                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Go**             | `go.mod` `replace` directives, `go.work` | Multi-module data sits right there. But Go's own tooling is already fast and cache-friendly, so the pain Nx solves is less acute.                                                                                                                              |
| **Rails / Ruby**   | `Gemfile` path gems                      | Parsing is easy and Bundler conventions are stable. Headwind: Rails culture is majestic-monolith-minded, so multi-app-in-one-repo is less of a felt need. No personal distribution in Ruby.                                                                    |
| **Python**         | `pyproject.toml`                         | Fragmented — supporting uv, Poetry, and pip well is a real tax. Want evidence of demand first.                                                                                                                                                                 |
| **Electron**       | `package.json`                           | **Lower priority than it appears.** It's Node all the way down; the graph already works. A generator is scaffolding convenience, not graph repair, and community plugins mostly cover it. Not the house stack (Tauri-first). Ship for completeness eventually. |
| **Infrastructure** | Terraform, Pulumi, Docker Compose        | Underrated. Lives in nearly every large monorepo, currently invisible to the graph, and inferring targets from a Terraform directory is far less work than the Swift plugin.                                                                                   |

## Explicitly out of scope

**A generator per JS framework.** Nx covers that ground. The edge here is specifically non-JS surfaces where the graph is broken.

---

## Cross-language edges: the only three that are real

You do not cross the language boundary — you respect it. A Laravel app cannot consume a TypeScript library. Everything else is wishful thinking.

1. **Same-language packages.** PHP→PHP via Composer path repos. Swift→Swift via SPM. Rust→Rust via Cargo workspace. This is where the bulk of shared code lives.
2. **Generated contracts.** An OpenAPI spec or JSON schema in its own project, with both a Laravel app and a TypeScript client generating from it. Touch the schema, both regenerate, both are affected. This is a real Nx edge.
3. **Built assets.** Vite builds a front-end into a Laravel `public/` directory, making the JS project a build dependency of the PHP app.

## Acceptance criteria

For both `nx-apple` and `nx-cargo`:

- Packed fixtures spanning the declared Nx range install the plugin and show the expected projects and version-appropriate target metadata through `npm exec nx show project --json`.
- Aggregate manifests do not create duplicate projects.
- Local path dependencies produce static graph edges with the declaring manifest as `sourceFile`.
- Editing a shared local dependency marks every direct and transitive consumer affected.
- Malformed manifests identify the path and parser/tool output without crashing the entire graph when other projects remain valid.
- Missing external toolchains produce a preflight diagnostic; they do not cause an opaque module-load failure.
- Renamed target options work, outputs remain non-overlapping, and two identical graph builds serialize byte-for-byte identically.
- One real portfolio project completes every inferred target before the package receives a non-prerelease tag.

For `@megamono/plugin:theme`:

- Fixtures for site-only, app-only, and combined systems generate the exact tag and dependency matrix above and build without a paid package or registry credential.
- A combined fixture proves site and app systems share only `theme-tokens` and never import one another.
- Email-theme discovery finds the generated token project through `capability:theme-tokens` without depending on either web system.
- Re-running is a no-op; dry-run matches execution; ambiguous consumers and modified starter artifacts fail before mutation with recovery guidance.
