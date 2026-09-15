# `@megamono/cli`

Global command dispatcher for adopting Megamono in an existing Nx workspace.

Surveys, health/verification targets, project discovery, and delegated dry runs
execute the installed tool's declared `bin` with the CLI's current Node runtime.
They never invoke package-manager reconciliation or download a missing tool.
Repair missing executables through an explicit dependency installation. A survey
that needs an ephemeral plugin still stages its dependencies outside the consumer.
Yalc surveys read the store and copy the plugin into private temporary staging;
they never run `yalc add` or register that staging directory in the shared Yalc
installation registry. Staging is removed on success or failure. Installing the
temporary runtime can still require registry access and package-manager cache
writes; read-only refers to the consumer and Yalc installation state, not a
network-free operation. Missing artifacts and unreadable store paths have
distinct diagnostics.

The private copy is made owner-writable even when the source store is immutable;
the source permissions and contents are never changed. Ephemeral surveys also
redirect Nx cache/workspace-data writes to their disposable staging directory
and disable its daemon.

Maintainers: `npm exec nx -- run @megamono/cli:e2e-isolated-yalc-survey` runs the
packed CLI with real npm, Yalc and Nx 22.7.8/23.1.1 in two disposable consumers.
It enforces a read-only private store, checks complete consumer/store snapshots
(including node_modules and symlink identities), checks the real global Yalc
installation registry hash, audits that only `yalc dir` ran, and checks staging
cleanup. Logs and artifact hashes are saved under `tmp/survey-isolation/`.
The fixture requires network access for public dependencies and POSIX permission
semantics; it does not mutate real adopters or qualify their application runtime.
Ordinary write/install commands retain the selected package manager.

```sh
npm install --global @megamono/cli
megamono adopt
megamono adopt --survey --local-packages=yalc
megamono adopt --profile=pilot --dry-run
megamono adopt --only=health,inference,lint --write --yes
```

`megamono adopt` is the mature-workspace spelling of the same initializer. It
defaults to the write-free survey; `--dry-run` prints the exact operation and
commit plan, while `--write` enables an explicitly accepted mutation. The
survey includes a capability assessment covering detected repository behavior,
the Megamono equivalent, compatible-as-is systems, importable configuration,
planned files, and conflicts that still require a decision. `megamono init`
remains available for direct orchestration and automation compatibility.

`minimal`, `pilot`, `platform`, and `full` adoption profiles are forwarded to
the local plugin. `pilot` is the mature-workspace path for lint, health, and
inference without claiming existing CI or release workflows. Every profile
expands to the same independently runnable modules as `--only`, and the plan
includes suggested commit boundaries without staging or committing files.

The target workspace needs a local Nx installation. A survey uses the local
`@megamono/plugin` when available; otherwise the CLI stages a matching plugin
and Nx runtime in a disposable directory from the selected registry or Yalc
source. This does not change the repository. `--write` still requires the
plugin to be installed as a workspace development dependency.
Staging invokes npm with the CLI's active Node executable, not a PATH-selected
Node shim. npm must be installed alongside that Node distribution; if it is
missing, the survey stops without modifying the workspace.

Initialized workspaces expose composable verification without requiring users
to remember executor target names:

```sh
megamono health --profile=development
megamono health --profile=ci
megamono verify runtime api --outputPath=dist/apps/api
megamono verify dependencies
megamono verify container --dockerfile=apps/api/Dockerfile
megamono add integration --packages=@playstack/rate-limit --api=apps/api --dry-run
```

Application integration accepts explicit web, API, worker, and portable roots.
It consumes the installed packages' signed `playstack.integration.json`
resources and keeps their semantics package-owned. Mature migrations can select
`--persistence=application` and
`--adoption-mode=compare|shadow|cutover`; adapter conditions use
`--adapters`, while contextual conditions and required decisions use JSON maps.
The dry run reports existing application references and suggested commit
boundaries before `--yes` may write ejectable source.

These commands delegate to `megamono:check`, `verify-runtime`,
`verify-dependencies`, and `verify-container` respectively. Container
verification remains static unless `--smoke` is explicitly passed.

`megamono help adopt`, `megamono help health`, and `megamono help verify`
print the options for that command rather than repeating root help.
`megamono --version --json` additionally reports the package version, source
revision, dirty state, and content-derived build ID. The same identity is
available from `create-megamono --version --json`.

Use read-only artifact diagnostics before evaluating a same-version Yalc update:

```sh
megamono diagnostics packages --json
megamono diagnostics packages --packages=@megamono/plugin,@playstack/cli --yalc-store=/path/to/.yalc
megamono diagnostics packages --source-root=/path/to/megamono
```

The report inventories declared packages and Megamono store packages, compares
manifest semantics and emitted `dist` bytes, and displays available build metadata.
It distinguishes installed `node_modules`, consumer `.yalc`, every stored version,
optional source repository builds, and resolvable PATH-selected CLI packages.
Matching versions/build labels are not a substitute for matching artifact bytes.
Exit 1 requests review of drift, unreadable artifacts, or pushed-but-uninstalled
payloads. It never runs package installation or executes inspected CLIs.
An opaque PATH wrapper cannot be resolved this way; the report does not certify it.
Source builds are not proof of unbuilt source freshness, and this bounded check
does not qualify runtime behavior, peers, source-condition exports, or deployment.
Reconcile each consumer explicitly after reviewing its package-manager plan;
do not assume `yalc push` refreshes an existing installed dependency tree.

For a qualification gate, explicitly select reviewed artifacts in
`.megamono/qualification-artifacts.json`:

```json
{
  "version": 1,
  "artifacts": [
    {
      "package": "@megamono/plugin",
      "consumer": ".",
      "from": ".yalc/@megamono/plugin"
    },
    {
      "package": "@playstack/mail",
      "consumer": "apps/api",
      "from": "vendor/mail.tgz"
    }
  ]
}
```

```sh
megamono verify artifacts --json
megamono verify runtime api --artifact-manifest=reviewed-artifacts.json
```

Each pair resolves the installed package from that consumer's `package.json`,
including nested workspace installations. `consumer` defaults to `.`; both paths
must remain inside the workspace. Select directories or npm `.tgz` archives;
archives can also declare a lowercase `sha256` checksum. Archive inspection is
bounded and in-memory, with no extraction or execution. Links and unsupported
archive extensions fail closed. Only Megamono/Playstack package names are accepted.

All selected files must match, including published metadata; manifest formatting
and package-manager provenance fields are ignored. Additional installed files are
not compared. This is installation alignment, not a runtime or dependency-closure
certificate: list every required consumer/package pair explicitly.

When the conventional manifest exists (or `--artifact-manifest` is supplied),
`verify runtime`, `verify dependencies`, `verify container`, `adopt --write`, and
`add integration --yes` stop before delegation if a selection differs or cannot
be verified. Read-only surveys and dry runs remain available. Direct Nx commands
do not run this CLI guard. Without a selected manifest, existing workflows are
unchanged. `verify artifacts` exits 1 on drift or unverifiable selections; guarded
commands exit 3 on an alignment failure. Reconcile dependencies explicitly and
rerun; an older reviewed archive can be valid even when the Yalc store is newer.

### Local feedback report

```sh
megamono feedback --json --packages=@megamono/cli,@megamono/plugin
```

This prints a redacted artifact report for manual review and attachment to an
issue. It uses the diagnostics inventory but includes only package names,
location categories/status, recognized version/build identities, hashes and
finding counts. Absolute paths, raw errors, dependency URLs, arbitrary build
metadata and source contents are not included. It does not collect `.env`,
`.npmrc`, logs or credentials. `--yalc-store` and `--source-root` support the
same explicit inventory selections as diagnostics.

No files are written, packages executed/installed, or feedback submitted. Review
the names and hashes before sharing; add your own sanitized reproduction steps.
Exit 0 means report generation succeeded, even if it describes artifact drift.
Detailed local troubleshooting still uses `diagnostics packages`; that report
contains paths and raw errors and is not the sharing-safe format. Root inventory
does not prove nested consumer alignment or production readiness.

### Hosted authentication

Hosted authentication is optional and independent of repository discovery:

```sh
megamono auth login
megamono auth status
megamono account list
megamono account use commune
megamono auth logout
```

Login opens `app.megamono.com` in the browser and uses the Playstack public
client's S256 PKCE and loopback callback flow. Credentials are stored with
user-only permissions under the Megamono configuration directory. A user may
belong to personal and organization accounts; switching accounts rotates the
session and scopes later hosted operations to that account. For a local
Springbar environment, pass `--service-url=https://app.megamono.test` or set
`MEGAMONO_SERVICE_URL`. Structural commands never require a login.
Hosted auth commands require Node.js 20 or newer; this does not narrow the
Node.js 18.18 baseline for repository-only CLI operations.

During the private-package validation phase, install the optional
`@playstack/client-auth` peer alongside the CLI (or link both through Yalc).
Once that client package is public, ordinary package-manager installation owns
the peer in the same way.
`npm run yalc:install-cli` installs the matching peer globally when it is
available in the local Yalc store and otherwise leaves core commands usable.

Once initialized, repository modules and applications can be added through the
same workspace-local generators used by `create-megamono`:

```sh
megamono add docs
megamono add ci --dry-run
megamono add app web --styling=stylex
megamono add app api --name=admin-api --interactive=false --yes
megamono add database events --adapter=drizzle
megamono add database primary --adapter=prisma --interactive=false --yes
```

### Optional Springbar configuration

```sh
megamono init --springbar --springbar-candidates=api,site --dry-run
megamono init --springbar --springbar-candidates=api,site --yes
# Or opt in later:
megamono add springbar --dry-run
megamono add springbar --springbar-candidates=api,site --yes
```

Candidate names come from Springbar's read-only `inspect_candidates` response,
not guessed Nx names. A sole candidate can be selected automatically; zero,
multiple, or unmatched candidates exit `4` with the candidates to review.
Use the exact reported names in `--springbar-candidates`.

`add springbar` previews unless `--yes` is supplied. `init --springbar`
preflights the selection before core initialization, then calls Springbar's
transactional `setup_workspace` only after core init succeeds. `--survey` and
`--dry-run` never call setup. Springbar diagnostics from init go to stderr,
keeping survey JSON stdout parseable. Add emits a JSON plan/result.

Existing `springbar.toml` files (including symlinks) are left untouched. Commands,
working directories, fixed-port requirements, and dependencies remain owned by
Springbar's discovery/configuration contract; no services, deployment commands,
provisioning, or health-repair actions are started. Existing-workspace setup does
not invent database services, environment values, or service dependencies.

Springbar and its MCP server must already be available. The connector uses the
bundled macOS `springbar-mcp`, a PATH executable, or `SPRINGBAR_MCP_PATH`. A missing
server/daemon or setup error exits `3` with retry guidance. If core init already
succeeded it stays applied; commit/review those changes before retrying
`megamono add springbar`. After a lost setup response, inspect `springbar.toml`
first; it may already have been committed by Springbar. No fallback TOML is
written and no existing configuration is merged or replaced by Megamono.

New workspaces use `create-megamono <name> --apps=web --springbar`, a shortcut
for the existing `--service-runner=springbar` flow. Its setup still runs only
after the atomic workspace commit, preserves any existing config, and reports
a retryable optional handoff if Springbar is unavailable.

Existing Prisma layouts can be adopted in place without moving migrations or
changing the installed major:

```sh
megamono add database primary --adapter=prisma --schema=prisma/schema.prisma
```

All plugin options remain forwardable through `megamono init` and
`megamono adopt`, including
per-project `--adoptionMap`, reviewed `--docsAdoptionMap`, `--ciMode`, optional
toolchain pins, reviewed `--renderServiceProjects` mappings, and non-secret
`--packageRegistries` scope routing.

A valueless `megamono add app` opens the application selector in an interactive
terminal. Web and site additions then select Chakra (suggested), Emotion,
Tailwind, Panda, StyleX, CSS Modules, or inline styles. shadcn/ui uses the
Tailwind renderer and Park UI uses the Panda renderer; styling remains an
app-owned scaffold choice rather than a Megamono rule. Add commands preview before confirmation, install only missing
compatible framework adapters, and preserve the workspace's Nx major. Mutating
app and database additions require a clean, named, non-default Git branch before
dependency installation or generation begins. Use
`--local-packages=yalc` when a required `@megamono/*` application adapter is
available only from the local yalc store.

If delegated generation fails after dependency setup or tree writes, the CLI
preserves the delegated exit code and prints the completed dependency step,
the partial-file inspection path, and an exact retry command.

Database names are repository-defined slugs. A valueless `megamono add
database` asks for the name with `primary` as a suggestion and then offers the
Prisma and Drizzle adapters. The generator creates adapter-native schema
configuration and a matching named Playstack artifact target, but never
connects to a database or runs migrations.

Playstack setup is optional and remains owned by `@playstack/cli`:

```sh
megamono init \
  --playstack \
  --playstack-packages=auth,accounts \
  --local-packages=yalc
```

Bare names are Playstack capabilities and are delegated to `playstack add`, so
Playstack owns recipes, prerequisites, surface bindings, and transitive yalc
resolution. Full package names such as `@playstack/cache` remain accepted as a
compatibility escape hatch for direct package installation.

Adding `--dry-run` keeps this entire combined flow read-only. Missing packages
are reported but never installed; an already installed Playstack CLI receives
capability dry runs and a final `playstack init --survey`.

For capability handoff, Megamono inspects the local Nx project graph and passes
explicit `--web=<project-root>` and `--api=<project-root>` paths to Playstack.
A sole web candidate is selected automatically. When multiple web applications
are found, even a conventional `apps/web` root must be chosen explicitly or
through the interactive prompt: it may be a marketing site rather than the
authenticated application. API selection retains its `apps/api` preference;
otherwise a sole tagged API is selected. Ambiguous selections require an
explicit path in automation.

Web discovery uses the Nx project inventory, explicit `platform:web` tags,
conventional web roots, and project-local framework evidence: `next.config.js`,
`next.config.mjs`, `next.config.ts`, known Nx Next build/server executors, or a
Vite config paired with `index.html`. It does not execute configuration files,
infer every project from workspace-root dependencies, or scan arbitrary command
text. Libraries, e2e projects, and explicitly non-web platform classifications
are excluded; extension/desktop markers prevent Vite-only web inference.
Custom layouts without these signals still need reviewed tags or an explicit
`--playstack-web` path. For example, use `--playstack-web=apps/app` when
`apps/web` is marketing and `apps/app` is the authenticated dashboard.

```sh
megamono init \
  --playstack-packages=auth \
  --playstack-web=apps/storefront \
  --playstack-api=apps/gateway \
  --interactive=false \
  --yes
```

Pass `--playstack-web=false` or `--playstack-api=false` to deliberately omit a
surface. These routing flags are consumed by Megamono and are not forwarded to
the workspace-init generator.

In an interactive terminal, omit the value to toggle capabilities from the
supported catalog:

```sh
megamono init --playstack-packages
```

Non-interactive callers must provide the comma-separated value explicitly.

`--local-packages=yalc` refuses a missing CLI or explicit package before
initialization and never substitutes registry packages. Capability package
closures are preflighted and installed by the Playstack CLI. For the explicit
`@playstack/*` escape hatch, Megamono preflights every required local dependency
and peer before mutation, installs required third-party packages first, links
the complete local closure, and rewrites its copied internal edges to local
files before the selected npm, pnpm, Yarn, or Bun adapter hydrates the
workspace. Existing `file:.yalc/*` declarations are left in place.

The packed transport fixture covers npm and pnpm. When the Playstack packages
have been published to the local yalc store, run the real cross-repository
contract fixture with:

```sh
npm exec nx -- run @megamono/cli:e2e-playstack-yalc
```

# Machine-readable adoption surveys

`megamono adopt --survey --format=json` writes one survey JSON object to stdout.
Nx banners, staging output, and warnings go to stderr, including when the plugin
is staged temporarily. Failure returns a nonzero exit code with diagnostics on
stderr and no survey on stdout. This contract covers read-only Megamono surveys,
not combined Playstack workflows or mutating generator plans.

On failure, the final stderr line is a JSON record with `schemaVersion: 1`,
`type: "megamono.survey.error"`, `code`, `exitCode`, and `message`. Earlier stderr
lines remain human-readable diagnostics; stderr as a whole is not one JSON value.
Codes are `survey-preflight-failed`, `survey-staging-failed`,
`survey-command-failed`, and `survey-output-invalid`. Consumers must check the
process exit code before parsing stdout. Graph failures do not authorize Megamono
to install missing application build dependencies.

Current CLI/plugin pairs transfer the completed report through a private
temporary file before stdout serialization, avoiding Nx logger/exit truncation.
The handoff is removed on success and failure; it is not a repository artifact.
Older plugins fall back to validated stdout and fail closed if it is truncated.
