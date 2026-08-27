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
  --playstack-packages=@playstack/auth,@playstack/accounts \
  --local-packages=yalc
```

`--local-packages=yalc` refuses missing local artifacts before initialization
and never substitutes registry packages.
