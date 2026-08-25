---
id: spec-megamono-0015
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [architecture, dependencies, generators, graph, health, nx]
summary: Defines Wrangler project inference, Cloudflare binding graph edges, targets, metadata, health checks, and generators.
date: 2026-08-25
supersedes: null
references:
  [
    spec-megamono-0000,
    spec-megamono-0001,
    spec-megamono-0002,
    spec-megamono-0003,
    spec-megamono-0006,
    spec-megamono-0007,
    spec-megamono-0008,
    spec-megamono-0012,
  ]
external_references: []
---

# 15 — `@megamono/nx-cloudflare`

Wrangler-aware inference for Nx. Cloudflare bindings are dependency edges the JavaScript import graph cannot see; this plugin puts the local ones in the project graph and preserves the rest as typed metadata.

`@megamono/nx-cloudflare` is a devDependency-only, MIT package in Wave 3. It enters the restricted validation channel defined by `spec-megamono-0000` and is not added to the public release group until its packed-package fixture passes.

## Purpose

A Worker calling another Worker through a service binding has no import statement. The same is true for cross-Worker Durable Objects, Workflows, Tail Workers, and queue producers/consumers. Without plugin inference, Nx cannot propagate `affected` through those relationships.

Inference and graph repair are the product. Scaffolding is deliberately secondary: Cloudflare owns `create-cloudflare` and the Wrangler format, while Megamono owns repository conventions and Nx integration.

## Non-goals

- The package does not orchestrate deployment, releases, rollbacks, tunnels, or processes.
- It does not create or mutate Cloudflare resources such as D1 databases, R2 buckets, KV namespaces, or queues.
- It does not wrap or replace Wrangler. Inferred targets remain overridable in `project.json`.
- It has no production runtime surface and never adds a Megamono package to an application's runtime dependencies.
- Cloudflare Pages and Pages Functions are outside the v1 inference contract. A config containing `pages_build_output_dir` produces an actionable preflight diagnostic and no Cloudflare targets.

## Compatibility and discovery

The package follows the Node, npm, Nx, and TypeScript ranges in `spec-megamono-0000`. Its tested Wrangler range, pinned scaffold version, and pinned scaffold `compatibility_date` live in `@megamono/plugin/compatibility.json`; no generator resolves `latest` or chooses a date from the wall clock.

`createNodes` discovers the standard Wrangler configuration names:

```text
**/wrangler.jsonc
**/wrangler.json
**/wrangler.toml
```

JSONC, JSON, and TOML are first-class. [Cloudflare recommends JSONC for new projects](https://developers.cloudflare.com/workers/wrangler/configuration/), but existing TOML projects retain equal inference support. Generated deployment redirects under `.wrangler/deploy/config.json` are outputs, not source project identities, and are ignored.

One directory produces at most one Nx project. If more than one standard config exists in that directory, graph construction succeeds but executable targets and dependency edges are omitted until the plugin option `configPath` selects one. The diagnostic is emitted through `metadata['megamono:preflight']` and therefore appears in `megamono:check`.

Unknown configuration keys are preserved in raw parsing and ignored by inference. A malformed config, an unsupported Pages config, or a future shape the parser cannot interpret never fails the whole Nx graph; it produces no inferred Cloudflare edges for that project and emits an actionable preflight diagnostic.

The Wrangler `name` is the Worker binding identity. The Nx project name continues to come from repository/project conventions. These namespaces are separate. Duplicate top-level Worker names omit ambiguous edges and produce a preflight error rather than choosing a project by path order.

The package exports the Nx 23 APIs under the names required by `spec-megamono-0000`:

- `createNodes` discovers projects, targets, and metadata.
- `createDependencies` resolves local binding references and emits validated static edges.
- `createNodesV2` is not exported.

## Binding and edge model

Only a reference that resolves to another inferred Worker project in the same workspace produces an Nx edge. Cloudflare infrastructure and external Workers are metadata, because inventing graph nodes that Nx cannot build corrupts `affected`.

`createDependencies` builds one top-level `wrangler.name` to Nx project map, then applies these rules:

| Binding source                               | Dependency direction                                            |
| -------------------------------------------- | --------------------------------------------------------------- |
| `services[].service`                         | caller Worker → locally resolved service Worker                 |
| `durable_objects.bindings[].script_name`     | binding Worker → locally resolved defining Worker               |
| `workflows[].script_name`                    | binding Worker → locally resolved defining Worker               |
| `tail_consumers[].service`                   | source Worker → locally resolved Tail Worker                    |
| matching `queues.consumers[].queue`/producer | each consumer Worker → every local producer for that queue name |

A Durable Object without `script_name` and a Workflow without `script_name` are local and produce no edge. Queue fan-in is intentional: a consumer depends on every local producer because producer contract changes must affect all consumers. Dead-letter queue names and dispatch namespaces remain metadata-only in v1.

Plugin option `externalWorkers` is the explicit allowlist for service/script names expected to live outside the repository. An unresolved name on that list is recorded as external metadata. Any other unresolved direct Worker reference produces a warning-level preflight diagnostic and a health finding; it never produces a fabricated dependency.

Named `env.*` blocks do not contribute graph edges. The development graph must be single-valued, and environment-only relationships would make `affected` depend on an unselected deployment environment. Environment differences remain metadata and health input.

## Normalized project metadata

Each successfully parsed project emits `metadata['megamono:cloudflare']` with a versioned, Megamono-owned shape:

- source config path, Worker name, `main`, compatibility date, and compatibility flags;
- resolved local Worker references and their Nx project names;
- unresolved and explicitly external Worker references;
- resource bindings grouped by Wrangler key, including binding/resource names and `remote`/experimental flags when present;
- queue producer and consumer names;
- named environments and their binding differences;
- routes, `workers_dev`, and explicit local development port as uninterpreted Cloudflare facts.

Resource metadata covers the Wrangler binding families supported by the pinned schema, including KV, R2, D1, Hyperdrive, Queues, Vectorize, Workers AI, AI Search, Workflows, Analytics Engine, Browser Rendering, Images, mTLS, dispatch namespaces, and assets. Unknown binding families are retained only in raw config diagnostics until the compatibility registry and fixture are updated.

This is not `metadata.springbar`. Megamono does not define Springbar commands, hostnames, ports, resource substitutes, or configuration. Springbar may teach its own Wrangler adapter to consume the Nx graph and this vendor metadata, but the only Megamono-owned Springbar configuration flow remains the optional post-bootstrap MCP handoff in `spec-megamono-0002` and `spec-megamono-0007`.

## Inferred targets

The plugin infers four overridable targets:

| Target    | Command           | Cache | Contract                                                                         |
| --------- | ----------------- | ----- | -------------------------------------------------------------------------------- |
| `dev`     | `wrangler dev`    | no    | Long-running and `continuous: true`                                              |
| `deploy`  | `wrangler deploy` | no    | Side-effecting; never cached and never run by a generator                        |
| `typegen` | `wrangler types`  | yes   | Writes `worker-configuration.d.ts` by default, or the configured `typegenOutput` |
| `tail`    | `wrangler tail`   | no    | Long-running and `continuous: true`                                              |

Every command receives the discovered `--config` path. `build` is not inferred: [modern Wrangler bundles during development/deployment and has no standalone build command](https://developers.cloudflare.com/workers/wrangler/deprecations/). A repository-owned `project.json` target with the same name wins over inference.

All targets declare the Wrangler config and normal project inputs. `typegen` additionally declares its exact output and every local bound Worker config passed to Wrangler for service/RPC type generation. Because the entire config file is an input, changes to `compatibility_date`, compatibility flags, `main`, bindings, or environments invalidate the cached output without redundant pseudo-inputs.

Wrangler named environments become Nx target configurations, invoked as `<project>:deploy:<environment>` and equivalent configurations on other supported targets. They are not separate targets or graph variants. Each configuration passes `--env=<name>` and retains the same cache/side-effect contract as its base target.

## Generators

Generators obey the planning, dry-run, conflict, external-command, and recovery rules in `spec-megamono-0000`.

- `worker` adds repository conventions around a Worker scaffold: `wrangler.jsonc`, the pinned compatibility date, `main`, `platform:worker` and `scope:` tags, plugin registration, TypeScript configuration, and the generated type target. It refuses a Pages selection and does not duplicate framework templates maintained by `create-cloudflare`.
- `binding` adds a supported binding to an existing Worker config, validates the complete config, then runs `wrangler types` as the last external step. It never hand-edits generated declarations.
- `durable-object` adds the class, binding, and required migration entry as one planned mutation, then runs type generation last.

Generated dependency versions come only from `compatibility.json`. Defaults do not require a private or paid runtime package. If a future option emits a Playstack package, it must first appear in the emission registry and pass the external fixture gate in `spec-megamono-0007`.

## Deterministic checks and health

Fast structural failures use `metadata['megamono:preflight']` and `megamono:check`; graph construction itself stays available. The scheduled health workflow remains the single deterministic issue channel from `spec-megamono-0008` and reads normalized Cloudflare metadata without contacting Cloudflare.

The Cloudflare checks are:

1. duplicate or unresolved local Worker identities;
2. compatibility-date drift against the pinned recommendation and the newest Worker in the repository;
3. effective Node compatibility divergence between tests and production, accounting for explicit positive/negative flags and [Cloudflare's date-based defaults](https://developers.cloudflare.com/changelog/post/2026-08-04-nodejs-compat-default/) (`2026-08-04` for the initial supported range);
4. bindings present only in named environments, reported as review candidates rather than graph edges;
5. installed Wrangler outside the package's tested compatibility range;
6. config binding shapes newer than the pinned parser/schema support.

No check calls the Cloudflare API, validates live resource IDs, or proposes a mutation. Findings use the existing alignable/constrained/intentional resolution model.

## Delivery order and acceptance

Implementation proceeds in independently useful slices:

1. permissive JSONC/JSON/TOML parsing and compatibility data;
2. `createNodes` project detection, metadata, and inferred targets;
3. `createDependencies` local direct-binding and queue-edge resolution;
4. deterministic preflight and scheduled-health integration;
5. generators, after inference has been exercised against a real Worker repository.

The package is build-ready when:

- mixed-format fixtures prove discovery, collision handling, malformed-config degradation, and environment metadata;
- paired Workers prove every direct edge type, queue fan-in, no local self-edge, and no edge for external/resource bindings;
- an affected fixture proves changing a dependency marks its Worker consumers affected;
- target snapshots prove cache, continuous, input, output, override, and environment-configuration behavior;
- current and out-of-range Wrangler fixtures prove the compatibility gate and type generation;
- a packed local-registry fixture installs the published tarball into a clean Node 24/npm 11/Nx 23 workspace and repeats graph, target, generator, and affected checks;
- Springbar is absent from the package manifest and generated files, while normalized vendor metadata remains available to any graph consumer.

## Cross-references

- `spec-megamono-0000` — compatibility baseline, package map, Nx API names, and generator execution contract
- `spec-megamono-0001` — graph inference as Megamono's core positioning
- `spec-megamono-0003` — language-plugin target contract and wave sequencing
- `spec-megamono-0006` — `platform:worker` boundaries
- `spec-megamono-0007` — Playstack and Springbar ownership boundaries
- `spec-megamono-0008` — deterministic health findings and issue lifecycle
- `spec-megamono-0012` — third-party template ownership and drift discipline
