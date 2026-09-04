# `@megamono/nx-render`

Nx inference and validation for repository-owned Render Blueprints.

```json
{
  "plugins": ["@megamono/nx-render"]
}
```

The plugin reads explicit `render.yaml`, `render.yml`, or
`render.services.json` services. The JSON form is a commit-safe inventory for
teams that keep service authority in the Render dashboard. A service with `rootDir`
contributes bounded `render-build`, `render-start`, and `render-pre-deploy`
targets to the owning Nx project when the corresponding Blueprint command is
present. It records service type, runtime, health path, build filters,
environment-variable names, resource references, Postgres, and Key Value
metadata under `megamono:render`. Secret values are never included.

Services without `rootDir` require an explicit mapping because Megamono will
not assume that every Nx application is deployed:

```json
{
  "plugin": "@megamono/nx-render",
  "options": {
    "serviceProjects": {
      "api": { "project": "api", "root": "apps/api" }
    }
  }
}
```

Graph preflight reports malformed health checks, missing roots, duplicate
service names, unresolved service/database references, build filters that omit
their owning Nx root, and multi-instance Next services without a detectable
shared `cacheHandler`. A Procfile alone is reported by the core workspace
inventory as partial deployment evidence; this plugin never reconstructs
dashboard-owned Render services from it.

For an explicit, reviewable conversion, the package also exposes an adoption
generator:

```sh
npm exec nx generate @megamono/nx-render:adopt
npm exec nx generate @megamono/nx-render:adopt \
  --inventory=render.services.json \
  --serviceProjects=render-adoption.json
```

It writes `render.proposed.yaml`, never `render.yaml`. Procfile commands that
name one Nx project inherit that project's root; dashboard-only services need
an explicit mapping. Web services without a verified health endpoint retain a
validator warning—the generator does not invent an application route.
