# `@megamono/nx-cloudflare`

Connect Cloudflare Workers to Nx using the Wrangler configuration you already
own. Discover Worker projects, run Wrangler targets, and include local Worker
bindings in the project graph.

[Documentation](https://megamono.com/docs/platforms/cloudflare) · [Requirements](https://megamono.com/docs/workflows/requirements)

## When to use it

Choose this plugin for an existing Workers repository or to generate a new
Worker inside an Nx workspace. It also provides generators for bindings and
Durable Objects. Cloudflare Pages generation is not part of this package's
current Worker generator.

## Get started

Install the plugin and compatible Wrangler tooling at the workspace root:

```sh
npm install --save-dev @megamono/nx-cloudflare@next 'wrangler@^4.105.0'
```

Add the plugin to the existing `plugins` array in `nx.json`:

```json
{
  "plugins": ["@megamono/nx-cloudflare"]
}
```

Projects are discovered from `wrangler.jsonc`, `wrangler.json`, and
`wrangler.toml`. Inspect a discovered project, generate binding types, and start
local development. Replace `your-worker` with the reported project name:

```sh
npm exec nx -- show projects
npm exec nx -- show project your-worker
npm exec nx -- run your-worker:typegen
npm exec nx -- run your-worker:dev
```

| Target    | Purpose                                   |
| --------- | ----------------------------------------- |
| `dev`     | Run Wrangler local development            |
| `typegen` | Generate Worker binding types             |
| `tail`    | Read logs using Wrangler                  |
| `deploy`  | Deploy the Worker when explicitly invoked |

## Create a Worker

```sh
npm exec nx -- generate @megamono/nx-cloudflare:worker events --dry-run
```

Review the preview, then rerun without `--dry-run`. Binding and Durable Object
generators are described in the reference below. Generation does not deploy or
create Cloudflare resources. Configure resources and Wrangler authentication
before invoking remote targets.

## Requirements and help

This is a workspace development dependency. It can be used with Nx without
adopting the core Megamono workspace modules or creating a hosted account.
Examples use npm; retain your workspace's established package manager.

See [requirements and compatibility](https://megamono.com/docs/workflows/requirements)
for supported Node/Nx versions and platform tools, and the
[package guide](https://megamono.com/docs/platforms/cloudflare) for the full workflow.
For problems, [report an issue](https://github.com/megamono-dev/megamono/issues).

MIT licensed. See [LICENSE](./LICENSE).

## Advanced reference

<details>
<summary>Configuration, execution details, and maintainer qualification</summary>

Wrangler-aware project, target, metadata, and dependency inference for Nx 18–23 workspaces.

This package is published on npm. It is a development-time Nx plugin and does not add a runtime dependency to Worker applications.

Register the inference plugin in `nx.json`:

```json
{
  "plugins": ["@megamono/nx-cloudflare"]
}
```

The plugin discovers `wrangler.jsonc`, `wrangler.json`, and `wrangler.toml`, then infers `dev`, `deploy`, `typegen`, and `tail`. Local Worker bindings become static Nx dependency edges.

Version metadata bindings (`version_metadata`) are recognized in the top-level and named-environment inventories. They do not create project dependency edges. Unknown binding families still require review, and compatibility dates remain repository-owned.

Each inferred target name can be customized or set to `false`. Mature repositories with guarded runtime wrappers can suppress the raw commands while retaining type generation, metadata, and graph edges:

```json
{
  "plugin": "@megamono/nx-cloudflare",
  "options": {
    "devTargetName": false,
    "deployTargetName": false
  }
}
```

Nx plugin `include` and `exclude` patterns may scope separate registrations when target policy differs between Worker projects. Repository-owned explicit targets remain authoritative.

Existing workspaces may retain Wrangler `>=4.105 <5`; the packed compatibility fixture runs inference and type generation at 4.105. New Worker scaffolds continue to use the newer exact compatibility pin. Upgrading Wrangler is therefore separate from adopting Megamono.

The package also provides three plan-first generators:

```sh
npm exec nx -- generate @megamono/nx-cloudflare:worker events
npm exec nx -- generate @megamono/nx-cloudflare:binding --project=events --type=d1 --binding=DB --resource=events
npm exec nx -- generate @megamono/nx-cloudflare:durable-object SessionStore --project=events
```

Binding and Durable Object mutations run `wrangler types` only after all file changes are flushed. They never deploy or create Cloudflare resources.

</details>
