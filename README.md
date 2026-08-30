# Megamono

Megamono is an Nx-based toolkit for creating, adopting, and governing polyglot monorepos.

## Packages

- `create-megamono` — interactive and non-interactive workspace scaffolding
- `@megamono/cli` — global `megamono` dispatcher for existing workspaces
- `@megamono/plugin` — workspace initialization, governance, documentation, and health tooling
- `@megamono/nx-apple` — Apple and SwiftPM project inference and generators
- `@megamono/nx-cargo` — Cargo and Rust project inference
- `@megamono/nx-cloudflare` — Cloudflare Worker project inference and generators

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

New workspaces use the pinned Node 24, package-manager 11, Nx 23.1, and
TypeScript 6 scaffold. `megamono init` supports existing workspaces on Node
18.18–24, npm 9–11 or pnpm 8–11, Nx 17–23, and TypeScript 5.2–6. Apple,
Cargo, and Cloudflare inference plugins require Nx 18 or newer. CI verifies
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

The guided flow selects applications, a named database adapter, optional local
services, and finally whether Springbar should configure the requested apps and
services. Automation can provide the same decisions with `--apps`,
`--database-adapter`, `--database-name`, `--services`, and `--service-runner`.

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

## Private validation releases

The `@megamono/cli`, `@megamono/plugin`, `@megamono/nx-apple`, `@megamono/nx-cargo`, and `@megamono/nx-cloudflare` packages initially publish as restricted npm packages from `megamono-dev/megamono` under the `next` dist-tag. Their names remain unchanged when promoted to public npm. The unscoped `create-megamono` entry package is versioned separately and held until public promotion because npm does not support restricted unscoped packages.

Run `npm run release:check-private` to verify registry, access, repository, and Nx release-group policy before publishing.

## Specifications

The canonical implementation specifications live in [`docs/specs/megamono`](docs/specs/megamono).
