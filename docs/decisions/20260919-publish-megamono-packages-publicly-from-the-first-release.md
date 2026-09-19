---
id: 'decision-20260919-publish-megamono-packages-publicly-from-the-first-release'
type: 'decision'
status: 'proposed'
visibility: 'internal'
projects: ['megamono']
topics: ['release', 'architecture']
summary: 'Publish Megamono packages publicly from the first release'
date: '2026-09-19'
supersedes: null
references: ['spec-megamono-0000']
external_references: []
---

# Publish Megamono packages publicly from the first release

## Decision

All six packages built in `megamono-dev/megamono` publish to npm with
`publishConfig.access: "public"` from their first release. This replaces the
restricted validation channel described in `spec-megamono-0000`, under which
the five scoped packages were to publish privately and `create-megamono` was
held back entirely until a separate public promotion.

`create-megamono` keeps its own independently versioned release group and is
published alongside the scoped set rather than after it. Distribution maturity
is now carried by the dist-tag: early versions go out under `next`, and
`latest` is selected deliberately from the release workflow.

This decision applies only to `megamono-dev/megamono`. Everything in
`megamono-dev/megamono-int` is internal and stays private permanently.

## Why

The restricted channel existed to let real installs be validated before the
package names became publicly visible. Two things make it a poor fit.

Restricted scoped packages require the `@megamono` scope to sit on a paid npm
plan, and public scoped packages do not. Paying for privacy that the project
does not want as an end state inverts the cost.

More importantly, restricted access and release readiness are separate
concerns that the old plan conflated. A dist-tag already expresses "published
but not yet the default install", it works identically for public and private
packages, and it is the mechanism consumers already understand. Registry
access was doing a job that `next` does better.

Holding `create-megamono` back had a single cause — npm cannot make an
unscoped package restricted — which disappears entirely once the scoped
packages are public. Shipping the entry point with the plugins it bootstraps
means the documented install path is real from the first release instead of
referring to packages nobody can install.

## Consequences

`tools/check-publish-policy.mjs` (renamed from `check-private-publish.mjs`,
run as `npm run release:check`) now fails the build when any published
manifest is missing public access, MIT licensing, a repository directory, or
the npm listing metadata. Scoped packages default to restricted on npm, so
access has to be declared rather than assumed, and the check is what keeps it
from drifting back.

The release workflow publishes both groups in one dispatch with
`--access public`, and offers `latest` alongside `next`.

Publishing publicly is effectively irreversible: names, versions, and tarball
contents stay visible after an unpublish, and npm restricts unpublishing after
72 hours. The packed-package and compatibility gates that already run before
the publish step carry more weight than they did under a private channel,
because a bad release can no longer be quietly replaced.

The GitHub environment that holds `NPM_TOKEN` is referenced as
`npm-${{ inputs.dist-tag }}`, so environments named `npm-next` and `npm-latest`
must exist with that secret before a release is dispatched.
