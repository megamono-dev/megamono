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

The package also provides three plan-first generators:

```sh
npm exec nx -- generate @megamono/nx-cloudflare:worker events
npm exec nx -- generate @megamono/nx-cloudflare:binding --project=events --type=d1 --binding=DB --resource=events
npm exec nx -- generate @megamono/nx-cloudflare:durable-object SessionStore --project=events
```

Binding and Durable Object mutations run `wrangler types` only after all file changes are flushed. They never deploy or create Cloudflare resources.
