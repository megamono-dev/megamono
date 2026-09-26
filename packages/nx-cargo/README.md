# `@megamono/nx-cargo`

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

## Execution and release boundaries

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
