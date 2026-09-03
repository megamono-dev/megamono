---
id: spec-megamono-0018
type: spec
status: accepted
visibility: internal
projects: [megamono]
topics: [dependencies, health, migration, nx, testing]
summary: Defines production runtime dependency and package-manager portability verification for mature workspaces.
date: 2026-09-03
supersedes: null
references: [spec-megamono-0000, spec-megamono-0006, spec-megamono-0014]
external_references: []
---

# Runtime portability verification

Mature-workspace adoption must detect runtime assumptions hidden by a developer machine, a hoisted dependency tree, or a broader build-stage installation. These checks complement repository structure and lifecycle health; they do not replace an application's tests or deployment authority.

## Built-output contract

`@megamono/plugin:verify-runtime` accepts an existing Nx project and a workspace-relative built output path. When the path is omitted, it reads the selected build target's `options.outputPath` or first declared output. It never builds implicitly.

The verifier recursively inspects JavaScript output for literal CommonJS requires, static imports, and dynamic imports. Relative paths, URL-like specifiers, import-map aliases, and Node built-ins are excluded. Package subpaths normalize to their owning package. Every remaining external must appear in `dependencies` or `optionalDependencies` in the project or root manifest. A package found only in `devDependencies` is a distinct error from a wholly undeclared package. Reports are deterministic JSON and include exact output-file evidence without copying source contents.

The managed `megamono` Nx project exposes this executor as `verify-runtime`, allowing a repository to run:

```text
nx run megamono:verify-runtime --project=api
nx run megamono:verify-runtime --project=api --outputPath=dist/apps/api --report=.megamono/runtime-api.json
```

Missing output is fail-closed and directs the caller to build first. Verification does not modify dependency declarations.

## Package-manager and container layers

Static output inspection is the first layer. A separate workspace-dependency verifier must inspect scripts, preload modules, executable ownership, workspace package closure, lockfile/Corepack/runtime alignment, and production-install contexts. It must use the repository's selected package manager and must not infer compatibility from a globally hoisted executable.

`@megamono/plugin:verify-workspace-dependencies` implements the static portion. It requires an exact `packageManager` pnpm pin and matching lockfile, compares the active Node and pnpm versions with committed requirements unless explicitly disabled, and verifies every nested manifest is included by `pnpm-workspace.yaml`. Known tool executables and Node preload modules referenced by package scripts must be declared by that manifest or the root workspace manifest. A dependency available only from a sibling manifest is reported separately from a wholly undeclared dependency. The check reads installed tool versions but never installs or rewrites packages.

Container validation is a further explicit layer. `@megamono/plugin:verify-container` statically checks build-stage discovery, copied package-manager lockfiles, pnpm workspace manifests, frozen installs, and production dependency installation or transfer. It emits deterministic JSON and fails on missing or mutable install inputs. The managed `megamono:verify-container` target accepts a workspace-relative Dockerfile and build context.

The default container check is read-only. Passing `--smoke` explicitly invokes `docker build` against the selected context after static validation succeeds. It does not start the image. Network access, image builds, and container execution are never part of the default health report, and production behavior beyond image construction remains application-owned.

The acceptance fixtures include built output requiring `tslib` and a `tsconfig-paths/register` preload so npm/Yarn hoisting assumptions cannot silently pass the pnpm portability contract.
