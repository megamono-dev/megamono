# Megamono v1 — portable overview

Megamono is an MIT-licensed set of Nx development tools for creating, maintaining, converting, and consolidating polyglot monorepos. Its differentiators are non-JavaScript graph edges, a documentation corpus designed for agent retrieval, and safe consolidation of existing repositories.

> Megamono shapes the repository. Runtime libraries shape the product.

## Scaffold baseline and adoption compatibility

- New workspaces use Node.js 24, Nx 23.1, and TypeScript 6.0. npm is the default; pnpm, Yarn, and Bun are supported compatibility options.
- Existing workspaces retain their package manager and supported toolchain: core adoption accepts Nx 17–23, TypeScript 5.2–6, and Node.js 18.18–24. Inference plugins require Nx 18 or newer. Exact ranges are defined in the implementation contract and packaged compatibility registry.
- Bootstrap supports macOS and Linux. Platform-neutral adoption also supports Windows; native capability requirements are checked separately.
- Eight packages: `@megamono/plugin`, `@megamono/cli`, `create-megamono`, and the Apple, Cargo, Cloudflare, extension, and Render Nx plugins. Unimplemented roadmap plugins are not implied to be available.
- `create-megamono` bootstraps new workspaces. `megamono adopt` surveys established Nx workspaces before an explicitly requested write; `megamono init` and `megamono add` expose the same additive primitives. A missing survey plugin can be staged temporarily without adding a consumer dependency. Mutation requires the local plugin.
- Inference plugins adapt to the supported Nx callback contracts; API compatibility is verified at the declared version anchors.
- Generators plan before writing, support dry-run and non-interactive execution, are idempotent, never persist secrets, and never commit, push, deploy, or run database migrations.

History import is deliberately an executor rather than a generator because it must create local Git commits. It requires explicit execution and history-strategy flags, never pushes, and treats the source repository as read-only.

## Repository contract

Repository documents are centralized under `docs/` and use stable IDs. Specs are durable intent; plans move to archives on terminal status; decisions and research are append-oriented; audits judge against a standard; reports are explicit retained outputs. Internal references resolve across hot and archived records. External contracts use qualified IDs such as `playstack:12-observability`.

`AGENTS.md` is the instruction source. Portable Agent Skills live once under `.agents/skills`; Claude Code receives a symlink at `.claude/skills`. Skills report or propose and are invoked explicitly. V1 CI and scheduled health workflows are deterministic and require no model provider or AI credential.

Megamono classifies emitted repository-governance artifacts as managed, managed sections, seeded, or derived and records their lifecycle in `.megamono/artifacts.json`. Pristine managed artifacts may upgrade; modified artifacts are preserved until explicitly ejected with `workspace-eject`; seeded content is repository-owned immediately; derived output is regenerated. Playstack package artifacts remain exclusively in the `@playstack/cli` ownership domain.

Structural rules are split by capability: ESLint handles source imports, `megamono:check` handles repository and graph structure, and `megamono-docs:validate` handles the Markdown corpus. The generated weekly health workflow updates one GitHub issue and never opens dependency PRs.

## Package and feature boundary

`@megamono/plugin` owns workspace, docs, skills, conventions, health, conversion, integration, Playstack-wiring, content, and email machinery. Those are internal modules, not separately versioned packages. Language graph plugins remain separate because their toolchains and release cadence are independent.

Megamono can emit a Playstack runtime import, but no `@megamono/*` package has a runtime dependency on Playstack. `org-playstack/playstack-pro` initially owns the qualified `playstack:` contract namespace. A generator remains reserved and unpublished until the referenced package supplies install, compatibility, configuration, tier, schema-fragment, and fixture artifacts; Megamono never requires a sibling checkout of the Playstack repository.

Playstack owns integration manifests and templates. Megamono validates the complete manifest schema, maps selected surfaces to existing Nx projects, verifies template hashes, and checks static Nest routes before ejecting application-owned wiring. Dynamic routes require manual review; the planner is not a substitute for application integration tests. Migration phase selections record intent, not an automatically implemented shadow-write or cutover mechanism.

Public release channels are `next` and `latest`. Versioning synchronizes internal scaffold pins before committing and tagging. Stable promotion requires a clean checkout whose source tree matches every package's registry-reported `next` revision; a changed source tree must go through another prerelease.

## Deliberate public-package v1 exclusions

- Hosted-service implementation, organization-wide analysis, or automatic merge.
  A separately operated GitHub App may invoke the same released local contracts
  and deliver explicitly approved draft pull requests; it owns no additional
  repository-shaping capability.
- Automatic model invocation from hooks, CI, or schedules.
- Monorepo-into-monorepo imports.
- Gradle reimplementation where the official Nx plugin suffices.
- Provider-template publishing for email; v1 email rendering is send-time and gated on the external mail contract.
- Any Playstack generator whose referenced fixture contract is unavailable.

## Implementation order

Build the core configuration/docs/checking foundation first; then bootstrap and Wave 1 language graph plugins; then explicit skills and deterministic health; then workspace-init adoption fixtures and convert/import with real Git histories. Conditional runtime-wiring generators come last, after their external gates pass.

The normative source is [00 — Megamono v1 Implementation Contract](megamono/00-implementation-contract.md); the full suite index is [README.md](README.md).
