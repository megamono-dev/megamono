---
id: "spec-megamono-0019"
type: "spec"
status: "draft"
visibility: "internal"
projects: ["megamono"]
topics: ["architecture", "migration", "lint", "ci"]
summary: "Adoption policy proposal"
date: "2026-11-05"
supersedes: null
references: ["spec-megamono-0006", "spec-megamono-0014"]
external_references: []
---

# 19 — Adoption policy proposal

## Intent

**Draft for separate architecture review.** This proposes conditional follow-up work for exact boundary allowances and identity-based adoption baselines. It authorizes no existing finding, including the fourteen warnings reported by an adopter. Runtime, configuration, schemas, initialization, and count ratchets retain their current behavior until an implementation is separately approved.

The narrow correction for an implicit `role:e2e` project testing an application is independent work. Correctly permitted edges are excluded before any proposed allowance or baseline evaluation.

## Scope

### Current contract and gaps

Version 1 has rule-wide severity overrides and `initialCount` ratchets. Initialization captures counts on first lint adoption. The checker counts warnings in the structural rule set and configured categories; errors fail independently. Resolving one warning can therefore leave room for a different warning under the same count.

`Diagnostic` currently contains only `code`, `message`, and optional `path`. `module-boundaries` covers both scope and type checks. Stable identity requires new structured metadata; parsing message strings would make wording changes alter admission. The ESLint configuration delegates module boundaries to Nx and runs a separate source-level platform rule, so graph-only acceptance cannot establish source-level acceptance.

### Conditional proposal 2: exact constraint allowances

Introduce an opt-in, versioned configuration shape with `conventions.boundaryAllowances`. An illustrative future entry is:

```json
{
  "source": "@example/ui-composition",
  "target": "@example/view-model",
  "constraint": "module-boundaries:type-direction",
  "classification": {
    "dependencyKind": "static",
    "source": { "kind": "lib", "tags": ["scope:shared", "type:ui"] },
    "target": { "kind": "lib", "tags": ["scope:shared", "type:data"] }
  },
  "rationale": "The accepted composition boundary owns this view-model dependency.",
  "decision": "decision-20261105-ui-composition-boundary"
}
```

This is proposed syntax, unsupported by the current version 1 parser. Each entry requires exact, existing Nx project IDs, one eligible stable constraint ID, the canonical classification snapshot defined below, a nonblank rationale, and a valid accepted decision ID. Globs, regular expressions, project-name prefixes, self-edges, unknown fields, and wildcard constraints are invalid. Duplicate `(source, target, constraint)` entries fail even when their rationales or decisions differ.

Initially consider only `module-boundaries:type-direction` and `module-boundaries:scope-direction`. Approving a type exception leaves a scope violation on that same edge enforceable. Graph platform exceptions require a further explicit architecture review; source-level Node built-in/browser-leak checks, Megamono runtime ownership, Playstack direction, tag validity, and policy-validation errors remain outside this allowance mechanism.

Resolve referenced accepted decisions independently of docs presentation, adopted modules, or `--skipDocs`. Missing, proposed, superseded, or archived decisions fail validation. Reviewers must verify that the accepted decision describes the exact edge and constraint being authorized; accepted status alone does not establish that rationale. Report every applied allowance with its rationale and decision; keep it visible to health. An absent edge or a constraint that no longer fails makes an allowance stale and requires reviewed removal. Changed classification requires renewed review rather than silently carrying authorization forward. The allowance pins the dependency kind as well as both project classifications: permission for an `implicit` edge never authorizes a `static` or `dynamic` runtime import.

ESLint and structural checking must share the same constraint evaluation and decision validation. Nx's broad import `allow` patterns cannot implement this contract: they can bypass additional constraints. Where a source-level diagnostic cannot be matched exactly, preserve enforcement and report the unsupported policy capability. Ship the feature only after source/graph parity is qualified.

### Conditional proposal 3: warning identities

For an eligible structural warning, use the canonical tuple:

```text
(rule, constraint, source, target, classification)
```

`rule` and `constraint` are stable catalog IDs. `source` and `target` are exact project IDs; a catalog may explicitly permit `target: null` for a project-only finding. `classification` explicitly records `dependencyKind: "implicit" | "static" | "dynamic"`, derived from the Nx dependency type, as well as source/target project graph kinds and sorted type, scope, platform, and role tags, preserving duplicate tags. Additional runtime classification used by a constraint is included where applicable. An unknown or unresolved dependency kind is ineligible for matching. Messages, line numbers, discovery order, and absolute paths are excluded.

Define and version that catalog before enrollment. Findings without complete supported metadata are ineligible; they must be resolved or receive a separate reviewed design. Begin with graph type/scope warnings and review any expansion separately. Each enrolled identity records a reason, explicit review provenance, and the source revision observed. A shared baseline set may link an optional decision, without making an accepted architecture decision mandatory for each warning. This records reviewed temporary debt; architectural permission requires the separately accepted exact allowance.

Identity-mode admission requires every current eligible warning identity to be present in the reviewed set. A new identity fails even when the total count decreases. Duplicate observations of one identity are deduplicated for admission and remain visible as evidence. Any error fails independently and cannot be enrolled, downgraded, or hidden by a baseline. Resolved identities become stale entries and fail until the same change includes reviewed pruning. Renames or classification changes are removal-plus-addition requiring review, rather than automatic identity updates.

### Migration and initialization

Use an explicitly supported configuration version 2, with matching Zod and published JSON schemas. Version 1 retains its existing semantics. Current clients must continue rejecting unsupported versions with migration guidance. Acceptance of this draft does not itself change either schema.

A future canonical migration generator should dry-run against a recorded revision, display raw findings, proposed exact entries, review provenance, relevant decision references, and the complete configuration diff. Counts cannot be converted losslessly into identities. Migration must require explicit selection, reasons, review provenance, and a recorded revision; allowances additionally require accepted decisions. Reject concurrent count/identity modes for one rule and block unsupported legacy debt rather than inventing identities or dropping it.

Fresh workspaces retain strict defaults and empty baselines. Existing-workspace initialization may produce review candidates, but applying modules, rerunning init, and ordinary checks must never enroll findings, expand an approved set, rewrite classifications, or prune resolved entries. A chosen warning mode with an empty reviewed set therefore fails on remaining debt. Migration and a changed default adoption contract need an explicit compatibility/release decision under spec 0006.

## Failure behavior

| Condition                                                         | Proposed outcome                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Invalid schema, project, constraint, decision, or duplicate entry | Configuration error; apply no partial policy               |
| Allowance matches type, but scope still violates policy           | Scope diagnostic remains                                   |
| Allowance edge disappears, is reclassified, or becomes permitted  | Stale-policy error; reviewed removal or renewed decision   |
| New warning replaces old warning with equal or lower total count  | New-identity error                                         |
| Reviewed warning becomes an error                                 | Original error fails; baseline is inapplicable             |
| Reviewed warning resolves                                         | Stale-baseline error until reviewed pruning                |
| Missing identity metadata or ambiguous source resolution          | Explicit incomplete assessment; no enrollment or exemption |

Machine reports should distinguish raw, allowed, baselined, new, resolved/stale, and erroneous findings, retain identity, review provenance, recorded revision, and any applicable decision evidence, and state policy/identity versions. Human output should show the exact unmatched identity and proposed review action. Health must continue surfacing temporary adoption debt and applied architectural permissions.

## Acceptance criteria

Implementation requires a separate accepted design and tests covering:

- Schema parity, unknown versions/fields, exact project resolution, malformed/duplicate/stale entries, baseline review provenance/revision, and allowance decision lifecycle, including skipped docs presentation.
- Type allowance with a simultaneous forbidden scope edge; neighboring edges remain blocked; source-level browser/Node safety errors remain blocked.
- Graph and ESLint parity for relative and aliased imports and canonical dependency kinds; an implicit-only allowance never permits a static/dynamic import, and unsupported or ambiguous matching stays enforced.
- Equal-count replacement, lower-count new identity, implicit→static/dynamic changes with identical projects/tags, reordered diagnostics, wording/line changes, other classification changes, duplicate observations, and errors presented to a warning baseline.
- Dry-run migration, incomplete old counts, existing-config preservation, repeated initialization without expansion, and explicit reviewed pruning.

Architecture review should first consider correcting inaccurate project roles/tags, extracting platform-neutral contracts, splitting shared UI/data responsibilities, restoring scope ownership, or removing an unintended dependency. Validate runtime and source boundaries independently. Choose an exact allowance only for an intentional accepted architecture; choose a warning identity only for individually reviewed migration debt. The adopter's fourteen warnings require that review before either mechanism could apply.
