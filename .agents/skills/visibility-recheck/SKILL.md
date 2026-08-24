---
name: visibility-recheck
description: Reassess public repository documents after content changes for internal detail, stale review timestamps, secrets, and publication-boundary violations.
---

# Visibility Recheck

Use this skill for an explicit review of documents marked public or proposed for publication.

Compare content changes with `visibility_reviewed_at`, inspect references and examples for internal-only context, secret material, private infrastructure, or dead internal links, and verify that public-facing consumers use the public collection entry point. Report findings with paths and the minimum corrective action.

Do not publish a document, change visibility, redact evidence, or advance the review timestamp without user approval. A timestamp records a completed human review; it is not an automatic formatting update.

For routing examples, read [references/triggers.md](references/triggers.md).
