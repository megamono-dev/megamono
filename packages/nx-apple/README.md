# `@megamono/nx-apple`

Bring Swift packages, Xcode projects, and Xcode workspaces into your Nx project
graph. Run native build and test tasks alongside the rest of your repository
while keeping SwiftPM and Xcode as the native toolchain.

[Documentation](https://megamono.com/docs/platforms/apple) · [Requirements](https://megamono.com/docs/workflows/requirements)

## When to use it

Choose this plugin when your repository contains Swift or Xcode projects, or
when you want to add a SwiftUI macOS app to an existing Nx workspace. Local
Swift package and Xcode references become project dependencies in the Nx graph.

## Get started

From your existing Nx workspace root:

```sh
npm install --save-dev @megamono/nx-apple@next
```

Add the plugin to the existing `plugins` array in `nx.json`:

```json
{
  "plugins": ["@megamono/nx-apple"]
}
```

Discover projects, then inspect and run one. Replace `your-project` with a name
reported by `show projects`:

```sh
npm exec nx -- show projects
npm exec nx -- show project your-project
npm exec nx -- run your-project:build
npm exec nx -- run your-project:test
```

| Project                                 | Targets                                                             |
| --------------------------------------- | ------------------------------------------------------------------- |
| Swift package                           | `build`, `test`; `lint` when SwiftLint configuration is present     |
| Xcode project or workspace              | `build`, `test`, `archive`; select a scheme when several are shared |
| Project with a configured Fastlane lane | An explicit, non-cacheable deployment target                        |

## Create a macOS application

Preview a SwiftUI app with unit tests and a shared Xcode scheme:

```sh
npm exec nx -- generate @megamono/nx-apple:application \
  --name=mac-app \
  --directory=apps/mac \
  --displayName="My Mac App" \
  --bundleIdentifier=com.example.macapp \
  --dry-run
```

Rerun without `--dry-run` to create it. Use Swift for package execution and macOS
with Xcode for Xcode applications. Review schemes, SDK destinations, signing,
and archive/export settings for your own application before release.

## Requirements and help

This is a workspace development dependency. It can be used with Nx without
adopting the core Megamono workspace modules or creating a hosted account.
Examples use npm; retain your workspace's established package manager.

See [requirements and compatibility](https://megamono.com/docs/workflows/requirements)
for supported Node/Nx versions and platform tools, and the
[package guide](https://megamono.com/docs/platforms/apple) for the full workflow.
For problems, [report an issue](https://github.com/megamono-dev/megamono/issues).

MIT licensed. See [LICENSE](./LICENSE).

## Advanced reference

<details>
<summary>Configuration, execution details, and maintainer qualification</summary>

Nx 18–24 project inference and dependency edges for Swift packages, Xcode projects, and Xcode workspaces.

```json
{
  "plugins": [
    {
      "plugin": "@megamono/nx-apple",
      "options": {
        "scope": "my-workspace",
        "scheme": "MyApp",
        "configuration": "Debug",
        "destination": "platform=macOS"
      }
    }
  ]
}
```

Discovery precedence is workspace, project, then Swift package within one directory. SwiftPM metadata supplies local package edges, Xcode project files supply `XCLocalSwiftPackageReference` edges, and workspace XML supplies project edges.

The workspace adoption survey also lists Xcode projects and top-level Xcode
workspaces, including portfolios without a `Package.swift`. Embedded
`project.xcworkspace` files are not separate projects. This is static discovery,
not qualification of schemes, signing, archive/export settings, or CI behavior;
retain existing native CI until each selected target is verified on macOS.

Swift package inspection uses isolated temporary SwiftPM cache, configuration, security, and scratch paths. Read-only Nx graph and health commands therefore do not write into a developer's global SwiftPM directories, and inference failures are emitted as bounded diagnostics rather than unbounded subprocess output.

Swift packages receive `build` and `test` targets. A `lint` target appears only when `.swiftlint.yml` or `.swiftlint.yaml` opts the project into SwiftLint. Xcode build, test, and archive targets use the sole shared scheme automatically; zero or multiple shared schemes require an explicit `scheme` option and produce an actionable diagnostic otherwise. Setting `fastlaneLane` adds a non-cacheable deploy target.

`derivedDataPath` is workspace-relative so Nx can cache and restore declared outputs correctly.

Repositories with several shared schemes can map each one to an independently named Nx target. `project` is optional and may select the discovered Xcode name, root, or manifest when the plugin covers multiple projects:

```json
{
  "plugin": "@megamono/nx-apple",
  "options": {
    "targets": {
      "build-direct": {
        "action": "build",
        "scheme": "MyApp Mac Direct"
      },
      "archive-app-store": {
        "action": "archive",
        "scheme": "MyApp Mac App Store",
        "configuration": "Release"
      },
      "test-ios": {
        "action": "test",
        "scheme": "MyApp",
        "destination": "platform=iOS Simulator,name=iPhone 17"
      }
    }
  }
}
```

### Application generator

The `application` generator creates a macOS SwiftUI app, an XCTest target, and a shared scheme that the plugin immediately infers as one Nx project:

```sh
npm exec nx -- generate @megamono/nx-apple:application \
  --name=my-workspace-apple \
  --directory=apps/apple \
  --displayName="My Workspace" \
  --bundleIdentifier=com.my-workspace.apple \
  --scope=my-workspace
```

The default deployment target is macOS 14. The generator refuses to write into a populated directory, emits deterministic project files, registers `@megamono/nx-apple` in `nx.json`, and tags the project with `platform:apple` by default.

### Portfolio validation

The opt-in portfolio e2e discovers a real Xcode project through the compiled plugin, runs its inferred targets, verifies the archive, confirms the portfolio worktree did not change, and removes only its unique ignored `.nx` output directory after success.

```sh
NX_APPLE_PORTFOLIO_ROOT=/path/to/portfolio \
NX_APPLE_PORTFOLIO_MANIFEST=apps/apple/App.xcodeproj/project.pbxproj \
NX_APPLE_PORTFOLIO_SCHEME=App \
npm exec nx -- run nx-apple:e2e-portfolio
```

Optional variables select `NX_APPLE_PORTFOLIO_DESTINATION`, `NX_APPLE_PORTFOLIO_CONFIGURATION`, and a comma-separated `NX_APPLE_PORTFOLIO_TARGETS`. The defaults are `platform=macOS`, `Debug`, and `build,test,archive`.

</details>
