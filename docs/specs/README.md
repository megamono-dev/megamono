# Megamono specification suite

Accepted implementation contracts for Megamono v1. Start with the normative implementation contract, then read the feature spec you are building and every ID in its `references` field.

The suite is centralized under `docs/specs/megamono/`. Cross-document links inside corpus records use stable IDs, not paths. Markdown links here are navigation only.

## Suite

| ID                   | Spec                                                                      | V1 outcome                                                                    |
| -------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `spec-megamono-0000` | [Implementation contract](megamono/00-implementation-contract.md)         | Compatibility baseline, package map, commands, safety, and definition of done |
| `spec-megamono-0001` | [Philosophy and positioning](megamono/01-philosophy.md)                   | Product boundary, Nx dependency, and commercial constraints                   |
| `spec-megamono-0002` | [`create-megamono`](megamono/02-create-megamono.md)                       | Transactional npm-only workspace bootstrap                                    |
| `spec-megamono-0003` | [Generator roadmap](megamono/03-generator-roadmap.md)                     | Wave 1 Apple/Cargo and Wave 2 extension/Laravel contracts                     |
| `spec-megamono-0004` | [Docs convention](megamono/04-docs-convention.md)                         | Corpus taxonomy, metadata, lifecycle, visibility, and retrieval               |
| `spec-megamono-0005` | [Agent skills](megamono/05-agent-skills.md)                               | Portable skills and explicit invocation boundaries                            |
| `spec-megamono-0006` | [Conventions, lint, CI, and release](megamono/06-conventions-and-lint.md) | Tags, dependency rules, structural checks, and CI                             |
| `spec-megamono-0007` | [Playstack boundary](megamono/07-playstack-boundary.md)                   | Repo-shaping/product-shaping rule and gated runtime emissions                 |
| `spec-megamono-0008` | [Scheduled repo health](megamono/08-scheduled-workflows.md)               | Deterministic checks, suppressions, and one updating issue                    |
| `spec-megamono-0009` | [Convert](megamono/09-convert.md)                                         | Existing Nx-initialized npm repo to Megamono structure                        |
| `spec-megamono-0010` | [Import](megamono/10-import.md)                                           | Local, history-preserving single-repo absorption                              |
| `spec-megamono-0011` | [Docs tooling](megamono/11-docs-tooling.md)                               | Typed graph, indexes, generators, archive, and retention                      |
| `spec-megamono-0012` | [Integration generators](megamono/12-integration-generators.md)           | Wave 1 Sentry generator and template-drift checks                             |
| `spec-megamono-0013` | [Email generator](megamono/13-emails.md)                                  | Gated typed email library and local preview                                   |
| `spec-megamono-0014` | [Workspace init](megamono/14-init.md)                                     | Additive, modular adoption in an existing Nx workspace                        |

## Normative boundary

Megamono shapes the repository and remains a development dependency. Playstack shapes the product and may be emitted as a runtime dependency. The dependency direction is one-way: Megamono may generate code that imports Playstack; Playstack must not depend on Megamono.

Playstack records referenced as `playstack:<id>` are owned by `org-playstack/playstack-pro`, not missing local files. Megamono does not depend on that repository being checked out beside it. A generator that relies on a Playstack record is excluded from the published generator collection until the external package provides the fixture and compatibility contract required by `spec-megamono-0000`.

## Build sequence

1. Build the `@megamono/plugin` configuration, docs, structural-check, and executor foundation from specs 0000, 0004, 0006, and 0011.
2. Build `create-megamono` and the Wave 1 language plugins from specs 0002 and 0003.
3. Build explicit skills and deterministic health checks from specs 0005 and 0008.
4. Build workspace init, convert, and import from specs 0014, 0009, and 0010, using adoption and real-history fixtures before release.
5. Publish integration, Playstack-wiring, and email generators only as their external contract gates pass.

The portable high-level summary is [OVERVIEW.md](OVERVIEW.md). The generated hot-corpus index is [docs/INDEX.md](../INDEX.md).
