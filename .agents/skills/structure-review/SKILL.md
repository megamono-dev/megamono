---
name: structure-review
description: Review proposed repository structure, project boundaries, tags, and dependency direction before a cross-project or architectural change.
---

# Structure Review

Use this skill when a change may reshape projects or dependency boundaries.

Read `AGENTS.md`, `docs/INDEX.md`, relevant accepted specs and decisions, `megamono.json`, and the resolved Nx project graph. Check whether the proposal preserves project ownership, type/scope/platform tags, dependency direction, affected propagation, and existing generator conventions.

Report concrete risks and a recommended shape with supporting paths or graph edges. Do not create projects, rewrite architecture documents, or approve a boundary exception unless the user also requests that mutation. Direct lasting exceptions through a decision record.

For routing examples, read [references/triggers.md](references/triggers.md).
