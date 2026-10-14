# Megamono

Megamono is an Nx-based toolkit for creating, adopting, and governing polyglot monorepos.

## Packages

- `create-megamono` — interactive and non-interactive workspace scaffolding
- `@megamono/cli` — global `megamono` dispatcher for existing workspaces
- `@megamono/plugin` — workspace initialization, governance, documentation, and health tooling
- `@megamono/nx-apple` — Apple and SwiftPM project inference and generators
- `@megamono/nx-cargo` — Cargo and Rust project inference
- `@megamono/nx-cloudflare` — Cloudflare Worker project inference and generators
- `@megamono/nx-extension` — WXT browser-extension inference and generators
- `@megamono/nx-laravel` — Laravel project inference and generators
- `@megamono/nx-phpnative` — NativePHP application generation and inference
- `@megamono/nx-render` — Render Blueprint inference and deployment preflight

## Native Android applications

Add a Kotlin/Jetpack Compose app to an initialized workspace:

```bash
megamono add app android --yes
megamono add app android --name=reader --displayName="Reader" --applicationId=com.example.reader --yes
```

The default root is `apps/android`; named instances use `apps/<name>`. For a new
workspace, select Android in the app picker or pass `create-megamono studio android`
(multiple instances work as `android:reader android:admin`). This is a native
Android preset, separate from Expo's `mobile` preset, and ships in `@megamono/plugin`.
JDK 17 and Android SDK 36/build tools 35.0.0 are needed for the generated build,
test, lint, and device-install targets. Generation itself is offline. The existing
`create-megamono` host support remains macOS/Linux; generated Gradle projects and
the Java launcher support Windows paths as well, with cross-host CI qualification.

## Development

Use Node 24 and npm 11.21.0 to maintain this repository. CI pins npm explicitly
because npm 10 does not interpret this lockfile consistently. Consumer fixtures
still exercise the supported Node and package-manager ranges.

Install dependencies and run tasks through the workspace Nx CLI:

```bash
npm install --global npm@11.21.0
npm ci
npm exec nx -- run-many -t build
npm exec nx -- run-many -t test
npm exec nx -- run-many -t lint
```

Inspect the project graph with:

```bash
npm exec nx -- graph
```

## Compatibility

New workspaces use pinned Node 24, npm 11 by default (or an explicitly selected
pnpm, Yarn, or Bun baseline), Nx 23.1, and TypeScript 6. `megamono init`
preserves existing npm 9–11, pnpm 8–11, Yarn 1.22–4, or Bun 1.x workspaces on
Node 18.18–24, Nx 17–23, and TypeScript 5.2–6. Read-only survey remains
available when mutation toolchains are not ready. Apple, Cargo, Cloudflare, extension, and Render inference plugins require Nx 18 or newer. CI verifies
packed packages against every supported Nx major and monitors `nx@next` in a
non-blocking canary.

## Local package validation

Build and publish every Megamono package to yalc, then run the local CLI from this checkout:

```bash
npm run yalc:publish
npm exec -- create-megamono <name> \
  --directory=../<name> \
  --local-packages=yalc
```

The guided flow selects applications, a named database adapter, web styling for
the app-owned onboarding billboard, optional local services, and finally whether
Springbar should configure the requested apps and services. Chakra is suggested
for a new workspace, while Emotion, Tailwind, Panda, StyleX, CSS Modules, and
inline styles are supported without becoming governance requirements. Automation
can provide the same decisions with positional `type`/`type:name` app descriptors
or the backward-compatible `--apps` list, plus `--styling`,
`--database-adapter`, `--database-name`, `--services`, and `--service-runner`.
`--springbar` is the concise opt-in alias for `--service-runner=springbar`.
Springbar owns the generated configuration; setup never starts services.

In a terminal, use arrow keys and Enter for the package manager, database
adapter, styling, router, and service runner. Services use a checkbox list:
Space toggles an option and Enter continues (an empty selection is allowed).
Applications use a repeatable list: select **Add application**, choose its type,
and enter a name (prefilled with the type). Add multiple instances of the same
type, edit their types/names, or remove them before continuing. The list shows
each app's directory. Repeated types suggest an unused name such as `extension-2`;
invalid names and duplicate directories can be corrected in the prompt.
You can also continue without applications. The next step offers **Set up
publishable packages?**, suggested on when there are no apps and off otherwise.
Add named TypeScript libraries (for example `core` and `client`), choose an npm
scope, and select restricted or public access. Restricted is the default. Nx
creates buildable libraries under `packages/<name>` with package exports;
Megamono discovers them when configuring release governance. These starters
are tagged for Node; review platform boundaries when targeting other runtimes.
Nothing is published during creation. Registry access, credentials, and the
release workflow still require review before publishing. Existing private app
support libraries are not converted into publishable packages.

For packages only, use `create-megamono toolkit --packages=core,client
--package-scope=acme --package-access=restricted --local-packages=yalc
--package-manager=pnpm --interactive=false`. Add `--apps=api` to combine packages
and apps, or `--apps= --packages=` for an empty governed workspace. The selected
package manager is independent of package publication access. Custom registries
can be configured afterward in repository-owned npm/publish configuration.

Positional `type:name` descriptors
and `--apps` remain available for scripts and skip the interactive app list.
Database names remain editable text. Flags skip their corresponding questions;
use `--interactive=false` for automation. Ctrl+C cancels before creation begins.

For existing initialized workspaces, use `megamono add springbar --dry-run`
to inspect candidates, then `megamono add springbar
--springbar-candidates=<names> --yes` to apply. `megamono init --springbar`
combines initial governance adoption with the same optional setup. Existing
`springbar.toml` files are preserved, and ambiguous candidates require explicit
selection. Springbar's MCP server and daemon must be available; Megamono does
not install Springbar or write an unvalidated fallback manifest.

```bash
create-megamono commune \
  site:marketing \
  extension:extension-grids \
  extension:extension-guides \
  api \
  web:admin \
  web
```

A bare type keeps the quick default name (`web` creates `apps/web`). A named
descriptor creates another instance (`web:admin` creates `apps/admin`), so any
application type can be repeated without adding one-off plural flags.

Install both global development commands from their yalc artifacts:

```bash
npm run yalc:install-clis
command -v create-megamono
megamono --version
```

Initialize an existing Nx workspace with its yalc-linked local plugin:

```bash
yalc add @megamono/plugin --dev --no-pure
pnpm install
# Commit the local dependency link so workspace-init starts from a clean tree.

megamono init --survey --local-packages=yalc
megamono init --local-packages=yalc
```

The local-package mode requires the exact compatible versions of `@megamono/plugin` and any selected platform plugins to exist in the yalc store before workspace creation begins.

New pnpm workspaces receive a bounded `allowBuilds` policy before plugin or
application installation. Selecting Prisma also approves `@prisma/engines` and
`prisma`; other database selections do not receive those approvals. Existing
explicit decisions are retained, and build-script protection is not disabled.

Bootstrap verification uses the same explicit database project ID as generation
(`<scope>-<adapter>-<name>`). Formatting uses `nx format:write --all` because the
staging workspace has no Git history. Managed Prettier exclusions preserve Yalc
package bytes and package-manager lockfiles, independently of whether the
repository chooses to commit those files.

## Public validation releases

All ten packages publish publicly from `megamono-dev/megamono`. The manual release workflow derives publication behavior from a protected channel rather than accepting independent access, prerelease, or dist-tag values:

- `next` publishes `X.Y.Z-next.N` packages to npm's `next` dist-tag from `main` or a `release/*` branch and creates a GitHub prerelease.
- `latest` publishes stable packages to npm's `latest` dist-tag from `main` only and creates the latest GitHub release. Promotion requires a clean checkout, matching published npm `next` versions, and a source tree identical to each package's registry-reported `gitHead`. Missing revision history or changed source requires another evaluated `next` release first.

The fixed `megamono` release group contains the nine `@megamono/*` packages. `create-megamono` retains an independent version and tag while participating in the same guarded workflow. The workflow serializes every channel, reruns packed consumer fixtures, derives first-release behavior from Git tags, and publishes with npm trusted publishing rather than a long-lived token.

Create protected GitHub environments named `npm-next` and `npm-latest`. Permit `main` and `release/*` for `npm-next`; permit only `main` and require reviewers for `npm-latest`. Configure each npm package's trusted publisher for organization `megamono-dev`, repository `megamono`, and workflow `release.yml`. Leave the npm publisher's environment field unset so the one publisher can serve both protected GitHub environments.

Run `npm run release:check` and `npm run release:test` to verify registry, public access, repository metadata, MIT licensing, npm listing metadata, package documentation, release groups, channel/ref guards, and stable-promotion behavior locally. Packed-package validation also requires each tarball to include its license and README. Run
`npm run release:check-publishing` to verify the live GitHub visibility and
environment protections against `tools/publishing-policy.json`. The release
workflow runs this check before versioning.

The repository is public. `npm-next` allows `main` and `release/*`; `npm-latest`
allows only `main` and requires `ryanhefner` to review the deployment. Self-review
is allowed for this single-maintainer workflow; add a second maintainer before
enabling GitHub's prevent-self-review option.

The release workflow versions manifests without immediately committing or tagging,
synchronizes internal Megamono pins in both compatibility registries, rebuilds and
checks exports, then commits and tags the coherent release. Do not publish a
manually versioned package without also synchronizing its scaffold pins.

### First publication and npm trust

The packages must exist on npm before their trusted publishers can be registered.
For the first publication, add a short-lived granular npm token as the
`NPM_BOOTSTRAP_TOKEN` environment secret in GitHub's `npm-next` environment.
Grant it package publish permissions covering the new `@megamono/*` packages and
`create-megamono`, with bypass 2FA enabled for unattended publication. Organization
management permissions alone do not grant package publishing access. Revoke the
token after configuring and validating trusted publishing.

The release workflow checks this credential before versioning. It exposes the
token only to first-release authentication and publication steps; subsequent
releases use OIDC. Both paths publish with provenance from the public repository.
The GitHub environments `npm-next` and `npm-latest` are already configured.
`GITHUB_TOKEN` and OIDC credentials are supplied automatically by GitHub.

Dispatch the initial prerelease from clean, synchronized `main` after successful
CI, native-execution, and supported Nx compatibility checks. The example initial
version is `0.1.0-next.0` for all ten packages:

```sh
gh workflow run release.yml --ref main -f channel=next -f specifier=0.1.0-next.0
```

For `next`, the workflow checks release policy, builds, tests, lints, and validates
packed exports before publishing. After publication it verifies all ten exact
registry versions, dist-tags, source revisions, and tarball exports. It then runs
all thirteen packed-consumer gates, followed by the complete app-selection matrix
and five production/browser cases using packages installed from public npm.
Consumer verification never publishes to public npm.
The GitHub prerelease is created only after these checks pass; stable promotion
requires that completed prerelease and its matching source revision. Stable
releases retain full pre-publication qualification and check published artifacts
plus representative registry consumers afterward.

`npm run release:qualify` and the manual `Release qualification` workflow still
run the full pre-publication suite using isolated local registries. They do not
require packages to exist on public npm. To repeat public consumer verification
from the exact release checkout, run:

```sh
RELEASE_CHANNEL=next npm run release:verify-published
```

These fixtures require macOS with Xcode, Rust/Cargo, and `git-filter-repo`, just
like the release workflow. The release workflow synchronizes both scaffold
compatibility registries when versions change.

If publication stops partway through, download the `release-state` artifact. Its
Git bundle preserves the release commit and tags even if they have not been
pushed yet. Inspect each package's exact registry version and finish the missing
publications from that recorded checkout. Never reset a published version or
reuse it for different bytes. If post-publication consumer checks fail, the
release commit and tags are already pushed, but no GitHub prerelease is created;
fix the problem and publish a new `next` version before stable promotion.

Register the publisher for every package with the authenticated npm CLI. Review
any existing configuration with `npm trust list <package> --json` first; preserve
matching publishers and investigate conflicting entries before changing them.
For each of the ten package names, run:

```sh
npm trust github <package> --repository=megamono-dev/megamono --file=release.yml --allow-publish --yes --registry=https://registry.npmjs.org
npm trust list <package> --json --registry=https://registry.npmjs.org
```

The publisher must allow direct `npm publish`, not just staging, and its
environment remains unset to serve both protected channels. npm now supports
multiple publishers; this repository intentionally uses one workflow publisher
per package. Configure it immediately before the first OIDC `next` release:
unvalidated configurations expire after two days. Verify that release succeeds
with provenance before promoting to `latest`. See npm's
[trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) and
[CLI trust reference](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## Specifications

The canonical implementation specifications live in [`docs/specs/megamono`](docs/specs/megamono).
