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
```

A valueless `megamono add app` opens the application selector in an interactive
terminal. Add commands preview before confirmation, install only missing
compatible framework adapters, and preserve the workspace's Nx major. Use
`--local-packages=yalc` when a required `@megamono/*` application adapter is
available only from the local yalc store.

Playstack setup is optional and remains owned by `@playstack/cli`:

```sh
megamono init \
  --playstack \
  --playstack-packages=auth,accounts \
  --local-packages=yalc
```

Full package names such as `@playstack/auth` remain accepted and normalize to
the same canonical package request.

In an interactive terminal, omit the value to toggle products from the
supported catalog:

```sh
megamono init --playstack-packages
```

Non-interactive callers must provide the comma-separated value explicitly.

`--local-packages=yalc` refuses missing local artifacts before initialization
and never substitutes registry packages.
