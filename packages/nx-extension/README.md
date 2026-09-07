# `@megamono/nx-extension`

Nx inference and generation for WXT and repository-authored browser extensions.

The plugin recognizes WXT configuration as the fully managed target surface.
It also recognizes a standard Manifest V2 or V3 `manifest.json`, resolves the
nearest package/Nx root, retains existing identity and tags, and exposes only
the repository's declared `build`, `dev`, `test`, and `lint` package scripts.
It does not invent a framework, output directory, packaging command, or store
workflow for a hand-authored extension. When both are present, the WXT config
remains authoritative.

Non-WXT projects may use `manifest.chrome.json` and `manifest.firefox.json`
at the project root, `src/`, or `public/`. Browser variants are grouped into
one Nx project; their source paths appear in extension metadata. Generated
`dist`, `build`, `.output`, and `generated` directories are not discovery roots.
For other filenames, declare source paths in the application's `package.json`:

```json
{
  "megamono": {
    "extension": { "manifests": ["config/chrome.json", "config/firefox.json"] }
  }
}
```

Paths must remain inside the package and cannot name generated directories.
Megamono's adoption survey reads the same declaration. Existing Vite scripts
and deployment wrappers remain application-owned; adopting WXT is optional.

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
