# `@megamono/plugin`

Add workspace conventions, generators, documentation, and repository checks to Nx.
This is the workspace-local implementation behind the `megamono` CLI and the
setup created by `create-megamono`.

[Documentation](https://megamono.com/docs) ·
[Generators](https://megamono.com/docs/generators) ·
[Requirements](https://megamono.com/docs/workflows/requirements)

## When to use this package

Install this package in an existing Nx workspace to adopt Megamono modules or
invoke its generators and executors directly. It is a root development dependency;
applications do not need it at runtime.

For a guided adoption workflow, use [`@megamono/cli`](https://megamono.com/docs/cli).
For a new repository, start with
[`create-megamono`](https://megamono.com/docs/cli/create-megamono), which configures
the local plugin for you. Platform inference is available through the separate
[Apple, Cargo, Cloudflare, extension, Render, and PHP plugins](https://megamono.com/docs/platforms).

## Get started in an existing workspace

Start from a clean branch and install the current public prerelease at the
workspace root. Keep your existing package manager; the examples use npm.

```sh
git switch -c chore/adopt-megamono
npm install --save-dev @megamono/plugin@next
git add package.json package-lock.json
git commit -m "chore: add Megamono workspace tooling"
npm exec nx -- generate @megamono/plugin:workspace-init --survey
npm exec nx -- generate @megamono/plugin:workspace-init --profile=pilot --dry-run
```

The survey inventories the repository. The pilot plan selects lint, health, and
project inference while retaining your existing CI and release workflows. Review
the plan and supply any requested mappings, then apply it:

```sh
npm exec nx -- generate @megamono/plugin:workspace-init --profile=pilot --yes
npm exec nx -- run megamono:check
npm exec nx -- run megamono:health
```

Review generated files and run the workspace's existing tests and builds.
`megamono:check` enforces repository rules; the health report provides advice and
coverage information. A generated health report does not certify a deployment.

## What you can add

| Need                                           | Capability                                                                | Guide                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Consistent applications and shared code        | Application and TypeScript library generators                             | [Generators](https://megamono.com/docs/generators)                            |
| Repository rules that can be adopted gradually | Project tags, structural checks, ESLint rules, reviewed warning baselines | [Governance](https://megamono.com/docs/workflows/governance)                  |
| Documentation people and agents can navigate   | Specs, plans, decisions, indexes, and lifecycle checks                    | [Repository documentation](https://megamono.com/docs/workflows/documentation) |
| Database projects and generated clients        | Prisma and Drizzle setup                                                  | [Databases](https://megamono.com/docs/generators/database)                    |
| Blog or changelog data                         | Content Collections libraries and document types                          | [Content libraries](https://megamono.com/docs/generators/content-lib)         |
| Existing product capabilities                  | Package-authored, optional Playstack integrations                         | [Playstack](https://megamono.com/docs/workflows/playstack)                    |

Choose modules through an adoption profile or `--only`; review the
[workspace initialization options](https://megamono.com/docs/generators/workspace-init)
before broadening adoption. Available generator names are recorded in
[`availability.json`](./availability.json); reserved or gated features are not
runnable generators.

## Review exact adoption policies

Configuration version 2 is an explicit opt-in; new workspaces and version 1
retain their existing defaults. Start with a report, then review a separate policy
file before applying it on a clean feature branch:

```sh
npm exec nx -- generate @megamono/plugin:adoption-policy --report=tmp/adoption-policy.json
npm exec nx -- generate @megamono/plugin:adoption-policy --policyFile=.megamono/reviewed-policy.json --dry-run
npm exec nx -- generate @megamono/plugin:adoption-policy --policyFile=.megamono/reviewed-policy.json --apply
```

The strict policy file uses `schemaVersion: 1`, optional `boundaryAllowances`
and `warningBaseline` fields, and explicit `replaceLegacyRatchets: true` when
replacing v1 counts. Allowances require an accepted decision for one exact
source/target, type- or scope-direction constraint, and dependency classification.
Warning entries require a complete reported identity, reason, `reviewReference`,
and recorded Git `revision`; they record temporary debt rather than architectural
permission. Review revisions must be verifiable ancestors of the current HEAD.

New identities fail even if total warning counts decrease. Errors cannot consume
warning entries, and resolved entries need reviewed pruning. Reports and repeated
initialization never enroll or prune findings automatically. Apply preserves
existing rule severities and unrelated settings, validates the complete candidate,
and activates the canonical ESLint boundary wrapper once. Unsupported lint
configuration or incomplete review data blocks apply without partial policy
writes. No adopter's existing warnings are approved automatically.

## Working with platform boundaries

Keep both structural and source-level checks enabled. Next.js Pages Router
applications can use Node dependencies in API routes and server data functions;
browser code still needs browser-safe entry points. Node packages can declare
those entry points through explicit `browser` export conditions. App Router,
hybrid-router, and custom route-format projects retain the aggregate boundary.

Extension projects may opt into reviewed renderer/worker analysis through their
own `package.json` ([schema](./schemas/extension-runtime.schema.json)):

```json
{
  "megamono": {
    "extension": {
      "runtimeEntries": {
        "version": 1,
        "renderers": ["entrypoints/popup/index.html"],
        "workers": ["entrypoints/background.ts"],
        "rationale": "Reviewed renderer and background-worker separation.",
        "decision": "decision-20261110-extension-renderers"
      }
    }
  }
}
```

Both arrays are required. Paths are project-relative, repository-owned and
symlink-free; renderer HTML must bind literal local module sources. The author
and accepted decision attest that the entry list is complete. Dynamic WXT
configuration and hooks are not executed or automatically proven. WXT content
scripts and dynamically discovered entries are not automatically classified as
HTML renderers; unclassified production roots remain restricted. Missing,
inactive, malformed, archived, duplicate or superseded decisions fail even with
`--skipDocs`.

Only observed static/dynamic imports reachable exclusively from renderers may
consume a `platform:web` project. Worker-reachable helpers, unclassified
production roots, unresolved imports and implicit edges remain restricted.
Node built-ins, scope/type constraints and Playstack direction remain enforced.
Checker JSON exposes the contract and applied uses in `extensionRuntime`;
`complete` means source consistency under the attested roots, not runtime or
deployment qualification. This introduces no blanket tooling/test glob exemption.

Local workspace tooling is MIT licensed and works without a hosted account.
Playstack and the hosted Megamono service are optional. Exact Node, Nx,
TypeScript, and package-manager ranges are listed in the
[requirements guide](https://megamono.com/docs/workflows/requirements) and
[`compatibility.json`](./compatibility.json).

### Where shared UI components live

Type direction is fixed: `type:ui` may import only `type:util`, so one UI
library cannot import another (for example an icon or logo package). Choose one
of these documented shapes rather than retagging projects:

- Keep components that compose each other in one `type:ui` library, and move
  renderer-free logic (tokens, ranking, formatting) into `type:util` libraries
  that any UI library can import.
- Put portable design tokens in a single platform-neutral `type:util` library
  tagged `capability:theme-tokens`; UI libraries and the Chakra theme both
  import it. The Chakra theme generated with a web/site app stays a
  `platform:web`/`type:ui` runtime adapter (it calls `createSystem`); the app,
  not a component library, provides it through `ChakraProvider`.
- Compose UI libraries in a `type:feature` library, which may import `ui`.
- For a reviewed exception, use configuration version 2 and record one
  `boundaryAllowances` entry (constraint `module-boundaries:type-direction`)
  for the exact source/target pair, backed by an accepted decision.

## Learn more

- [Adopt an existing workspace](https://megamono.com/docs/workflows/adoption)
- [Browse generators](https://megamono.com/docs/generators)
- [Run checks and tasks](https://megamono.com/docs/actions)
- [Report an issue](https://github.com/megamono-dev/megamono/issues)

MIT licensed. See [LICENSE](./LICENSE).

## Advanced reference

<details>
<summary>Generator behavior, integrations, runtime verification, and maintainer workflows</summary>

### Governance execution safety

Health JSON reports include `purpose: "advisory"`, `readiness: "not-assessed"`,
and per-family `coverage` (`completed`, `partial`, or `skipped`, with reasons).
Zero findings is not evidence that a skipped check passed. Findings carry warning
severity and a category; adoption ratchets are `adoption-debt`, even though their
legacy check family remains `spec-drift` for compatibility. Without docs adoption,
specification coverage is not assessed. Dependency-range and orphan advice requires
consumer review; it is not an instruction to narrow public peers or delete entrypoints.
The health executor reports `gate.mode` and `gate.passed`: report-only has no gate
result (`null`), while `--failOnFindings` evaluates only the selected findings, not
production readiness or unavailable checks. Report generation success is not
deployment certification.

### Expo adoption and validation

Adopting the `ci` module detects Expo apps and adds a non-cacheable
`expo-doctor` target. Existing build/export targets depend on Doctor; maintained
`@nx/expo` inference receives dependency overlays rather than replacement
commands. New `mobile` apps receive the same wiring. Generated affected CI runs
Doctor before its lint/test/build phase. Equivalent repository-owned workflows
remain unchanged: add the Doctor target to workflows that do not reach a guarded
build/export target.

New mobile apps declare their own SDK-compatible React, React DOM, native
runtime, Expo modules and test/build tools. SDK requirements come from matching
installed Expo metadata or verified public SDK snapshots; Nx supplies the
maintained project scaffold. Existing root and web dependency declarations
retain their versions and ownership. Ambiguous SDK ranges, incompatible native
runtimes, or conflicting Expo inference policies require explicit review.
Without an existing workspace SDK policy, generation selects the reviewed
Expo 57.0.31 snapshot. This pins the SDK lane instead of following an unbounded
registry tag. Each Expo SDK and its tools have their own Node requirements;
the plugin's core Node peer range does not extend those requirements.

New Metro configuration extends `expo/metro-config`, retains its monorepo
defaults, and resolves React entrypoints from the mobile app so hoisted native
libraries use the same React singleton. Existing application configurations are
not migrated by adding another app. On Nx 18 and newer, generation uses
maintained inference, reusing a compatible unscoped registration or adding an
exact scope for the new app's configuration files. Custom target names and
dependency export ordering are preserved.

Install and pin an `expo-doctor` development dependency compatible with the
app's Expo SDK and Node version using the workspace package manager, and commit
the lockfile. Megamono runs only that installed tool from the app directory. It
does not download a tool on demand or raise the core adoption Node requirement
to match the latest Doctor. For example, after selecting and installing the tool:

```sh
npm exec nx -- run mobile:expo-doctor
npm exec nx -- run mobile:export
```

Use your actual Nx project and export target names. Custom Doctor targets are
retained; keep them non-cacheable and independent of build/export targets. Direct
EAS commands, custom build scripts and remote providers need their own validation
wiring. Existing Metro configuration and app-specific React versions remain
consumer-owned. Follow [Expo's Metro guidance](https://docs.expo.dev/guides/customizing-metro/)
and validate each app's SDK rather than aligning mobile React to a newer web app.

Health reports expose `platforms.expo` with declared/installed SDK versions,
Doctor configuration and Node compatibility, Metro import evidence, and installed
React/React Native compatibility. Static inspection never executes project
configuration and always reports validation as `not-assessed`. An import or a
configured target is not proof of a passing Doctor, bundle, native or cloud build.

Packed Expo regression lanes cover SDK 54/Nx 23.3.1 adoption and generation,
and default SDK 57.0.31 generation with the emitted Nx 23.2.1 scaffold. Both run
on Node 24.22.1/npm 11 with split mobile/web React versions. They execute
Doctor, web/iOS/Android JavaScript exports, bundle isolation checks, TypeScript
and the generated unit test. Other SDKs, older Nx target behavior and native/cloud
builds require their own qualification. SDK selection tests do not establish
bundle compatibility for every snapshot.

Strict package-source profiles also reject root `.yalc`/`yalc.lock` state even
when ignored. The diagnostic distinguishes active manifest/configuration
addresses from possible unused residue. Verify registry installation in a
separate clean checkout without deleting local development files; do not weaken
CI policy merely to make a developer checkout pass.

Generated `megamono:check` targets are non-cacheable. The checker reads the Nx
graph, repository sources/configuration, and installed artifact contents; the
previous explicit input list did not qualify that complete cache contract.
Re-running workspace initialization upgrades intact managed targets. Modified or
ejected targets remain consumer-owned: set `cache: false` on those targets before
relying on a successful check. A cache hit from an older target is not fresh
governance evidence.

An explicitly identified e2e project (`role:e2e`, or Nx's legacy `e2e` project
kind) may schedule an application through an implicit graph edge without a
platform mismatch. The target must be an application rather than another e2e
project. This exempts only that edge's platform comparison: scope, type and
Playstack-direction constraints still apply. Static/dynamic imports remain
subject to platform checks, including when the same projects also have an
implicit scheduling edge. Naming a project `*-e2e` alone grants no exemption.

When `adoption.ratchets` is nonempty, `check` enforces each `initialCount` as a
structural-warning ceiling. Unlisted structural categories have a zero budget;
errors always fail independently of budgets. After fixing debt, lower the count
explicitly and commit the reviewed change. Checks never rewrite baselines. Empty
ratchets retain the existing severity-only behavior for non-ratcheted workspaces.
These are **count-based**, not identity-aware baselines: replacing one warning
with another in the same category can pass. Keep review of the actual diagnostics;
do not interpret a passing budget as proof that no new violation was introduced.

Managed ESLint defaults are inserted **before** repository-owned flat-config
entries. Existing consumer severities and boundary options win, including error
rules during migration. Intact managed sections are repositioned on regeneration;
modified/ejected sections are never moved. Explicit consumer rule overrides remain
the way to change this policy; review them alongside checker warning budgets.

### Buildable Prisma clients

`megamono add database primary --adapter=prisma --buildable --yes` opts a **new** database project into Prisma client generation followed by TypeScript compilation. `--client-output=src/db/client` selects a custom source directory. The project exports `dist/index.js` and declarations, records generated/build outputs for Nx, and keeps its package private. Consumer builds must depend on this project's `build` (through the Nx graph or an explicit dependency).

This profile targets Prisma/client 7.10.0 with the engine-free ESM generator. Existing conflicting dependency selections fail for review, rather than being replaced. Add application models before generating; install/configure a PostgreSQL driver adapter in the application. Compilation and package import tests do not establish live database or deployment correctness. Existing schemas, engine-based clients, client lifecycle, release workflows and migrations are never converted. Without `--buildable`, the existing schema-only workflow is unchanged.

### TypeScript libraries

`megamono add library browser-auth --platform=web --yes` composes the locally installed `@nx/js` generator, creates a private `libs/browser-auth` library, and applies scope/type/platform tags. The default platform is `neutral` (no platform tag); `web`, `node`, `mobile`, and `worker` are explicit alternatives. `--type=util|ui|data|feature` selects the dependency-boundary role. Mobile means portable TypeScript for a mobile consumer, not native framework scaffolding.

`megamono add library client --scope=acme --publishable --access=public --yes` creates a buildable `packages/client` package. Publishable packages default to restricted registry access. Existing release groups/workflows remain unchanged: review enrollment and the generated README's build-output location before publishing. Existing paths are never moved or converted by this generator.

Use `--packageScope=acme` to choose the npm namespace independently from the architectural `--scope`. For example, `--scope=acme-int --packageScope=acme` creates an `@acme/*` package with `scope:acme-int`. Supplying only `--scope` retains its previous package-and-boundary behavior.

Libraries receive a Vitest starter and separate production/spec TypeScript configurations. Test errors do not enter production compilation. `--platform=web --type=ui` additionally supplies React JSX/DOM settings and React peer/development dependencies. The qualified Vitest toolchain requires Node 20.19+, 22.12+, or 24+; use `--testRunner=none` to opt out explicitly, including on an otherwise supported Node 18 workspace. Supported modern Nx workspaces receive scoped inference without migrating existing projects.

Without `--yes`, or with `--dry-run`, only the plan is displayed. `--skipInstall` writes dependency declarations but suppresses the deferred Nx install callback; run your usual workspace installation afterwards, retaining its package-manager/store settings. The equivalent direct invocation is `nx generate @megamono/plugin:library --name=client ...`. A compatible local `@nx/js` is required. A comma-separated `--name=core,ui,browser` adds several libraries with the same options as one change and one install. Library addition normally requires a clean working tree on a non-default branch; `--allowDirty` permits unrelated uncommitted work but still fails, writing nothing, when a file the generator would write (or, unless `--skipInstall`, a lockfile) has uncommitted changes.

Bundlers that compile workspace library source directly, including Next 16's
Turbopack, cannot map a nodenext-style `./lib/x.js` specifier to `./lib/x.ts`.
New `create-megamono` workspaces on TypeScript 5.7+ therefore set
`rewriteRelativeImportExtensions: true` in the base TypeScript config, and the
library generator then writes relative re-exports as `./lib/x.ts`; `tsc` still
emits `./lib/x.js` in JavaScript output, and declaration consumers resolve the
`.d.ts`. Write new relative imports in workspace libraries with `.ts`/`.tsx`
too. In other workspaces generated starters keep Nx's specifiers; opt in by
adding the same base option (it also applies to applications that typecheck
library source, such as `next build`).

Applications typecheck against TypeScript project references, which `nx sync`
maintains. For a referenced library, `tsc` reads the library's built declaration
output rather than its source, whatever export condition matches. Run
`nx typecheck <app>` (or `tsc --build` on the application config), which checks
referenced libraries first; a bare `tsc --noEmit` in an application directory
reads whatever library declarations were last built and can report stale
missing exports. The generated extension's `typecheck` target depends on
`^typecheck` for the same reason.

Libraries start with a single `.` export. To let a bundle import one feature
without the rest of the barrel (and its dependencies), add a subpath export:

```sh
nx generate @megamono/plugin:library-entrypoint acme-browser --name=ranking
```

This adds `./ranking` beside `.`, mirroring every condition of the root export
(source, `types`, built `dist` paths and custom source conditions), and seeds
`src/ranking/index.ts` when it is missing. `--sideEffects=false` declares the
package free of module side effects only after confirming that no production
source has a side-effect-only import such as `import './theme.css'`; it does not
monitor later edits, and bundle-size attribution remains the bundler's job.
Nothing marks a library side-effect free by default.

### Application generation

#### Native Android / Kotlin

`megamono add app android --yes` creates a native Kotlin/Jetpack Compose app in
`apps/android`, separate from the Expo `mobile` preset. The direct generator is
`nx generate @megamono/plugin:app --type=android --yes`. Use `--name=reader` for
`apps/reader`, `--directory=apps/native-reader` for an explicit root, and
`--displayName="Reader" --applicationId=com.example.reader` for Android identity.
The default ID is derived safely from the scope and name; review it before distribution.

The scaffold includes a checksum-pinned Gradle 8.13 wrapper, AGP 8.13.2, Kotlin
2.2.10, Compose, and an Android manifest with no requested permissions. It needs
JDK 17 and SDK platform 36/build tools 35.0.0 to build, not to generate. Set
`JAVA_HOME` and `ANDROID_HOME`, or configure the SDK in Android Studio. Generation
never accepts SDK licenses, starts emulators, installs onto devices, or configures
release signing. See the generated README for the native toolchain setup.

Nx `build`, `test`, `lint`, and `install` targets run the wrapper through an
argument-vector Java launcher on all hosts. `install` requires an existing device
or emulator and installs only a debug APK. Tests are JVM tests, not device/UI
qualification. Native targets are non-cacheable and same-project execution is
serialized; review compiler/SDK/environment/signing inputs before enabling Nx
caching. Standard Unix and Windows Gradle wrappers remain available for IDE/native
workflows. Existing Android projects are not imported or rewritten by this preset.

Maintainers can run `npm exec nx -- run @megamono/plugin:e2e-android` to check the
packed generator, bundled assets, dry run, and resolved Nx graph. Set
`MEGAMONO_ANDROID_NATIVE_E2E=true`, `JAVA_HOME`, and `ANDROID_HOME` to additionally
build an APK and run the generated JVM test and Android Lint. The fixture uses a
directory containing spaces and never installs onto a device. The native-execution
workflow runs this opt-in qualification on macOS, Linux, and Windows. A passing
generation-only fixture does not qualify the Android toolchain.

#### Shared generator behavior

Application and library generation preserve existing `pnpm-workspace.yaml` comments while applying real workspace/dependency-policy changes. Invalid YAML fails before the composed generator runs. Neither wrapper chooses a new pnpm store or changes `.npmrc`.

Framework generators add runtime packages (Nest, `axios`, Next/React) to the
root manifest. Application generation also declares each runtime package it
added in the generated projects that import it (an e2e project gets it as a
development dependency), or in the application itself for framework peers such
as `rxjs`. The root declarations remain because Nx plugins resolve framework
packages from the workspace root. In pnpm workspaces each generated application
also gets an `audit` target (`@megamono/plugin:audit-production`): it lists the
project's production closure with `pnpm list --prod --json --depth Infinity
--filter <package>`, including workspace packages it depends on, and checks only
those versions against the registry's bulk advisory endpoint, unlike
`pnpm audit`, which ignores `--filter`. `auditLevel` (default `low`) sets the
failing severity; `registry` selects the advisory registry.

Use `megamono add app web --skipInstall --yes` (also available for `add library`) when installation must be controlled by the caller. This suppresses deferred generator callbacks, including dependency installation; declarations still change. Afterwards, run the workspace's established install command using its existing environment and store configuration. This does not bypass package-manager checks that happen before the Nx generator starts, and does not change the behavior of directly invoked third-party Nx generators.

Web/site generation supports `--router=pages|app` (Pages Router remains the
default). For example, `megamono add app site --router=app --styling=chakra`.
App Router emits a server `layout.tsx` with metadata, a server `page.tsx`, and
client `providers.tsx`/billboard files. Chakra's system is constructed/imported
within the client boundary, not passed as a serialized server prop. Router
selection is not a migration command: a conflicting existing router is refused,
and rerunning a matching project preserves application-owned theme/provider edits.

New Next.js apps on Nx 18+ use scoped inference and a plain `next.config.js`.
The generated `serve`/development and `start` launchers accept injected `PORT`,
then read the application's `ports.<name>` entry from `megamono.json` at startup,
fall back to the planned application port, and resolve the app independently of
the invoking directory (Nx from any workspace subdirectory, or
`node scripts/next-server.cjs dev` from the application directory). Process supervisors can run the Nx command from the
workspace root with `NX_DAEMON=false`; the launcher forwards shutdown signals.
Explicitly disabled or ambiguous inference policy requires review.
Nx 17 retains its legacy generator path.

On Nx 18+ with inference enabled, every project an app generator creates
(including e2e projects, the Nest feature library and the extension) and every
`create-megamono --packages` library is linted by an `@nx/eslint/plugin`
registration scoped to its root, rather than the deprecated `@nx/eslint:lint`
executor. The inferred target runs `eslint .` from the project root, so `files`
and `ignores` globs in a project's `eslint.config.mjs` match relative to that
project (`scripts/**`). Projects that still use `@nx/eslint:lint` run ESLint from
the workspace root, where the same override must be written `**/scripts/**`;
`nx g @nx/eslint:convert-to-inferred` migrates them. Generated extension lint
ignores WXT's `.output/` and `.wxt/` directories.

The generated Chakra theme declares React, Chakra and Emotion as peers with
matching development dependencies and uses bundler-oriented typechecking.
The generated Chakra app and theme configs check application source and skip dependency declaration
checking because Chakra 3.37 contains an incompatible `cornerShape` declaration.
This workaround can be removed after the upstream declaration is corrected.
It remains a web runtime adapter, rather than a neutral token library; portable
tokens should live separately. Existing themes are preserved during app addition.

Nx generators, executors, and ESLint rules for Megamono workspaces. The package
implements versioned workspace configuration, documentation lifecycle tooling,
repository structural checks, and deterministic repository health reporting.

### Initialize an existing workspace

#### Adopt an existing email preview

`emails-adopt` maps an existing email library, shared token file, synthetic
fixtures, and reviewed Nx targets. It installs nothing and does not modify
templates, themes, preview scripts, CI, or delivery providers.

```sh
npm exec nx -- generate @megamono/plugin:emails-adopt \
  --project=emails --previewTarget=email-preview --verificationTarget=email-contract \
  --templatesRoot=libs/emails/src/templates --fixturesRoot=libs/emails/src/previews \
  --themeFile=libs/theme/email-tokens.ts \
  --reviewedLocalOnly --reviewedFixtureOnly --planOnly
```

After reviewing the plan, replace `--planOnly` with `--yes`. The preview target
must explicitly set `cache: false`; verification must also be non-cacheable and
run to completion. The review flags attest that **your existing command** binds
to loopback and reads synthetic fixtures, not production secrets or recipients.
The generator cannot certify arbitrary application commands from those flags.

Adoption records `.megamono/email-previews/<encoded-project-name>.json` and adds
`<project>:megamono-emails-verify`, which depends on the selected verification
target and propagates failure. Run it explicitly or add it to your existing CI
after review. That target should check non-empty subject/HTML/plaintext, props
validation, encoded size limits, loopback preview and capture delivery. The
record stays `qualification: not-run`; creating a target is not evidence of a
passing contract. Matching reruns are no-ops, and conflicting mappings/targets
are rejected without overwriting application code.

The full `emails` **scaffolding** generator remains gated on seed-template and
recipient-locale fan-out qualification. Existing-preview adoption does not
enable production sending, invent email templates, or claim provider/client
deliverability. Maintainers can run `@megamono/plugin:e2e-email-preview-consumer`
to qualify the packed adoption path with real Chakra Email and Playstack capture.

#### Workspace conventions

```sh
npm exec nx -- generate @megamono/plugin:workspace-init --defaultPlatform=node
```

For a mature mixed workspace, survey first and resolve only genuine ambiguity:

```sh
npm exec nx -- generate @megamono/plugin:workspace-init --survey --format=json
npm exec nx -- generate @megamono/plugin:playstack-integrate --packages=@playstack/rate-limit --api=apps/api --planOnly
npm exec nx -- generate @megamono/plugin:workspace-init --profile=pilot --dry-run
npm exec nx -- generate @megamono/plugin:workspace-init \
  --only=docs,agents,ci,lint \
  --adoptionMap=.megamono/adoption.json \
  --docsAdoptionMap=.megamono/docs-adoption.json \
  --ciMode=auto \
  --yes
```

For direct Nx integration planning, use `--planOnly`: Nx consumes its reserved
`--dry-run` option before invoking generators. `megamono add integration
--dry-run` forwards the planning option automatically.

Playstack integration manifests remain package-owned. The generator validates
the full published JSON schema, manifest package version, and every ejectable template hash, maps each
surface into an explicit Nx root, and records application-owned output. Existing
composition roots change only through an explicitly reviewed `--composition`
connection. Conditional requirements are resolved
with `--adapters`, `--persistence`, and an exact JSON `--conditions` map;
package-authored decisions use `--decisions`. Migration work records
`--adoptionMode=fresh|compare|shadow|cutover` and emits one suggested commit
boundary per package integration.

Signed Yalc builds may add SemVer build metadata to the installed package version
without rewriting its integration manifest. This metadata does not change the
release/prerelease contract. Plans retain the full installed version and hash
the installed artifact, so changing a build still invalidates qualified evidence.
Different releases, prereleases, and invalid versions fail before writes.
Re-running verification wiring accepts Nx's empty `options`/`configurations`
and default `parallelism: true` graph metadata. Non-default settings and other
target edits remain conflicts; generated source does not copy graph defaults.

For example:

```sh
npm exec nx -- generate @megamono/plugin:playstack-integrate \
  --packages=@playstack/nest-auth,@playstack/nest-billing,@playstack/webhooks \
  --api=apps/api \
  --persistence=application \
  --adoptionMode=shadow \
  --conditions='{"Stripe is selected":true}' \
  --decisions='{"auth.transport":"cross-origin-refresh-cookie","auth.sessionProjection":"newsbetters-session","billing.priceCatalog":"newsbetters-plans","webhooks.providers":"stripe:default"}' \
  --planOnly
```

Dry runs surface unresolved decisions, inactive conditions, duplicate manifest
requirements, occupied targets, and existing route/provider/environment/config
references. An accepted write still fails closed until every required condition
and decision has an explicit value.

Selected roots must be existing Nx projects. Static Nest controller/method
decorators are composed for route collision checks, including aliased imports;
dynamic declarations require manual review. These checks do not replace an
application build or endpoint integration tests. Dedicated persistence/phase
options cannot contradict package decision values. Re-running preserves
formatting-equivalent output, while substantive user edits remain fail-closed.

Integration plans also report installed artifact/manifest hashes, internal
dependency closure and peer versions. Runtime changes at the same package version
invalidate migration evidence. A stale installed copy relative to the consumer's
`.yalc` payload blocks generation; a newer same-version Yalc store is reported
without silently adopting it. Refresh dependencies explicitly before continuing.

For mature application wiring, `--equivalences` is a reviewed JSON map:
environment requirement keys map to variable names; declared module/provider
symbols map to `existing:libs/example/src/module.ts#ExportedModule`; and
`package:integration:template` keys can map to `existing:<file>` to reuse that
file instead of generating a duplicate. The referenced keys/files/exports are
validated. Environment mappings record bindings without rewriting arbitrary
template code. These mappings are declarations of application ownership, not
automatic proof of behavioral equivalence.

Integration plans include a `readiness` section distinguishing inspected package
installation, manifest/template availability, planned versus generated/reused
wiring, and required test targets. Dry runs report packages without integration
manifests as preflight conflicts; write mode still refuses to invent their wiring.
An integration with no selected templates remains application-owned, not complete.
Verification is always `not-run` by this generator: mapped Nx targets and recorded
migration stages are not evidence that application/provider tests just passed.

`--verification` maps every active `package:integration:test` ID from the plan to
an existing `project:target`; `--verificationProject` selects the project for a
`playstack-verify` aggregator. Optionally pass both `--ciWorkflow` and `--ciJob`
to append one reviewed verification step to an existing GitHub workflow job.
No installation, release, signing, or deployment steps are replaced.

The persistent `.megamono/playstack-integrations.json` ledger tracks each
integration independently. `--adoptionMode` remains advisory; actual recorded
transitions use `--migrationStages` with a JSON `package:integration` map. Start
with `{ "stage": "compare" }`. Moving to shadow/cutover/rollback also requires
`verificationReport` and `rollbackPlan` workspace file paths. The JSON report
must contain `schemaVersion: 1`, the `integration` key, the current plan's
`fingerprint`, the target `stage`, `result: "passed"`, and a nonempty `checks`
array covering all required test IDs. These are application-reviewed
attestations: the generator records their digests but never executes a traffic
cutover, database migration, or rollback. Invalid transitions fail before writes.

#### Application migration contract gates

Use `--migrationContracts` to supplement package manifests with reviewed
application acceptance requirements. Keys are active `package:integration` IDs
from the survey/plan (do not guess them); values select one or more profiles:

| Profile                   | Required proof before shadow/cutover                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue-jobs`              | Producer/worker payload, envelope, job ID and Redis-prefix compatibility; scheduler, delayed/retried job and drain/recovery tests against a real queue. Queuebert monitoring checks alone do not qualify. |
| `application-persistence` | Implemented adapter behavior, uniqueness/tenant isolation and injected physical-transaction rollback against a real database. Generated throwing stubs or a typecheck do not qualify.                     |
| `auth-policy`             | Real-database session policy tests for reviewed expiry, session caps, replay/grace and membership; transport security tests including SSO where enabled. Policy values remain application-owned.          |
| `billing-cutover`         | Real-database projection comparison plus single-writer authority and rollback tests. Comparison is not authorization to enable a second writer. Marketplace policy remains application-owned.             |

For example, `--migrationContracts='{"@playstack/queues:nest-queues":["queue-jobs"]}'`
is valid only when that exact integration appears in the selected plan. Review
the emitted `migrationContracts` descriptions, `requiredTests`, and
`qualification` before mapping **every** test ID through `--verification`.
The existing verification aggregator and optional reviewed CI step include these
tests; existing deployment/release gates remain untouched.

Profiles are opt-in and do not change existing fingerprints when omitted.
For selected profiles, a requested shadow/cutover adoption mode (including a
package's `.adoptionMode` decision) must match the qualified ledger stage before
files can be written. A dry run shows the mismatch as a preflight conflict.
Selected profile tests and environment requirements participate in the integration
fingerprint. `--qualification` may add environments, but cannot weaken profile
minimums. `real-queue` means an actual queue backend, including a disposable local
Redis-backed queue—not an in-memory fake or a dashboard assertion.

Profile-qualified shadow/cutover/rollback transitions require schemaVersion 2
receipts with source revision, runtime versions and passed checks matching each
required ID, kind and environment. Every required passed check must reference
nonempty application-owned evidence using `{ "path": "reports/test.log",
"sha256": "<64-character SHA-256>" }`; the generator verifies those file hashes.
A matching reviewed rollback file is still required. Skipped tests, stale files,
compile-only substitutes and legacy passed-label receipts cannot satisfy these
gates. These remain reviewed attestations, not automatic certification of test
content, a scan proving adapters complete, or execution of a traffic cutover.

Fontstack-style adoption can therefore proceed with governance and infrastructure
while keeping identity/account and queue/billing cutovers separately gated.
Select native Playstack contracts directly when appropriate; application-owned
persistence and legacy migration scaffolds are not mandatory for prelaunch apps.

Shared Nest composition is opt-in with `--composition='<json>'`:

```json
{
  "project": "playstack-platform",
  "modules": [
    {
      "file": "libs/platform/playstack/src/auth/auth.module.ts",
      "export": "AuthModule"
    }
  ],
  "connect": {
    "file": "apps/api/src/app/app.module.ts",
    "module": "AppModule",
    "importPath": "@my-org/playstack-platform"
  }
}
```

Create the library using the workspace's normal Nx library generator first, so
its package-manager registration, TypeScript references, and build configuration
remain correct for that workspace. The import path must already identify that
library. Selected Nest templates are emitted into this library; configured
modules must be explicitly selected and directly exported with static `@Module`
metadata. The shared module and barrel are generated there, and the optional
connection adds a single AppModule import without replacing its existing metadata.
Dynamic AppModule imports and identifier collisions require manual review.
The migration ledger binds the reviewed composition project, module selections,
and AppModule connection. Changing them during shadow or cutover requires rolling
back the previous contract first, just like changing a package integration.
Generated root hashes permit pristine updates, while edited roots fail closed.
Provider registration arguments are never guessed from package export names.

Named adoption profiles are shortcuts over the same independent modules:
`minimal` selects project boundaries and health; `pilot` adds platform
inference without claiming repository CI or release workflows; `platform` adds
CI and release management; and `full` selects every governance module.
`--profile` and `--only` are mutually exclusive. Every plan groups the selected
modules into suggested commit batches without running Git or committing on the
caller's behalf.

The `release` module's `.github/workflows/megamono-release.yml` is dispatched
manually from the `npm-next` environment and defaults to a dry run. Its
`publish-current` mode publishes the versions already in `package.json` (a
first release, or a retry after a failed publish); `bump-and-publish` runs
`nx release version` with a commit and tags as `github-actions[bot]`, builds,
pushes, and only then publishes. It publishes through npm trusted publishing
(`id-token: write`; npm 11.5.1+ is installed when the runner's npm is older,
and pnpm 11 uses its own OIDC support) or, when the `NPM_TOKEN` secret is set,
with that token in the runner's `.npmrc` (also exported as
`YARN_NPM_AUTH_TOKEN` for Yarn and `NPM_CONFIG_TOKEN` for Bun). Dispatch inputs
reach scripts only through environment variables. Rerunning `workspace-init
--only=release` replaces an unmodified managed copy with the current template;
a modified copy is left in place with a warning, and an ejected copy is never
touched.

The survey includes a versioned `inventory`, plus
`adoptionTemplates.projects`, `adoptionTemplates.documentation`, and
`adoptionTemplates.render`. Inventory
v1 is Nx-project-aware: it records nested framework/router evidence, imported
external packages, environment-variable names (never values), Prisma schema
contexts, Redis/BullMQ usage, and Docker/Render deployment markers. Ambiguous
or dashboard-owned topology remains an explicit finding instead of becoming a
guessed configuration. Copy the relevant project or documentation template
into a workspace file, replace any `<review-…>` placeholders, and pass that
file with `--adoptionMap` or `--docsAdoptionMap`; pass the reviewed Render map
inline as described below.

Package-manifest Nx projects are included; `project.json` is not required.
Shared Worker libraries can be classified from an explicit
`@cloudflare/workers-types` entry in their local TypeScript configuration.
Names such as `workers-shared` alone are not platform evidence: review their
type/platform through the adoption map when configuration is inconclusive.
Browser-specific extension manifests and package-authored
`megamono.extension.manifests` declarations are also recognized without WXT.
Render service mappings remain reviewed decisions even when command evidence
suggests a project. The Basemarks-shaped regression fixture exercises these
cases while preserving repository-owned CI, release gates, and unrelated files.

When a repository-owned `render.yaml` is present, the inference module installs
`@megamono/nx-render`. That plugin attaches only explicitly rooted or mapped
services, preserves the Blueprint as deployment authority, and exposes bounded
build/start/pre-deploy targets plus health, resource, filter, and multi-instance
Next cache diagnostics. For a root-level service, the survey identifies exact
Nx project references in declared commands and proposes a copy-ready map; init
still requires the reviewed `serviceProjects` value through
`--renderServiceProjects='<json>'` and validates its project/root pairs before
updating `nx.json`.

On a real workspace, the same survey also separates committed toolchain
requirements from active Node and package-manager binaries. It reports whether
the host is mutation-ready and gives Corepack or repository-pin activation
guidance when it is not.

The packed mixed-platform adoption fixture exercises this flow against the Nx
22.2/TypeScript 5.9/pnpm 11 portfolio anchor used by established repositories:

```sh
npm exec nx -- run @megamono/plugin:e2e-portfolio-compatibility
```

Initialization writes `megamono.json`, adds the `megamono` and
`megamono-docs` projects, tags existing Nx projects, scaffolds the documentation
information architecture, and configures the shared agent-skills directory.
It also wires `@megamono/plugin/eslint` into the workspace flat config and emits
the scheduled repository-health issue workflow.

ESLint adoption (`workspace-init` and `playstack-lint`) locates the default-exported
flat-config array through JavaScript syntax, not formatting conventions. Semicolons
are optional; comments, multiline exports, nested arrays, and parenthesized arrays
are supported. Named config references and wrapper calls such as `defineConfig(...)`
are not automatically edited: the generator reports a conflict before writing.
Existing managed-section ownership checks still apply. Formatting-only changes to
Playstack lint sections are accepted; changes to their logic remain conflicts.

The plan preflights selected-module dependencies and peers before writing. It
retains compatible existing ranges, lists missing dependencies individually,
and refuses incompatible, duplicate, or non-semver declarations instead of
silently upgrading an adopted workspace.

### Verify a production runtime

Workspace initialization adds a generic `megamono:verify-runtime` target. It
inspects an existing JavaScript build and fails when an external package is
undeclared or available only through `devDependencies`:

```sh
npm exec nx -- run megamono:verify-runtime --project=api
npm exec nx -- run megamono:verify-runtime --project=api \
  --outputPath=dist/apps/api \
  --report=.megamono/runtime-api.json
```

The verifier never builds or changes dependencies implicitly. Build the project
first, and provide `--outputPath` when its build target does not declare one.
Extraction parses JavaScript syntax; quoted examples, comments, regex literals,
and locally shadowed `require` calls are not external dependencies. Static
imports/re-exports, global CommonJS `require`, Node `createRequire` bindings,
their `require.resolve` calls, and literal dynamic imports are
inspected, including executable expressions inside template literals. Malformed
JavaScript, non-literal module loads, or an empty output directory produce
`runtime-analysis-incomplete` errors, never a passing zero-file report. No audited
code is executed. This is bounded static analysis, not proof of production
resolution: custom loaders, evaluated code and dependency aliases still require
bundler/runtime evidence and a clean deployment install. Keep it advisory while
qualifying a repository's actual emitted output; do not suppress all missing
dependency findings to work around an unsupported loader.

#### Opt-in Webpack Node chunk evidence

For a completed, immutable Webpack 5 Node build, record the chunk graph and
SHA-256 hashes of **all** emitted JavaScript. In your existing build callback,
after checking `stats.hasErrors()` and completing writes:

```js
const { createWebpackRuntimeEvidence } = require('@megamono/plugin/webpack');
const { writeFile } = require('node:fs/promises');
const evidence = await createWebpackRuntimeEvidence({
  outputPath: absoluteBuildOutput,
  stats: stats.toJson({
    all: false,
    version: true,
    hash: true,
    errors: true,
    assets: true,
    chunks: true,
    ids: true,
  }),
});
await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
```

Then pass the workspace-relative evidence file:

```sh
megamono verify runtime api --outputPath=dist/apps/api \
  --webpackEvidence=.megamono/api-webpack-evidence.json
```

Keep the file with its build output, not as a reusable exception/allowlist. This
uses [Webpack compilation stats](https://webpack.js.org/api/stats/), not a copied
list of guessed chunk names. Failed/incomplete/multi-compilation stats are
rejected. Grouped stats must be configured to expose individual assets.

The supported shape is the unminified Webpack 5 synchronous Node `require`
chunk loader, with literal ensure IDs and a simple literal/concatenation/finite
map filename getter in the same runtime file. ID and content-hash filenames are
qualified by a real Webpack 5.105.2 packed-consumer fixture. Minified/custom
loaders, dynamic context IDs, HMR, cross-file runtime composition and unknown
dynamic imports remain unresolved; this is not blanket Webpack support.

Stale hashes, extra/missing JavaScript, symlink assets and invalid chunk paths
fail with `runtime-evidence-invalid`. Lazy chunks are still scanned for missing
production dependencies. The report records the compilation hash and number of
qualified loader sites. No app code is executed by verification. Evidence must
come from your trusted build pipeline; hashes identify bytes, not authorship or
a proof of arbitrary program behavior. Do not mutate/rebuild output concurrently.
Retain clean production installs and explicitly authorized container smoke tests.

Run `npm exec nx -- run @megamono/plugin:e2e-webpack-evidence` to exercise the
packed helper with real Node lazy loading. Its child-process smoke is not a
production-container or Fontstack deployment qualification.

The companion workspace audit checks pnpm/Corepack pins, active Node and pnpm,
workspace package membership, and known executables or preload modules used by
scripts:

```sh
npm exec nx -- run megamono:verify-dependencies
```

This catches dependencies supplied only by a sibling package or an accidentally
hoisted installation while leaving dependency correction to the repository.

Container definitions can be checked independently for frozen installs,
copied lock/workspace manifests, build stages, and a production dependency
installation:

```sh
npm exec nx -- run megamono:verify-container --dockerfile=apps/api/Dockerfile
```

The default check only reads the Dockerfile. Pass `--smoke` explicitly to run
`docker build` with the selected `--context`; Megamono never starts the built
container or performs an image build as part of the ordinary health check.
The adoption survey also maps nested Dockerfiles to their owning Nx project and
uses exact Nx command references for root Dockerfiles. Ambiguous container
ownership stays visible as a decision rather than becoming a guessed target.

### Generator availability

Integration and existing-email verification mappings resolve Nx's complete project
graph, including inferred Jest targets. Explicit workspace target overrides remain
authoritative. Graph failures stop planning; inferred targets are not copied into
repository configuration. Email adoption still requires non-cacheable verification
and preview targets—target discovery does not waive qualification policy.

`@megamono/plugin/availability.json` is the canonical registry for available,
fixture-gated, and reserved generator names. The published `generators.json`
and `executors.json` collections are produced with:

```sh
npm exec nx -- run @megamono/plugin:sync-collections
```

Only entries marked `available` are emitted. Programmatic callers can use
`getGeneratorAvailability` or `assertGeneratorAvailable` to return the stable
gate diagnostic for a gated or reserved name.

The published `content-lib` and `content-type` generators scaffold an internal
content-data project, generated-import path, cached build target, Playstack
transforms, and deterministic schema-backed document types. Their packed
Free-tier fixture consumes `@playstack/content` through yalc, builds the
generated project under npm and pnpm, and verifies stable reruns.

The published `playstack-lint` and `playstack-skills` generators follow the
same ownership rule. Lint adds the selected Playstack preset in warning mode;
skills installs the compatible CLI and corpus packages, then delegates all
file ownership, drift, and synchronization to `playstack skills sync`. Their
packed cross-repository fixture consumes Playstack through yalc and verifies
local-reference preservation, real lint and skill execution, ownership
separation, and stable reruns with npm and pnpm:

```sh
npm exec nx -- run @megamono/plugin:e2e-playstack-yalc
```

### Convert an existing application repository

After committing `nx init` on a non-default conversion branch, preview the
write-free plan and then rerun it with explicit acceptance:

```sh
npm exec nx -- generate @megamono/plugin:convert existing-app --dry-run --no-interactive
npm exec nx -- generate @megamono/plugin:convert existing-app --acceptPlan --no-interactive
```

Convert preserves existing package commands behind Nx `build`, `test`, `lint`,
and detected `deploy` targets, moves application-owned files through the Nx
virtual tree, initializes Megamono conventions in warning mode, and records the
conversion decision. Ambiguous root files require a `--resolutions` ownership
map. `--report=<path>` persists a repository-valid report whose body contains
the same Markdown analysis, while `--verify=build` adds application build and
test verification after the default configuration checks.

### Analyze a repository import

On a clean, non-default host branch, inspect a local or remote source without
changing either repository:

```sh
npm exec nx -- run megamono:import -- --source=../source-app --ref=main --name=source-app
```

Analysis resolves and prints the immutable source SHA, existing commands,
dependency conflicts, aliases, environment-variable names, and non-JS
surfaces. Embedded HTTP credentials are rejected and environment values are
never included in output. After approving the report, execute the supported
subtree path by repeating the resolved SHA and choosing the verification depth:

```sh
npm exec nx -- run megamono:import -- \
  --source=../source-app \
  --ref=main \
  --name=source-app \
  --expectedSourceSha=<full-sha> \
  --history=subtree \
  '--resolutions.aliases.@source/shared/*=@source-app/shared/*' \
  --resolutions.environment.SHARED_TOKEN=SOURCE_APP_SHARED_TOKEN \
  --verify=build \
  --execute
```

Execution creates a history-graft commit, integrates package and Nx metadata,
records an accepted decision and completion marker, installs from the root,
and commits the integration only after validation. A failed command leaves the
graft and working tree intact with `MEGAMONO-RECOVERY.md`; a completed import
rerun is a zero-write success. Source documentation routes into the centralized
host corpus; existing repository records preserve their IDs and dates, while
plain Markdown receives valid internal metadata. Source workflows, agent files,
repository configs, and nested lockfiles are preserved under the import marker
without becoming active host configuration. All routes and collisions appear in
analysis before the graft, including the exact files an approved alias or
environment rename will change. Rewrites are restricted to source-owned config,
module specifiers, and explicit environment-reference syntax; their scope is
recorded in the accepted decision and completion marker. Relative imports among
app-owned files retain their topology under the destination. Imports into source
documentation or repository infrastructure that will be routed elsewhere are
blocked before the graft. Imports of packages already owned by target Nx
projects become an explicit graph contract that is checked after installation
and recorded in the completion marker. Subtree preserves the source graph with
its original SHAs, filter-repo rewrites the graph beneath the staging prefix,
and squash carries only the approved snapshot. Filter-repo requires a compatible
`git-filter-repo` executable on `PATH`; squash additionally requires
`--allow-history-loss`.

#### Import a workspace with several projects

Use a reviewed Nx target configuration for the structured `monorepo` option.
For example, add a named configuration under the existing `megamono:import`
target in `tools/megamono/project.json` (or wherever that project lives):

```json
{
  "configurations": {
    "sdk-workspace": {
      "source": "../sdk-workspace",
      "name": "sdk-workspace",
      "destination": "libs/imported-sdk",
      "history": "subtree",
      "verify": "build",
      "monorepo": {
        "projects": {
          "packages/sdk": { "action": "reuse", "project": "existing-sdk" },
          "packages/email": {
            "action": "import",
            "name": "email",
            "configuration": {
              "projectType": "library",
              "tags": ["platform:node", "scope:shared", "type:util"],
              "targets": {
                "build": {
                  "executor": "nx:run-commands",
                  "options": {
                    "command": "node build.cjs",
                    "cwd": "libs/imported-sdk/packages/email"
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Commit that configuration before analysis; the host branch must be clean.
Run `npm exec nx -- run megamono:import:sdk-workspace` to inspect it, then repeat
with `--expectedSourceSha=<reported-full-sha> --execute` after approval. The map
must cover every static source project. `reuse` requires the same package
identity and compatible versions; alternatively use `action: "import"` with a
new `name` and `packageName` to retain a renamed implementation.

The common destination preserves the source's internal directory layout.
Reviewed targets must account for the new workspace root and retain existing
tests/lint. Source Nx plugins and root scripts are not installed as a second
workspace. Every imported project must build, and its expected graph edges must
exist before the integration commit. Reused duplicates are removed only from
the grafted copy and remain recoverable in Git history. TypeScript references
to host projects are redirected; aliases/relative imports into discarded
duplicates fail preflight. Complex workspace selectors and inference-only
source projects require static declarations first.

### Validate a workspace

The docs module (also used by `docs-init` and new-workspace setup) seeds a
repository-owned visual handoff in `docs/design/`: `README.md`, `manifest.md`,
`boards/`, and `screenshots/`. Keep `docs/DESIGN.md` as the concise design brief.
Add `tokens.json` only when useful, with an explicit source-of-truth or export
relationship to your theme. Existing assets are preserved, custom docs roots
are supported, and design assets need no lifecycle frontmatter. The survey
lists them separately; the active docs index links to the handoff README.
Megamono does not compile tokens or automatically publish these references.

```sh
npm exec nx -- run megamono:check
npm exec nx -- run megamono:check --ci
npm exec nx -- run megamono:check --profile=migration
npm exec nx -- run megamono:check --profile=release
npm exec nx -- run megamono-docs:validate
npm exec nx -- run megamono-docs:index
npm exec nx -- run megamono-docs:index --check
npm exec nx -- run megamono-docs:archive --id=<id> --status=<terminal-status> --dry-run
npm exec nx -- run megamono-docs:prune-reports
npm exec nx -- run megamono-docs:health
```

Health checks cover npm, Expo SDK, SwiftPM, and Cargo dependency alignment,
spec drift, stale plans, orphaned libraries, and integration-template drift.
The existing `dependency-alignment` family also reports undeclared static/dynamic
workspace imports for named package projects; a root-hoisted dependency or path
alias does not declare ownership in the importing package. Unnamed classic
projects and installed/Yalc graph copies are excluded from this package check.

For each application, health compares React, Chakra and Emotion installations
across its static/dynamic project closure. Different real installation paths can
produce an advisory even when versions match; symlinks to one installation are
deduplicated, and separate application runtimes are not conflated. The optional
`dependencyInspection` report resolves package entries without executing their
JavaScript or falling back to ambient `NODE_PATH`. Missing or malformed evidence
makes coverage partial. Installed Node resolution is not proof of browser bundle
duplication, so `runtimeAssessment` remains `not-assessed`. Health also reports a
library that declares React, Chakra or Emotion in `dependencies` without a matching
peer. These health findings do not change structural checker severity or warning
budgets. `megamono:check` prints the same dependency findings as
`workspace-dependencies` warnings; they never fail the check and are not counted
by adoption ratchets or warning baselines.

A `platform:web`/`type:ui` library generated in a workspace that already uses
Chakra (recorded web styling, or a root/project manifest declaring
`@chakra-ui/react`) declares `@chakra-ui/react` and `@emotion/react` as peers and
development dependencies alongside React, matching the versions the workspace
already uses.

Plan merge status uses a resolved integration branch, never the current `HEAD`.
An explicit Nx `defaultBase` (or Nx's older `affected.defaultBase`) selects that
branch, including the Nx preset/root overlay; otherwise health uses locally available
`origin/HEAD`, then conventional
`main`/`master` refs. It does not fetch or guess from the checkout. An explicit
missing base does not silently fall back. A plan naming the integration branch
itself remains active. Checked-out or detached feature branches are reported
merged only when their commit is actually an ancestor of the integration tip.
Symbolic branch aliases are resolved to their actual target before comparison.
Merged-branch findings include the selected base ref as evidence. Unavailable
base/history or ancestry errors produce partial stale-plan coverage, while
reliable timestamps and missing-branch observations remain available. Shallow
history cannot establish a complete unmerged classification.

For Render-inferred services that depend on a registered Prisma project, health
also checks for build-time client generation and a schema/config-specific
`prisma migrate deploy` pre-deploy step. Dependency traversal includes shared
persistence libraries. Missing steps and roots that exclude shared database
inputs appear as `render:prisma-*` findings under `spec-drift`, even when the
docs module is not adopted. Existing report-only/fail-on-findings behavior is
unchanged. This is bounded static evidence, not a database readiness certificate:
custom shell wrappers or deployment scripts that cannot be verified are reported
with reduced confidence and need independent qualification or a reviewed,
decision-backed suppression. Checks never execute migrations. Keep migration SQL
review, backups, deployment credentials, and release approval in the release
process; generation belongs in the build, not the isolated pre-deploy instance.
Findings are written deterministically to `.megamono/health.json`.
Structural and health checks exclude inferred projects inside `.yalc` or
`node_modules`, including nested copies. Those are installed dependencies, not
repository-owned projects. Root/consumer manifests still receive dependency and
package-source policy checks; real untagged or unused libraries remain visible.
`workspace:*`, `workspace:^`, and `workspace:~` are treated as one current local
dependency only when a unique versioned workspace package exists. Their distinct
packed publication ranges are preserved; aliases and unresolved references are
not assumed to resolve. See [pnpm's workspace protocol](https://pnpm.io/workspaces#workspace-protocol-workspace).
Package-source profiles keep local evaluation separate from publication policy.
`development` permits local references, `migration` reports them as warnings,
`ci` rejects them except for exact fixture locators approved in
`megamono.json`, and `release` rejects every local reference. CI and release
also require the selected manager's lockfile. `--ci` remains an alias for the
`ci` profile, and `CI=true` selects it when no profile is passed.

### ESLint rules

The `@megamono/plugin/eslint` flat-config export provides
`docs-visibility-boundary`, `no-deep-relative-imports`, `platform-boundary`,
and `no-bare-jsx-strings`. Public applications may import repository docs only
from `content-collections/public-repo-docs`; unrestricted entry points remain
available to internal applications.
`workspace-init` reads their configured severities from `megamono.json`.

`no-bare-jsx-strings` checks inline JSX literals; message-catalog expressions and
localization calls are application-owned, and passing this rule does not establish
translation completeness. It neither supplies `t()` nor installs an i18n package.
Spec/test files and `__tests__` directories are skipped by default. Additional
dev/story exclusions use gitignore-style patterns relative to the lint working
directory; set `ignoreTests: false` to check tests too:

```js
{
  rules: {
    'megamono/no-bare-jsx-strings': ['warn', {
      ignorePatterns: ['**/dev/**', '**/*.stories.tsx'],
      ignoreTests: true,
    }],
  },
}
```

`platform-boundary` treats Next.js Pages Router API routes, `_document`,
server-only data functions and helpers reached only from them, plus App Router
route handlers (`app/**/route.ts` without `runtime = 'edge'`), as Node code.
Spec/test files run under Node when they start with an explicit
`@jest-environment node|jsdom` docblock or a `@vitest-environment
node|jsdom|happy-dom` comment. Node-only tooling inside a browser project, such
as a library's `scripts/`, is declared per project with gitignore-style
`nodeFiles` paths relative to that project's root. Files a Next.js page reaches
keep their browser platform, and extension runtime contracts still apply:

```js
{
  files: ['**/*.ts'],
  rules: {
    'megamono/platform-boundary': ['error', { nodeFiles: ['scripts/**'] }],
  },
}
```

React Hooks rules are explicit for existing React projects. Install
`eslint-plugin-react-hooks` in the workspace and compose a project-local config:

```js
import baseConfig from '../../eslint.config.mjs';
import megamonoPlugin from '@megamono/plugin/eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default megamonoPlugin.withReactConfig(reactHooks, [...baseConfig], {
  files: ['src/**/*.{js,jsx,ts,tsx}'],
});
```

`createReactConfig(reactHooks, { files })` returns one flat entry;
`withReactConfig` appends the installed recommended preset, preserves existing
configuration and reuses a single existing Hooks plugin instance. Conflicting
instances fail for review. Later flat entries can override severities/options.
Without `files`, the explicit API selects JSX/TSX files only. Fresh web/site and
`platform:web`/`type:ui` library generators add project-scoped rules including
`.ts` custom hooks and the qualified dependency when absent. Existing projects,
non-React code and Expo lint configuration are not migrated automatically.

Tauri applications with `src-tauri/Cargo.toml` and a Tauri configuration retain
one Rust host platform tag. Surveys identify the hybrid composition. Aggregate
Nx edges may reference Rust, web and Node libraries; source-level ESLint keeps
the frontend web-only and recognizes only root-level Vite, Vitest, Playwright
and ESLint configuration files as Node tooling. Nested lookalike configuration
files do not gain Node access. Keep both graph and source checks enabled; this
does not disable translation/string rules or change a repository's warning budget.
Tests named `*.spec.*` or `*.test.*` with a leading Jest environment docblock
explicitly selecting `node` or `jsdom` may import Node built-ins (for example,
Web Crypto polyfills). Production files and unqualified/browser tests do not
receive that allowance. Cross-project imports still follow the application platform.

### Create repository records

```sh
npm exec nx -- generate @megamono/plugin:docs-spec <project> "<title>"
npm exec nx -- generate @megamono/plugin:docs-plan <project> "<title>"
npm exec nx -- generate @megamono/plugin:docs-decision "<title>" --project=<project>
npm exec nx -- generate @megamono/plugin:docs-research "<title>" --project=<project>
npm exec nx -- generate @megamono/plugin:docs-audit <target> --project=<project> --spec=<spec-id>
```

Record generators default to internal visibility, validate controlled topics before
writing, and are no-ops when rerun with identical inputs. Help describes required
versus inferred options. Documentation project namespaces may describe planned
work; they are not limited to existing Nx projects. Topics come from the built-in
vocabulary plus `megamono.json` `topics.extend`. Invalid lists, unknown topics and
unresolved references fail before a new record is written.

New docs/content dependencies use `zod: ^4.6.5`, sharing the qualified Playstack
validation floor. Existing declarations must fit wholly within that range;
`>=4.1 <5` is broader and requires explicit review/update even if today's installed
version is compatible. Adoption reports the conflict before writes and does not
silently narrow an existing dependency declaration.

New workspaces use qualified exact toolchain pins; existing-workspace adoption
has a separate compatibility contract and preserves supported repository choices.
Core survey and platform-neutral adoption are not restricted by host OS;
individual platform capabilities retain their own gates. See
[`compatibility.json`](./compatibility.json) for current ranges, scaffold pins and
tested anchors rather than inferring platform SDK support from the core range.

In CI and release profiles, package-source checks inspect dependency fields plus npm/Yarn
`overrides` and `resolutions`, package-level pnpm overrides/catalogs, and
`pnpm-workspace.yaml` overrides/catalogs. Yalc, links, portals, local package
directories, missing archives, and paths escaping the repository fail closed.
A repository-contained `.tgz` whose filename carries an exact semantic version
is accepted by the CI profile; the release profile still requires registry
resolution. CI-only fixture exceptions use an exact
`<manifest>#<dependency-location>` locator, such as
`package.json#devDependencies.@megamono/plugin`, and do not weaken release.

A CI job that deliberately installs a subset of the workspace (for example
`pnpm install --filter=!@acme/api`) can pass the same omission to the checker:

```sh
pnpm exec nx run megamono:check --profile=ci --excludeProjects=acme-api,acme-api-e2e
```

Local addresses in an excluded project's manifest, and override or catalog
entries that the committed `pnpm-lock.yaml` reaches only through excluded
importers, are then reported as `package-sources-excluded-project` warnings
instead of profile errors. An override that any included importer still reaches
remains an error, an unreadable lockfile disables the scoping, unknown project
names fail the check, and the `release` profile rejects exclusions. Structural,
tag and boundary checks still cover every project.

### Develop the plugin

```sh
npm exec nx -- run @megamono/plugin:typecheck
npm exec nx -- run @megamono/plugin:test
npm exec nx -- run @megamono/plugin:lint
npm exec nx -- run @megamono/plugin:build
```

### Prisma installation policy

When adding or relocating a Prisma project, pnpm 11 workspaces (and earlier
workspaces using `allowBuilds`) must have explicit build-script decisions for `prisma` and
`@prisma/engines` in `pnpm-workspace.yaml` before the generator writes files.
Review each package and set its decision to `true` to permit its scripts or
`false` to deny them. Unresolved pnpm placeholder values are not approvals.
Package-wide decisions and exact-version lists matching the selected Prisma
specifier are supported. A dependency range does not establish a resolved
version in this read-only plan. The generator preserves the policy, including
denials; denied scripts require separately provisioned artifacts and Prisma generation checks.
Neither `--yes` nor `--bootstrap` silently approves dependency scripts.

`create-megamono` configures these bounded approvals in its new staging workspace
when Prisma is selected. Existing-schema adoption without installation leaves
policy qualification to the repository. Relocation reuses existing dependency
specifiers and checks decisions without changing them. Legacy pnpm 8–10 policies
without `allowBuilds` remain repository-owned.

### Prisma relocation handoff

Database relocation plans distinguish automatic schema/command edits from pending
application work. They list detected `@prisma/client` source references and
deployment files for review, identify the generated-client export boundary, and
require consumer builds plus isolated container/migration qualification. Detection
is advisory, not exhaustive. Configuring `clientOutput` does not implement exports,
rewrite application imports, generate the client, or qualify runtime assets.
Relocation preserves model timestamp annotations and project identity; incoming
artifacts and non-UTC timestamp behavior require separate review.

### Upgrading cached workspace checks

Rerun the reviewed `workspace-init`/`adopt --write` plan to add all supported root
lockfiles, package-policy configuration, and the `CI` environment input to
`megamono:check`. Only an unchanged managed `core.project` is upgraded; existing
inputs, options, and unrelated targets are retained. Modified, ejected, or
repository-owned project configurations are left alone and require manual review.
Inspect the dry run first; this is not permission to replace custom CI workflows.

These inputs track declared package policy, not every change in ignored installed
trees or host tools. After a same-version Yalc refresh or host-toolchain change,
run an uncached check and the separate uncached health/package diagnostics. Cache
hits are not installation or runtime qualification.

### Application-scoped integration records

Integration ledgers now use `package:integration@<URL-encoded-application-root>`
keys. `.megamono/playstack-integration-plans.json` indexes independent plan
snapshots by those keys; `.megamono/playstack-integration-plan.json` remains a
latest-invocation compatibility view, not the inventory of every application.
Rerunning one application's integration preserves the other applications' plans,
stages, and evidence. Transition arguments and receipt integration names retain
their package-authored IDs; receipt fingerprints already bind the application root.

An older unscoped ledger record moves to a scoped key only when its fingerprint
matches the selected application exactly. Ambiguous or changed legacy records
fail before writes: reconcile the original application/evidence first rather than
assigning another application's qualification to the new root.

### Pilot health scope

When adoption explicitly excludes docs, health skips corpus validation,
specification coverage, and stale-plan checks and reports that reduced scope.
Dependency, infrastructure, managed-artifact, ratchet, and orphan checks remain
available. Decision-backed suppressions require docs adoption and fail closed
without it. Workspaces with older, empty adoption metadata retain full-health
behavior; adopting docs still requires a valid corpus.

### Local inference adoption

`megamono adopt --write --profile=pilot --local-packages=yalc` forwards local
distribution selection to workspace initialization. Before changes, the generator
checks the store for selected Apple, Cargo, Cloudflare, Render, and extension
plugins and their required internal Megamono dependencies/peers. Dry runs only
print that closure. Approved runs add it through Yalc after files are flushed,
then install dependencies; internal runtime edges use the local closure rather
than silently falling back to registry packages. Optional provider peers are not
automatically selected. Surveys do not install or register these packages.

</details>
