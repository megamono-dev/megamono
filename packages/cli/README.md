# `@megamono/cli`

Global command dispatcher for adopting Megamono in an existing Nx workspace.

```sh
npm install --global @megamono/cli
megamono init --survey
megamono init
```

The target workspace must install `@megamono/plugin` as a development
dependency. The CLI always delegates to the workspace-local Nx and plugin.

Once initialized, repository modules and applications can be added through the
same workspace-local generators used by `create-megamono`:

```sh
megamono add docs
megamono add ci --dry-run
megamono add app web
megamono add app api --name=admin-api --interactive=false --yes
megamono add database events --adapter=drizzle
megamono add database primary --adapter=prisma --interactive=false --yes
```

A valueless `megamono add app` opens the application selector in an interactive
terminal. Add commands preview before confirmation, install only missing
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

In an interactive terminal, omit the value to toggle capabilities from the
supported catalog:

```sh
megamono init --playstack-packages
```

Non-interactive callers must provide the comma-separated value explicitly.

`--local-packages=yalc` refuses a missing CLI or explicit package before
initialization and never substitutes registry packages. Capability package
closures are preflighted and installed by the Playstack CLI.

The packed transport fixture covers npm and pnpm. When the Playstack packages
have been published to the local yalc store, run the real cross-repository
contract fixture with:

```sh
npm exec nx -- run @megamono/cli:e2e-playstack-yalc
```
