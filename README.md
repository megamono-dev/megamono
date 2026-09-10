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
- `@megamono/nx-render` — Render Blueprint inference and deployment preflight

## Development

Install dependencies and run tasks through the workspace Nx CLI:

```bash
npm install
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

## Public validation releases

All eight packages publish publicly from `megamono-dev/megamono`. The manual release workflow derives publication behavior from a protected channel rather than accepting independent access, prerelease, or dist-tag values:

- `next` publishes `X.Y.Z-next.N` packages to npm's `next` dist-tag from `main` or a `release/*` branch and creates a GitHub prerelease.
- `latest` publishes stable packages to npm's `latest` dist-tag from `main` only and creates the latest GitHub release. Promotion requires a clean checkout, matching published npm `next` versions, and a source tree identical to each package's registry-reported `gitHead`. Missing revision history or changed source requires another evaluated `next` release first.

The fixed `megamono` release group contains the seven `@megamono/*` packages. `create-megamono` retains an independent version and tag while participating in the same guarded workflow. The workflow serializes every channel, reruns packed consumer fixtures, derives first-release behavior from Git tags, and publishes with npm trusted publishing rather than a long-lived token.

Create protected GitHub environments named `npm-next` and `npm-latest`. Permit `main` and `release/*` for `npm-next`; permit only `main` and require reviewers for `npm-latest`. Configure each npm package's trusted publisher for organization `megamono-dev`, repository `megamono`, and workflow `release.yml`. Leave the npm publisher's environment field unset so the one publisher can serve both protected GitHub environments.

Run `npm run release:check` and `npm run release:test` to verify registry, public access, repository metadata, release groups, channel/ref guards, and stable-promotion behavior locally.

The release workflow versions manifests without immediately committing or tagging,
synchronizes internal Megamono pins in both compatibility registries, rebuilds and
checks exports, then commits and tags the coherent release. Do not publish a
manually versioned package without also synchronizing its scaffold pins.

## Specifications

The canonical implementation specifications live in [`docs/specs/megamono`](docs/specs/megamono).
