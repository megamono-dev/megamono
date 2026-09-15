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

All inferred commands run with `cwd: "{projectRoot}"`. Choose an explicit
manifest version when generating a new app with
`megamono add app extension --manifestVersion=3`. For existing apps, configure
per-browser overrides in the application's package manifest:

```json
{
  "megamono": {
    "extension": { "manifestVersions": { "chrome": 3, "firefox": 3 } }
  }
}
```

The same `manifestVersions` map can be supplied as plugin options; application
values take precedence. Explicit versions add WXT's `--mv2`/`--mv3` flag to
dev/build/package commands and select matching build outputs. Without overrides,
WXT retains control and output globs cover either manifest version—discovery does
not execute configuration or assume Firefox MV2. Custom `outDir`,
`outDirTemplate`, or ZIP templates require application-owned Nx output overrides.
See [WXT manifest-version configuration](https://wxt.dev/api/reference/wxt/interfaces/inlineconfig#manifestversion).

Existing directories remain protected: scaffolding is not an existing-app WXT
migration. Changing a generated app's version on rerun requires explicit review
of its application-owned configuration.

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

New extensions are background-only by default: no content script, host access,
or API permissions are requested. Add permissions deliberately in `wxt.config.ts`
as features need them. For page integration, opt in with explicit match patterns:

```sh
megamono add app extension --name=browser --contentScriptMatches='https://example.com/*' --yes
```

`contentScriptMatches` is an array in the Nx generator API. Broad patterns such as
`<all_urls>` require an explicit opt-in; review the final Chrome/Firefox manifests
before distribution. Rerunning generation never removes application-owned scripts.

Use `--displayName="Quickzones"` to set the browser-facing product name through
the main `add app extension` command. Without it, the selected application
basename is used, independently of the workspace/package scope.
