---
id: spec-megamono-0008
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [health, ci, dependencies, docs]
summary: Defines deterministic repository health checks, agent-review candidates, suppression records, cadence, and issue output.
date: 2026-08-23
supersedes: null
references:
  [
    spec-megamono-0000,
    spec-megamono-0001,
    spec-megamono-0004,
    spec-megamono-0005,
    spec-megamono-0012,
  ]
external_references: [playstack:45-cli]
---

# 08 — Scheduled Workflows: Repo Health

## Premise

The skills in `spec-megamono-0005` fire on events — branch created, PR opened, PR merged. They answer _"is this change consistent with the repo?"_

That leaves a whole class of problems unaddressed, because they are not caused by any single change. Dependency skew, spec drift, stale plans, and orphaned libraries all accumulate quietly between changes. No PR introduces them. No hook catches them.

Scheduled workflows cover that gap. They run on a cadence rather than an event, and they ask _"is the repo still in good shape?"_

## The motivating failure: dependency alignment

The clearest case, and the one that justifies the whole document.

Dependabot and Renovate are **context-free**. They see a package and a newer version of that package. What they do not see:

- Expo pins React to a specific version per SDK release.
- React Native surfaces are constrained by the Expo SDK, not by npm's latest.
- A shared library consumed by both web and mobile cannot move React independently.
- Bumping React to satisfy the web app breaks the mobile app, and the bot has no way to know that.

The result is a stream of PRs that are **individually correct and collectively wrong**. Each one passes its own check. Applied together they produce a workspace that no longer builds. The maintainer's job becomes triage — and after a few weeks of triage, the bot gets muted, which is worse than not having it.

Megamono has the one thing the bots lack: **the graph.** Before proposing any dependency change it can answer:

1. Which projects consume this package, directly and transitively?
2. What constrains each of them — an Expo SDK, a Swift toolchain, a PHP version, a peer dependency range?
3. Is there a single version that satisfies every consumer?

If yes, propose it. If no, say so explicitly and name the conflict, rather than proposing a change that cannot land.

> **A suggestion that cannot be applied is worse than no suggestion.** It costs attention and teaches the maintainer to ignore the channel.

## Checks

Five checks in the first cut. Each is independently valuable and independently disable-able.

### 1. Dependency alignment

Detects the same package resolved at different versions across the workspace, and evaluates whether alignment is actually possible.

Output has three states, and the distinction matters more than the detection:

| State           | Meaning                                                                 | Action                                                    |
| --------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| **Alignable**   | One version satisfies all consumers                                     | Propose the version                                       |
| **Constrained** | No single version works; a consumer is pinned by an external constraint | Report the conflict, name the constraint, propose nothing |
| **Intentional** | Divergence is recorded in a decision record                             | Silent                                                    |

That third state is why this belongs in Megamono rather than a standalone tool. A deliberate divergence — documented as an informed deferral — should not be re-reported every week. The docs corpus is what makes the check quiet enough to stay useful.

**Constraint sources** to parse, beyond `package.json`:

- Expo SDK version → its React and React Native pins
- `Package.swift` platform requirements and SPM version ranges
- `Cargo.toml` workspace dependency unification
- `composer.json` PHP platform requirement
- Declared `engines` and peer dependency ranges

### 2. Spec drift

Compares `docs/specs/` against what exists in the graph. Flags specs describing projects that were never built, projects with no spec, and specs whose stated architecture contradicts the current dependency edges.

Architecture comparison uses only the optional `architecture.allowed_dependencies` and `architecture.forbidden_dependencies` spec front matter defined by `spec-megamono-0004`. A declared allowed edge that is absent and a declared forbidden edge that is present receive stable, spec-qualified fingerprints. Prose is never parsed as an edge contract.

This check also compares managed repository skills with the templates shipped by the installed plugin. Missing, outdated, modified, and invalid managed copies are reported; ejected skills are deliberately excluded. Skill drift remains part of spec drift because these artifacts carry the repository's accepted operating contract.

Reports only. Never edits a spec (`spec-megamono-0005`, "Skills report, never auto-edit").

### 3. Stale plans

`docs/plans/` is ephemeral by design. Flags plans untouched past a threshold, plans whose referenced branch is merged or deleted, and plans superseded by a later plan on the same topic.

Plans are the one artifact safe to auto-update, so this check may propose closure directly.

### 4. Orphaned libraries

Libraries with no inbound graph edges. Often a genuine leftover from a refactor; sometimes a library consumed by a non-JS surface whose edge is missing because the relevant inference plugin isn't installed yet.

The check must distinguish these, or it will confidently recommend deleting a live Swift dependency. When an ecosystem is present but its plugin is not, report reduced confidence rather than a finding.

### 5. Integration template drift

Compares the SDK version each integration template targets (`spec-megamono-0012`) against what is actually installed.

A generator that emitted correct Sentry setup a year ago may be emitting — and the repo may still be running — a pattern the SDK has since replaced. Nothing else catches this: the app builds, tests pass, and telemetry keeps arriving until the day it doesn't.

Reports the drift and the template version that needs updating. Same channel as dependency alignment, because it is the same class of problem.

## Output contract

**Report to an issue. Do not open PRs.**

This is the central design decision and it follows directly from the failure mode above. A weekly issue is one notification with the full picture, where conflicts are visible together and the maintainer decides. Ten PRs are ten notifications, each arguing for itself, none aware of the others.

Mechanics:

- One issue per repository with the exact title `Megamono repository health` and fixed label `megamono:health`.
- **Update the existing open issue** rather than creating a new one, so the channel never becomes a stream.
- Findings grouped by check, each with the graph evidence that produced it.
- Empty run closes the issue rather than posting "nothing found."
- Reappearance after closure reopens the same issue when the API permits it; if the issue was manually locked or deleted, the workflow creates one replacement and records its number in the Actions summary.

Fixes remain a separate, explicit, human-initiated action.

### Deterministic package updates are a separate contract

The no-PR rule applies to Megamono health findings. It does not prohibit an explicitly enabled, package-owned updater from opening review pull requests for mutations that package can plan deterministically. `playstack:45-cli`, for example, may run `playstack update --pr` to update Playstack package versions and synchronize their owned artifacts in one branch so the consuming repository's CI can test the combined result.

That workflow does not turn a Megamono finding into a patch. Playstack owns the update plan, artifact hashes, merge behavior, branch, and pull request; Megamono health neither invokes it nor gains `contents: write` or pull-request permissions. If the Playstack workflow is selected, its own initialization may separately offer to exclude `@playstack/*` from Renovate or Dependabot so one updater owns both package versions and emissions. Megamono leaves those tools unchanged.

The stable distinction is: **Megamono reports graph-wide findings that require judgment; a package-owned updater may propose its own deterministic change for review and CI.**

`npm exec nx run megamono-docs:health` emits a deterministic JSON result and exits `0` whether findings are present or absent; findings are product output, not execution failure. Invalid configuration exits `2`, incomplete graph construction exits `3`, and an unexpected execution error exits `1`. `--fail-on-findings` is available for teams that deliberately want findings to fail CI.

The generated scheduled workflow declares only `contents: read` and `issues: write`, uses the repository-scoped `GITHUB_TOKEN`, and never runs on untrusted pull-request code. The command itself has no network requirement; a separate workflow step converts its JSON into the issue body.

## Cadence

Weekly by default. Daily is available and not recommended — the checks measure accumulation, and accumulation is not a daily phenomenon. A daily cadence produces near-identical reports, which trains the maintainer to skim.

Emitted as a scheduled CI workflow. It runs in **the user's own CI, on compute they already pay for.** There is no hosted execution path; see `spec-megamono-0001`, "Paid tier / hosted GitHub App — declined."

The default schedule is Mondays at `09:17 UTC`. The non-round minute avoids a common Actions scheduling peak. `megamono.json` may replace the cron or disable the workflow.

## Noise budget

The stated risk in `spec-megamono-0005` — noise kills adoption in two weeks — applies here with more force, because scheduled output arrives unrequested.

Rules:

- **Every finding is actionable or it is not reported.** "These versions differ" is not actionable. "These versions differ, here is the version that satisfies all six consumers" is.
- **Findings are suppressible via decision record**, not just config. Suppression should leave a reasoning trail.
- **Confidence is stated.** A finding derived from a complete graph and one derived from a partial graph are not the same claim.
- **Checks are individually disable-able.** A team that wants only dependency alignment should be able to have only that.

### Suppression records

Suppressions live in `megamono.json` but must point to an accepted or deferred decision:

```json
{
  "health": {
    "suppressions": [
      {
        "check": "dependency-alignment",
        "fingerprint": "react:synth-web:synth-mobile",
        "decision": "decision-20260823-react-version-split",
        "expires_at": "2026-12-01"
      }
    ]
  }
}
```

Fingerprints are stable, sorted identifiers produced in every finding. A missing decision, mismatched decision topic, expired suppression, wildcard fingerprint, or decision with a derived superseded state is a configuration error. `expires_at` is optional; suppressions without it remain visible in the generated issue under a collapsed “intentional divergences” section so they do not become invisible forever.

The required decision topic is fixed per check: `dependencies` for dependency alignment, `docs` or `architecture` for spec drift, `plans` or `lifecycle` for stale plans, `architecture` for orphaned libraries, and `integrations` for template drift.

## V1 decisions

- A plan is stale after 30 days without a content or status change. `megamono.json` may set an integer from 7 through 365.
- npm, Expo, SwiftPM, and Cargo constraints are evaluated in v1. Laravel ships with its Wave 2 plugin. Gradle relationships come from the official Nx Gradle plugin; unsupported constraint forms lower confidence and produce a review candidate, never a deletion or upgrade recommendation.
- Existing Renovate and Dependabot configuration is left unchanged. Megamono reports graph-wide conflicts and does not generate competing dependency PRs or silently narrow another tool's scope.
- Scheduled execution is deterministic. Agent-assisted review skills remain explicit as defined in `spec-megamono-0005`.

## Acceptance criteria

- Fixture repositories produce stable JSON and fingerprints for all five checks, including alignable, constrained, intentional, partial-graph, and empty cases.
- Running health twice against unchanged input produces byte-identical JSON.
- The issue publisher updates one issue, closes it on an empty run, and recreates at most one replacement after deletion.
- The generated workflow has no model-provider secret, no contents write permission, and no pull-request trigger.
- Health never creates a branch or pull request, invokes a package updater, or converts a finding into a mutation plan.
- Valid suppressions hide the primary finding but remain auditable; invalid, expired, wildcard, and superseded-decision suppressions fail configuration validation.
- A missing ecosystem plugin lowers confidence and cannot produce an automatic deletion or dependency-upgrade recommendation.
