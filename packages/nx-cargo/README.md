# `@megamono/nx-cargo`

Nx 23 project inference and dependency edges for Cargo workspaces and standalone Rust packages.

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

For a Tauri project that declares `@tauri-apps/cli`, the inferred `tauri` target uses that workspace-local npm CLI and forwards the package plus isolated target directory to Cargo. A Cargo-only Tauri project falls back to the `cargo tauri` subcommand.

When a package also exposes an npm script named `tauri`, configure `tauriTargetName` to a distinct name such as `tauri-build`; otherwise Nx's npm-script inference and this plugin would contribute the same target name. `create-megamono` uses `tauri-build` for generated Desktop apps.
