---
name: drift-check
description: Compare implemented repository behavior with accepted specifications and decisions, then report concrete contract drift without editing intent documents.
---

# Drift Check

Use this skill for an explicit implementation-versus-contract review.

Read the relevant accepted specs and decisions, inspect resolved Nx projects and graph edges, and run the narrowest applicable deterministic checks such as docs validation, `megamono:check`, or repository health. Distinguish implementation drift, stale documentation, and intentionally deferred work.

Report evidence by document ID, file, target, or graph edge. Do not silently edit specs or decisions, and do not treat draft or retired intent as an active contract. Recommend a decision when implementation and accepted intent genuinely need reconciliation.

For routing examples, read [references/triggers.md](references/triggers.md).
