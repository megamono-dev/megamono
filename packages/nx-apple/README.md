# `@megamono/nx-apple`

Nx 23 project inference and dependency edges for Swift packages, Xcode projects, and Xcode workspaces.

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

Swift packages receive `build` and `test` targets. A `lint` target appears only when `.swiftlint.yml` or `.swiftlint.yaml` opts the project into SwiftLint. Xcode build, test, and archive targets use the sole shared scheme automatically; zero or multiple shared schemes require an explicit `scheme` option and produce an actionable diagnostic otherwise. Setting `fastlaneLane` adds a non-cacheable deploy target.

`derivedDataPath` is workspace-relative so Nx can cache and restore declared outputs correctly.

## Application generator

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

## Portfolio validation

The opt-in portfolio e2e discovers a real Xcode project through the compiled plugin, runs its inferred targets, verifies the archive, confirms the portfolio worktree did not change, and removes only its unique ignored `.nx` output directory after success.

```sh
NX_APPLE_PORTFOLIO_ROOT=/path/to/portfolio \
NX_APPLE_PORTFOLIO_MANIFEST=apps/apple/App.xcodeproj/project.pbxproj \
NX_APPLE_PORTFOLIO_SCHEME=App \
npm exec nx -- run nx-apple:e2e-portfolio
```

Optional variables select `NX_APPLE_PORTFOLIO_DESTINATION`, `NX_APPLE_PORTFOLIO_CONFIGURATION`, and a comma-separated `NX_APPLE_PORTFOLIO_TARGETS`. The defaults are `platform=macOS`, `Debug`, and `build,test,archive`.
