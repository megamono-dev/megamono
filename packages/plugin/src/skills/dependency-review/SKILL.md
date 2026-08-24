---
name: dependency-review
description: Review a proposed dependency addition or version alignment across the full project graph and ecosystem constraints before mutation.
---

# Dependency Review

Use this skill when dependency direction, compatibility, or graph-wide alignment needs judgement.

Identify every consumer through the Nx graph and manifests, then compare npm, Expo, SwiftPM, Cargo, and other configured ecosystem constraints. Distinguish an alignable version from a genuinely constrained split, and check platform and Megamono/Playstack direction rules.

Report the compatible range, affected projects, blockers, and relevant accepted decisions. Do not install, update, remove, or narrow dependencies unless the user separately authorizes that change. Never select a version merely because it is newer.

For routing examples, read [references/triggers.md](references/triggers.md).
