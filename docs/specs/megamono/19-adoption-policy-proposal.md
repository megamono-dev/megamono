---
id: 'spec-megamono-0019'
type: 'spec'
status: 'accepted'
visibility: 'internal'
projects: ['megamono']
topics: ['architecture', 'migration', 'lint', 'ci']
summary: 'Defines explicit v2 boundary allowances, reviewed warning identities, and the report/apply migration workflow.'
date: '2026-11-05'
supersedes: null
references: ['spec-megamono-0006', 'spec-megamono-0014']
external_references: []
---

# 19 — Reviewed adoption policy

## Intent

Configuration version 2 explicitly enables exact boundary allowances and reviewed warning identities. Version 1 and new-workspace defaults retain their existing behavior. The migration workflow never authorizes an adopter's existing findings merely because they were discovered.

This contract separates architectural permission from temporary warning debt. Accepted decisions authorize exact allowances; baseline entries record a reason, review reference, and observed source revision. The independent implicit e2e scheduling correction is applied before policy evaluation.

## Exact boundary allowances

Only two named constraints are eligible:

- `module-boundaries:type-direction`
- `module-boundaries:scope-direction`

An allowance in `conventions.boundaryAllowances` requires exact existing project IDs, one named constraint, the complete classification snapshot, a nonblank rationale, and an accepted decision ID. For example:

```json
{
  "source": "@example/ui-composition",
  "target": "@example/view-model",
  "constraint": "module-boundaries:type-direction",
  "classification": {
    "dependencyKind": "static",
    "source": {
      "kind": "lib",
      "tags": ["platform:web", "scope:shared", "type:ui"]
    },
    "target": {
      "kind": "lib",
      "tags": ["platform:web", "scope:shared", "type:data"]
    }
  },
  "rationale": "The accepted composition boundary owns this dependency.",
  "decision": "decision-20261105-ui-composition-boundary"
}
```

The example grants no real repository permission. Globs, prefixes, self-edges, unknown constraints/fields, and duplicate source/target/constraint entries are invalid. A type allowance leaves a scope violation on the same edge enforceable. Node built-ins, browser leaks, platform boundaries, tag validity, runtime package ownership, and Playstack direction remain outside this mechanism.

Decision authority is resolved independently of optional docs presentation and `--skipDocs`. Missing, malformed, proposed, archived, duplicated, or superseded decisions cannot authorize an allowance. Reviewers verify that the accepted decision actually covers the selected edge and constraint. An absent edge, changed classification, or no-longer-violated constraint produces an invalid/stale policy error requiring review.

Source ESLint uses the canonical `megamonoPlugin.withBoundaryAllowances(megamonoConfig, [...])` export wrapper. It preserves/delegates the installed Nx rule's configured options and other constraints. An implicit-only permission cannot authorize static or dynamic imports. Unsupported configuration shapes fail migration rather than receiving a broad import allowlist.

## Warning identities

A version 2 `adoption.warningBaseline` has `identityVersion: 1`, explicit `rules: ["module-boundaries"]`, and reviewed `entries`. Every entry contains:

| Field             | Contract                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `identity`        | Exact `rule`, named `constraint`, `source`, `target`, and `classification` from the report |
| `reason`          | Nonblank explanation of the temporary debt                                                 |
| `reviewReference` | Explicit review provenance                                                                 |
| `revision`        | Recorded 40- or 64-character Git commit ID                                                 |

Classification includes dependency kind (`implicit`, `static`, or `dynamic`), both project graph kinds, and sorted type/scope/platform/role tags with duplicates preserved. Identity excludes wording, line numbers, absolute paths, and discovery order. A changed dependency kind creates a new identity even when projects and tags are unchanged.

Only effective warnings with complete supported identities can consume the reviewed set. Errors remain errors and cannot consume warning entries. New, unsupported, duplicate, or ambiguous identities fail; resolving an entry requires reviewed pruning. A lower total count does not permit a replacement identity. An allowance removing an otherwise baselined warning also requires explicit pruning of the baseline.

These policies activate their module-boundary checks even when the lint adoption module is absent. This does not adopt other modules or relax source checks. Baselines preserve warning diagnostics; they do not suppress repository-owned ESLint warnings or override a caller's warning ceiling.

## Canonical report and migration workflow

`@megamono/plugin:adoption-policy` reports JSON by default. It discovers supported identities and preserves error severity. Report fields are `rawFindings`, `allowed`, `baselined`, `new`, `resolved`, and `errors`; `new[].reason` distinguishes unreviewed, unsupported-identity, and duplicate-identity findings. Candidates include `baselineEligible`; discovery does not create policy entries, reasons, decisions, or review provenance.

```sh
npm exec nx -- generate @megamono/plugin:adoption-policy --report=tmp/adoption-policy.json
npm exec nx -- generate @megamono/plugin:adoption-policy --policyFile=.megamono/reviewed-policy.json --dry-run
npm exec nx -- generate @megamono/plugin:adoption-policy --policyFile=.megamono/reviewed-policy.json --apply
```

The reviewed file is a strict JSON envelope:

```json
{
  "schemaVersion": 1,
  "replaceLegacyRatchets": true,
  "boundaryAllowances": [],
  "warningBaseline": {
    "identityVersion": 1,
    "rules": ["module-boundaries"],
    "entries": []
  }
}
```

An empty reviewed set succeeds only when no applicable warnings remain. For real debt, copy individually reviewed identities into entries and supply their provenance fields. Counts cannot be converted losslessly. Migrating a v1 configuration with count ratchets requires explicit `replaceLegacyRatchets: true`; remaining unsupported/unreviewed debt still blocks migration. Omitting a policy field preserves its existing value; supplying it explicitly replaces that field, allowing reviewed pruning.

The generator preserves rule severities, module adoption, and unrelated configuration. Apply validates the entire proposed configuration, current graph/classifications, decision authority, baseline matches, and review revisions before staging changes. Recorded review revisions must be verifiable ancestors of the workspace HEAD. Apply requires the normal clean feature-branch Git preflight; commit the reviewed file and account for generated report files before applying.

Active policy requires canonical ESLint imports and a real `createConfig(megamonoConfig)` array entry. Migration wraps that array once; arbitrary factories, modified imports, and unsupported exports fail before configuration writes. Architectural allowances also require an active module-boundary rule. Default report mode changes no configuration. Only an explicit report path writes a report, and existing unrelated files cannot be overwritten. Dry-run writes nothing, including report output. Invalid reviewed files or blocked candidates fail without partial policy writes.

## Initialization and reporting

Repeated version 2 initialization preserves allowances, identity entries, review provenance, severities, and all existing ratchets, including nonstructural categories. It never captures new counts, expands an identity set, or prunes resolved debt. Fresh workspaces remain version 1 with their existing strict defaults.

Check reports and health retain the exact identity, dependency kind, rationale/provenance, and policy status. Temporary baselines remain visible as debt; architectural allowances remain visible as permissions. Health remains advisory and reports unavailable coverage rather than implying that skipped checks passed.

## Verification and architecture review

Regression coverage includes schema parity, unknown versions, exact decision lifecycle, stale/duplicate entries, implicit-to-static/dynamic changes, equal/lower-count replacements, errors presented to baselines, unsupported source activation, source/graph constraint parity, dry-run, normal Git preflight, no partial writes, and repeated-init preservation. Local qualification includes the full plugin suite and a clean packed pnpm consumer: fresh install, frozen reinstall with an unchanged lock, a build against public types, packaged generator/schema/ESLint APIs, exact allowance/staleness, and equal-count warning replacement. This is local qualification, rather than evidence about an adopter's deployment or Linux CI.

Before accepting permission or debt, review project roles/tags, platform-neutral contract extraction, UI/data separation, scope ownership, and unintended dependencies. Source/runtime boundaries need their own evidence. No warnings from the adopter feedback are enrolled by this implementation.
