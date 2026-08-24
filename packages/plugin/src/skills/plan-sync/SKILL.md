---
name: plan-sync
description: Synchronize an explicitly identified active implementation plan with completed work, changed sequencing, blockers, and remaining steps.
---

# Plan Sync

Use this skill only when the user asks to update or reconcile an active plan.

Locate the plan through `docs/INDEX.md`, then compare it with the current implementation, tests, and relevant decisions. Update factual progress, ordering, blockers, and next steps without rewriting the plan's original intent. Preserve stable IDs and references.

Only non-terminal plans may be edited directly. Do not mark a plan completed or aborted, move it to archives, or invent a branch state. Terminal transitions belong to `megamono-docs:archive` and require explicit user direction.

For routing examples, read [references/triggers.md](references/triggers.md).
