# Megamono v1 — portable overview

Megamono is an MIT-licensed set of Nx development tools for creating, maintaining, converting, and consolidating polyglot monorepos. Its differentiators are non-JavaScript graph edges, a documentation corpus designed for agent retrieval, and safe consolidation of existing repositories.

> Megamono shapes the repository. Runtime libraries shape the product.

## Fixed v1 baseline

- Node.js 24, npm 11 workspaces, Nx 23.1, and TypeScript 6.0.
- macOS and Linux. Windows and non-npm package managers fail preflight in v1.
- One core `@megamono/plugin`, plus Wave 1 Apple/Cargo and Wave 2 extension/Laravel plugins.
- `create-megamono` is the only bootstrap binary. Existing Nx workspaces use generators and executors.
- Nx plugins export `createNodes` and `createDependencies`; the deprecated `createNodesV2` alias is not used.
- Generators plan before writing, support dry-run and non-interactive execution, are idempotent, never persist secrets, and never commit, push, deploy, or run database migrations.

History import is deliberately an executor rather than a generator because it must create local Git commits. It requires explicit execution and history-strategy flags, never pushes, and treats the source repository as read-only.

## Repository contract

Repository documents are centralized under `docs/` and use stable IDs. Specs are durable intent; plans move to archives on terminal status; decisions and research are append-oriented; audits judge against a standard; reports are explicit retained outputs. Internal references resolve across hot and archived records. External contracts use qualified IDs such as `playstack:12-observability`.

`AGENTS.md` is the instruction source. Portable Agent Skills live once under `.agents/skills`; Claude Code receives a symlink at `.claude/skills`. Skills report or propose and are invoked explicitly. V1 CI and scheduled health workflows are deterministic and require no model provider or AI credential.

Structural rules are split by capability: ESLint handles source imports, `megamono:check` handles repository and graph structure, and `megamono-docs:validate` handles the Markdown corpus. The generated weekly health workflow updates one GitHub issue and never opens dependency PRs.

## Package and feature boundary

`@megamono/plugin` owns workspace, docs, skills, conventions, health, conversion, integration, Playstack-wiring, content, and email machinery. Those are internal modules, not separately versioned packages. Language graph plugins remain separate because their toolchains and release cadence are independent.

Megamono can emit a Playstack runtime import, but no `@megamono/*` package has a runtime dependency on Playstack. `org-playstack/playstack-pro` initially owns the qualified `playstack:` contract namespace. A generator remains reserved and unpublished until the referenced package supplies install, compatibility, configuration, tier, schema-fragment, and fixture artifacts; Megamono never requires a sibling checkout of the Playstack repository.

## Deliberate v1 exclusions

- Hosted GitHub App, organization-wide analysis, or automatic PR creation.
- Automatic model invocation from hooks, CI, or schedules.
- Monorepo-into-monorepo imports.
- Gradle reimplementation where the official Nx plugin suffices.
- Provider-template publishing for email; v1 email rendering is send-time and gated on the external mail contract.
- Any Playstack generator whose referenced fixture contract is unavailable.

## Implementation order

Build the core configuration/docs/checking foundation first; then bootstrap and Wave 1 language graph plugins; then explicit skills and deterministic health; then convert/import with real Git histories. Conditional runtime-wiring generators come last, after their external gates pass.

The normative source is [00 — Megamono v1 Implementation Contract](megamono/00-implementation-contract.md); the full suite index is [README.md](README.md).
