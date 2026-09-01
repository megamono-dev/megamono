# `@megamono/nx-extension`

Nx 18–23 inference and generation for WXT browser extensions.

The plugin discovers `wxt.config.*`, exposes explicit Chrome and Firefox development, build, and archive targets, and treats Safari as a separate Apple wrapper project. Store deployment targets appear only when a repository-owned `extension.store.json` supplies commands; credentials remain CI-owned.

```json
{
  "plugins": [
    {
      "plugin": "@megamono/nx-extension",
      "options": { "scope": "my-workspace" }
    }
  ]
}
```

Create an application through the canonical Megamono flow:

```text
megamono add app extension
```

The generated project does not require Playstack. When a compatible `@playstack/extension` capability becomes available, add it separately through Playstack so product behavior remains package-owned.
