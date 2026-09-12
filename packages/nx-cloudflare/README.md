# `@megamono/nx-cloudflare`

Wrangler-aware project, target, metadata, and dependency inference for Nx 18–23 workspaces.

The package is currently available through Megamono's restricted validation channel. It is a development-time Nx plugin and does not add a runtime dependency to Worker applications.

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
