# `@megamono/nx-extension`

Develop and package browser extensions through Nx. WXT projects receive
Chrome and Firefox targets; existing hand-authored extensions retain the
commands and framework declared by their repository.

[Documentation](https://megamono.com/docs/platforms/extension) · [Requirements](https://megamono.com/docs/workflows/requirements)

## When to use it

Choose this plugin to add a WXT extension or bring an existing browser extension
into your Nx graph. A WXT migration is optional: manifest-only projects expose
only their declared build, development, test, and lint scripts.

## Get started

Install at the Nx workspace root and add the plugin to your existing `nx.json`:

```sh
npm install --save-dev @megamono/nx-extension@next
```

```json
{
  "plugins": ["@megamono/nx-extension"]
}
```

Existing WXT configuration and supported source manifests are discovered
without regenerating your application. To create a new WXT app, preview first:

```sh
npm exec nx -- generate @megamono/nx-extension:application browser \
  --manifestVersion=3 \
  --dry-run
```

Rerun without `--dry-run` to create and install the application. New apps are
background-only by default, without host access or content-script permissions.
Add permissions and match patterns deliberately as features need them.

## Develop and package

Find the generated or discovered project name, then replace `your-extension`
with that name in the examples:

```sh
npm exec nx -- show projects
npm exec nx -- show project your-extension
npm exec nx -- run your-extension:dev-chrome
```

Run finite build and package tasks separately from a running development server:

```sh
npm exec nx -- run your-extension:build
npm exec nx -- run your-extension:package
```

| WXT target                  | Purpose                                            |
| --------------------------- | -------------------------------------------------- |
| `prepare`, `typecheck`      | Prepare WXT-generated types and check TypeScript   |
| `dev-chrome`, `dev-firefox` | Start development for one browser                  |
| `build`                     | Build Chrome and Firefox bundles                   |
| `package`                   | Produce browser archives, including Firefox source |

Finite targets share an ordered chain and are non-cacheable because WXT updates
shared generated state. Use one Nx invocation at a time for the same app.
Manifest-only projects have their own declared scripts instead of this WXT target
set. Store submission requires repository-owned commands and credentials;
Safari uses a separate Apple wrapper project.

## Requirements and help

This is a workspace development dependency. It can be used with Nx without
adopting the core Megamono workspace modules or creating a hosted account.
Examples use npm; retain your workspace's established package manager.

See [requirements and compatibility](https://megamono.com/docs/workflows/requirements)
for supported Node/Nx versions and platform tools, and the
[package guide](https://megamono.com/docs/platforms/extension) for the full workflow.
For problems, [report an issue](https://github.com/megamono-dev/megamono/issues).

MIT licensed. See [LICENSE](./LICENSE).

## Advanced reference

<details>
<summary>Configuration, execution details, and maintainer qualification</summary>

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

#### WXT build scheduling

Generated and inferred finite targets use the same ordered chain:
`prepare → typecheck → build-chrome → build-firefox → package-chrome → package-firefox → package-firefox-source`.
Preparation declares `.wxt` as its output and runs on every invocation; builds
and archives are also non-cacheable because WXT rewrites shared generated state.
Deleting `.wxt` cannot be masked by a successful preparation cache hit.

The chain serializes a parallel Nx run without requiring newer Nx scheduler
features. A Firefox-only target also builds Chrome; packaging runs the preceding
steps. This conservative ordering trades extra work for consistent shared state.
Custom output paths still require matching application-owned output overrides.
Existing explicit `project.json` targets override inference: review them when
adopting this change rather than expecting regeneration to rewrite them.

Use one Nx invocation for finite tasks. Do not run separate builds, packaging,
or dev servers concurrently against the same app directory; this DAG is not a
cross-process lock. Use separate worktrees for independent concurrent builds.

#### Toolchain ownership and peer checks

New apps keep the repository's TypeScript declaration when its complete range is
within `>=5.4 <7`; absent a declaration, the default is `5.9.3`. Conflicting,
unbounded or catalog/workspace alias declarations require explicit review rather
than silently widening the repository toolchain. Existing app toolchains are not
rewritten on rerun.

The scaffold pins WXT `0.21.4`, Vite `8.2.2`, esbuild `0.28.2`, and Vitest `4.1.11`
at the extension package. Root bundler dependencies remain untouched. Generation
requires Node 22.12+ (22.x) or 24.x, matching the combined toolchain requirements.
After installation the generator checks the selected packages' versions, Node
engines, required peers and present optional peers in their actual resolution
contexts. This catches pnpm virtual-store mismatches as well as root hoisting;
it does not certify every dependency in the workspace.

Both the main CLI and the leaf generator support `--skipInstall`. That also defers
peer verification. Use the workspace's established install/store settings, then
run this read-only check from the extension directory:

```sh
node -e "require('@megamono/nx-extension').verifyExtensionToolchain(process.cwd())"
```

Finish with the typecheck/build/package targets and your package manager's full
peer check. A post-install failure leaves generated files for review; it never
rewrites workspace overrides or changes package-manager/store settings to fix peers.

</details>
