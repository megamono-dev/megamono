# `@megamono/nx-cargo`

Make Rust packages and Cargo workspaces part of your Nx project graph. Build,
test, and lint Rust projects through Nx while retaining Cargo manifests,
features, and native commands.

[Documentation](https://megamono.com/docs/platforms/cargo) · [Requirements](https://megamono.com/docs/workflows/requirements)

## When to use it

Choose this plugin when Rust libraries, CLIs, or Tauri apps live beside other
projects in an Nx workspace. It discovers existing Cargo packages and local path
dependencies; it does not scaffold a new Rust package or replace Cargo.

## Get started

Install the public prerelease at your workspace root. Have Cargo and the Rust
toolchain available; the `lint` target uses Clippy.

```sh
npm install --save-dev @megamono/nx-cargo@next
```

Add the plugin to your existing `nx.json` registrations:

```json
{
  "plugins": ["@megamono/nx-cargo"]
}
```

Each Cargo workspace member becomes an Nx project. A virtual Cargo workspace
root does not become an extra project. Find a package and inspect its targets:

```sh
npm exec nx -- show projects
npm exec nx -- show project your-project
npm exec nx -- run your-project:build
npm exec nx -- run your-project:test
npm exec nx -- run your-project:lint
```

Replace `your-project` with a reported project name.

| Target  | Runs                                               |
| ------- | -------------------------------------------------- |
| `build` | Cargo build for the selected package               |
| `test`  | Cargo tests for the selected package               |
| `lint`  | Cargo Clippy for the selected package              |
| `tauri` | Build integration for a detected Tauri application |

## Configure Cargo and Tauri

Plugin options select features, target triples, profiles, lockfile enforcement,
and target names. Tauri uses the application's declared local Node CLI when
available, with a Cargo subcommand fallback for Cargo-only setups. If the app
already has an npm script named `tauri`, choose another `tauriTargetName`, such
as `tauri-build`.

Native targets default to `cache: false`. Enable caching only after reviewing
toolchain inputs, build scripts, environment, and output paths. Signing,
notarization, and release packaging stay with your application.

## Requirements and help

This is a workspace development dependency. It can be used with Nx without
adopting the core Megamono workspace modules or creating a hosted account.
Examples use npm; retain your workspace's established package manager.

See [requirements and compatibility](https://megamono.com/docs/workflows/requirements)
for supported Node/Nx versions and platform tools, and the
[package guide](https://megamono.com/docs/platforms/cargo) for the full workflow.
For problems, [report an issue](https://github.com/megamono-dev/megamono/issues).

MIT licensed. See [LICENSE](./LICENSE).

## Advanced reference

<details>
<summary>Configuration, execution details, and maintainer qualification</summary>

Nx 18–23 project inference and dependency edges for Cargo workspaces and standalone Rust packages.

```json
{
  "plugins": [
    {
      "plugin": "@megamono/nx-cargo",
      "options": {
        "buildTargetName": "build",
        "testTargetName": "test",
        "lintTargetName": "lint",
        "tauriTargetName": "tauri",
        "scope": "my-workspace"
      }
    }
  ]
}
```

The plugin runs `cargo metadata --format-version 1 --no-deps` once per Cargo workspace, creates one Nx project per workspace member, and emits static edges for local path dependencies. A virtual workspace root does not become a project. Tauri packages are recognized from their configuration and rooted above `src-tauri`.

Inferred Cargo commands always include `--package`. Optional plugin settings add `target`, `features`, `allFeatures`, `noDefaultFeatures`, `profile`, and an isolated `targetDir` to those commands. Target names can be changed with the four `*TargetName` options above.

Missing Cargo installations and invalid manifests are reported through `getCargoDiagnostics()` while valid independent workspaces continue to load.

For a Tauri project that declares `@tauri-apps/cli`, the inferred `tauri` target resolves its local Node entrypoint from the owning app and forwards the package plus isolated target directory to Cargo. It never downloads a CLI or uses a global npm shim. A Cargo-only Tauri project falls back to the `cargo tauri` subcommand.

### Execution and release boundaries

Targets use `@megamono/nx-cargo:run` with a tool and argument array, not shell
quoting. Paths with spaces and shell metacharacters remain single arguments on
Windows, Linux and macOS. `locked: true` and `allTargets: true` add `--locked` and
`--all-targets` to Cargo build/test/Clippy; `denyWarnings: true` adds `-- -D warnings`
to Clippy only. Defaults do not imply strict release lint. Tauri release flags,
signing, and notarization remain repository-owned tasks.

All inferred native targets now default to `cache: false`. Opt in only after
qualifying the Rust compiler/Cargo versions, lockfile, features/target/profile,
SDK/linker/toolchain, environment, build scripts and their external inputs, and
the exact output paths. Do not cache signed/notarized release artifacts without
a separate qualified signing/provenance policy. `default`/`^default` alone do not
capture this contract. Existing explicit Nx targets and cache overrides remain
consumer-owned; review them when upgrading.

`npm exec nx -- run nx-cargo:e2e-native-execution` packs the plugin and installs
it into a disposable consumer, runs actual inferred Cargo build/test/Clippy from
a path with spaces, verifies lint failure, and probes local Tauri argv with a
synthetic CLI. CI runs this on macOS, Linux and Windows. The fixture does not
qualify Tauri packaging, SDKs, signing or device execution; a workflow definition
alone is not evidence of a passing run on a given OS.

When a package also exposes an npm script named `tauri`, configure `tauriTargetName` to a distinct name such as `tauri-build`; otherwise Nx's npm-script inference and this plugin would contribute the same target name. `create-megamono` uses `tauri-build` for generated Desktop apps.

</details>
