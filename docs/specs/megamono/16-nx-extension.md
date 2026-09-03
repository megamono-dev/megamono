---
id: spec-megamono-0016
type: spec
status: accepted
visibility: internal
projects: [megamono, nx-extension]
topics: [generators, graph, nx, release, testing]
summary: Defines WXT and generic browser-extension inference, WXT generation, store-command gating, and the Safari project boundary.
date: 2026-09-01
supersedes: null
references: [spec-megamono-0000, spec-megamono-0003, spec-megamono-0006]
external_references: [playstack:26-extension]
---

# Nx browser-extension integration

`@megamono/nx-extension` makes WXT and repository-authored browser extensions first-class Nx applications without taking ownership of product capabilities or store credentials.

## Compatibility

The package supports Nx 18–23 inference and declares the same Node 18.18–24 host range as the other inference plugins. Generated applications pin WXT 0.21.4, which requires Node 22 or newer; generation must fail before mutation when the active Node runtime is older. Existing hand-authored WXT projects may still be discovered on an otherwise compatible legacy workspace.

## Inference

The plugin discovers `wxt.config.ts`, `.js`, `.mjs`, and `.mts` files. Package identity and existing Nx tags are retained when present. Every inferred project is an application tagged `platform:extension`, `type:app`, and with the configured scope.

The plugin also discovers standard Manifest V2 and V3 `manifest.json` files. A valid extension manifest must declare its manifest version, name, and version. The nearest package manifest determines the project root and identity. Generic projects expose only repository-declared `build`, `dev`, `test`, and `lint` scripts through package-manager-neutral Nx script targets; Megamono never guesses their framework, output directory, browser matrix, archive format, or deployment. A WXT config in the same project takes precedence over its generated manifest.

The target contract is explicit:

- `dev-chrome` and `dev-firefox` are continuous, non-cacheable targets.
- `build-chrome` and `build-firefox` use distinct output directories.
- `build` is an aggregate over both browser builds.
- `package-chrome`, `package-firefox`, and `package-firefox-source` create distinct review artifacts.
- `package` is an aggregate over all three archives.
- `test` and `lint` use workspace-local binaries.

Safari is metadata-only in this project. A Safari Web Extension requires a separately governed Apple wrapper project, bundle identity, signing configuration, and App Store workflow.

## Store deployment boundary

No deploy target is inferred by default. A repository may add `extension.store.json` beside the WXT config with a `commands` object keyed by store name. Only those explicitly repository-owned commands produce non-cacheable `deploy-<store>` targets and an aggregate `deploy` target. The configuration never contains credential values; secrets and protected environments remain CI-owned.

## Generation and adoption

`megamono add app extension` and `@megamono/nx-extension:application` use the same generator. The result is a WXT workspace project with Chrome and Firefox entrypoints, tests, linting, explicit archive targets, package-manager workspace registration, and the canonical Megamono tags. The operation refuses occupied paths and conflicting project identities and is idempotent when the same contract already exists.

The base generator has no Playstack dependency. A future compatible `@playstack/extension` package may add auth handoff, messaging, and storage separately through Playstack. Its absence does not block creating or adopting a browser extension.

## Release gates

The package belongs to the fixed-version public `megamono` release group. Unit tests cover inference, browser-specific outputs, store-command gating, and generation. A packed local-registry fixture must install the published archive, run the generator, and validate the inferred target and Safari-boundary metadata before either `next` or `latest` can publish.
