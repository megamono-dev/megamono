# `@megamono/cli`

Global command dispatcher for adopting Megamono in an existing Nx workspace.

```sh
npm install --global @megamono/cli
megamono adopt
megamono adopt --survey --local-packages=yalc
megamono adopt --profile=pilot --dry-run
megamono adopt --only=health,inference,lint --write --yes
```

`megamono adopt` is the mature-workspace spelling of the same initializer. It
defaults to the write-free survey; `--dry-run` prints the exact operation and
commit plan, while `--write` enables an explicitly accepted mutation. The
survey includes a capability assessment covering detected repository behavior,
the Megamono equivalent, compatible-as-is systems, importable configuration,
planned files, and conflicts that still require a decision. `megamono init`
remains available for direct orchestration and automation compatibility.

`minimal`, `pilot`, `platform`, and `full` adoption profiles are forwarded to
the local plugin. `pilot` is the mature-workspace path for lint, health, and
inference without claiming existing CI or release workflows. Every profile
expands to the same independently runnable modules as `--only`, and the plan
includes suggested commit boundaries without staging or committing files.

The target workspace needs a local Nx installation. A survey uses the local
`@megamono/plugin` when available; otherwise the CLI stages a matching plugin
and Nx runtime in a disposable directory from the selected registry or Yalc
source. This does not change the repository. `--write` still requires the
plugin to be installed as a workspace development dependency.

Initialized workspaces expose composable verification without requiring users
to remember executor target names:

```sh
megamono health --profile=development
megamono health --profile=ci
megamono verify runtime api --outputPath=dist/apps/api
megamono verify dependencies
megamono verify container --dockerfile=apps/api/Dockerfile
```

These commands delegate to `megamono:check`, `verify-runtime`,
`verify-dependencies`, and `verify-container` respectively. Container
verification remains static unless `--smoke` is explicitly passed.

Hosted authentication is optional and independent of repository discovery:

```sh
megamono auth login
megamono auth status
megamono account list
megamono account use commune
megamono auth logout
```

Login opens `app.megamono.com` in the browser and uses the Playstack public
client's S256 PKCE and loopback callback flow. Credentials are stored with
user-only permissions under the Megamono configuration directory. A user may
belong to personal and organization accounts; switching accounts rotates the
session and scopes later hosted operations to that account. For a local
Springbar environment, pass `--service-url=https://app.megamono.test` or set
`MEGAMONO_SERVICE_URL`. Structural commands never require a login.
Hosted auth commands require Node.js 20 or newer; this does not narrow the
Node.js 18.18 baseline for repository-only CLI operations.

During the private-package validation phase, install the optional
`@playstack/client-auth` peer alongside the CLI (or link both through Yalc).
Once that client package is public, ordinary package-manager installation owns
the peer in the same way.
`npm run yalc:install-cli` installs the matching peer globally when it is
available in the local Yalc store and otherwise leaves core commands usable.

Once initialized, repository modules and applications can be added through the
same workspace-local generators used by `create-megamono`:

```sh
megamono add docs
megamono add ci --dry-run
megamono add app web --styling=stylex
megamono add app api --name=admin-api --interactive=false --yes
megamono add database events --adapter=drizzle
megamono add database primary --adapter=prisma --interactive=false --yes
```

Existing Prisma layouts can be adopted in place without moving migrations or
changing the installed major:

```sh
megamono add database primary --adapter=prisma --schema=prisma/schema.prisma
```

All plugin options remain forwardable through `megamono init` and
`megamono adopt`, including
per-project `--adoptionMap`, reviewed `--docsAdoptionMap`, `--ciMode`, optional
toolchain pins, reviewed `--renderServiceProjects` mappings, and non-secret
`--packageRegistries` scope routing.

A valueless `megamono add app` opens the application selector in an interactive
terminal. Web and site additions then select Chakra (suggested), Emotion,
Tailwind, Panda, StyleX, CSS Modules, or inline styles. shadcn/ui uses the
Tailwind renderer and Park UI uses the Panda renderer; styling remains an
app-owned scaffold choice rather than a Megamono rule. Add commands preview before confirmation, install only missing
compatible framework adapters, and preserve the workspace's Nx major. Mutating
app and database additions require a clean, named, non-default Git branch before
dependency installation or generation begins. Use
`--local-packages=yalc` when a required `@megamono/*` application adapter is
available only from the local yalc store.

If delegated generation fails after dependency setup or tree writes, the CLI
preserves the delegated exit code and prints the completed dependency step,
the partial-file inspection path, and an exact retry command.

Database names are repository-defined slugs. A valueless `megamono add
database` asks for the name with `primary` as a suggestion and then offers the
Prisma and Drizzle adapters. The generator creates adapter-native schema
configuration and a matching named Playstack artifact target, but never
connects to a database or runs migrations.

Playstack setup is optional and remains owned by `@playstack/cli`:

```sh
megamono init \
  --playstack \
  --playstack-packages=auth,accounts \
  --local-packages=yalc
```

Bare names are Playstack capabilities and are delegated to `playstack add`, so
Playstack owns recipes, prerequisites, surface bindings, and transitive yalc
resolution. Full package names such as `@playstack/cache` remain accepted as a
compatibility escape hatch for direct package installation.

Adding `--dry-run` keeps this entire combined flow read-only. Missing packages
are reported but never installed; an already installed Playstack CLI receives
capability dry runs and a final `playstack init --survey`.

For capability handoff, Megamono inspects the local Nx project graph and passes
explicit `--web=<project-root>` and `--api=<project-root>` paths to Playstack.
The conventional `apps/web` and `apps/api` roots win automatically; otherwise a
sole tagged application is selected. Multiple candidates prompt in an
interactive terminal and require an explicit path in automation:

```sh
megamono init \
  --playstack-packages=auth \
  --playstack-web=apps/storefront \
  --playstack-api=apps/gateway \
  --interactive=false \
  --yes
```

Pass `--playstack-web=false` or `--playstack-api=false` to deliberately omit a
surface. These routing flags are consumed by Megamono and are not forwarded to
the workspace-init generator.

In an interactive terminal, omit the value to toggle capabilities from the
supported catalog:

```sh
megamono init --playstack-packages
```

Non-interactive callers must provide the comma-separated value explicitly.

`--local-packages=yalc` refuses a missing CLI or explicit package before
initialization and never substitutes registry packages. Capability package
closures are preflighted and installed by the Playstack CLI. For the explicit
`@playstack/*` escape hatch, Megamono preflights every required local dependency
and peer before mutation, installs required third-party packages first, links
the complete local closure, and rewrites its copied internal edges to local
files before the selected npm, pnpm, Yarn, or Bun adapter hydrates the
workspace. Existing `file:.yalc/*` declarations are left in place.

The packed transport fixture covers npm and pnpm. When the Playstack packages
have been published to the local yalc store, run the real cross-repository
contract fixture with:

```sh
npm exec nx -- run @megamono/cli:e2e-playstack-yalc
```
