# `@megamono/cli`

Global command dispatcher for adopting Megamono in an existing Nx workspace.

```sh
npm install --global @megamono/cli
megamono init --survey
megamono init
```

The target workspace must install `@megamono/plugin` as a development
dependency. The CLI always delegates to the workspace-local Nx and plugin.

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
