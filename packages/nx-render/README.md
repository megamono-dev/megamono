# `@megamono/nx-render`

Make repository-owned Render service configuration visible in Nx. Discover
service-to-project relationships, expose declared service commands as Nx
targets, and identify configuration that needs review before deployment.

[Documentation](https://megamono.com/docs/platforms/render) · [Requirements](https://megamono.com/docs/workflows/requirements)

## When to use it

Choose this plugin when your Nx projects are deployed with a Render Blueprint,
or when you want to turn a reviewed service inventory or Procfile into a
Blueprint proposal. It does not query the Render dashboard or deploy services.

## Get started

Install at the workspace root and register the plugin alongside your existing
`nx.json` plugins:

```sh
npm install --save-dev @megamono/nx-render@next
```

```json
{
  "plugins": ["@megamono/nx-render"]
}
```

The plugin reads `render.yaml`, `render.yml`, or a committed
`render.services.json` inventory. A service's `rootDir` connects it to its Nx
project; use `serviceProjects` mappings when that relationship is ambiguous.
Existing project identities and explicit target overrides remain authoritative.

```sh
npm exec nx -- show projects
npm exec nx -- show project your-project
npm exec nx -- graph
```

Replace `your-project` with the owning project's reported name. Targets are
inferred only when the corresponding service command exists:

| Target              | Runs the service's declared command |
| ------------------- | ----------------------------------- |
| `render-build`      | Build command                       |
| `render-start`      | Start command                       |
| `render-pre-deploy` | Pre-deploy command                  |

These commands execute only when you run their targets. Configuration validation
reports missing roots, malformed health paths, unresolved references, and build
filters that exclude the owning project.

## Propose a Blueprint

For a reviewed Procfile or service inventory, run the adoption generator:

```sh
npm exec nx -- generate @megamono/nx-render:adopt
```

It writes `render.proposed.yaml` for review. It does not replace `render.yaml`,
run database migrations, or deploy anything. The advanced reference explains
explicit service mappings and Prisma build/pre-deploy ordering. Keep environment
values, credentials, migration review, and release approval in your deployment
workflow.

## Requirements and help

This is a workspace development dependency. It can be used with Nx without
adopting the core Megamono workspace modules or creating a hosted account.
Examples use npm; retain your workspace's established package manager.

See [requirements and compatibility](https://megamono.com/docs/workflows/requirements)
for supported Node/Nx versions and platform tools, and the
[package guide](https://megamono.com/docs/platforms/render) for the full workflow.
For problems, [report an issue](https://github.com/megamono-dev/megamono/issues).

MIT licensed. See [LICENSE](./LICENSE).

## Advanced reference

<details>
<summary>Configuration, execution details, and maintainer qualification</summary>

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
npm exec nx -- generate @megamono/nx-render:adopt
npm exec nx -- generate @megamono/nx-render:adopt \
  --inventory=render.services.json \
  --serviceProjects=render-adoption.json
```

It writes `render.proposed.yaml`, never `render.yaml`. Procfile commands that
name one Nx project inherit that project's root; dashboard-only services need
an explicit mapping. Web services without a verified health endpoint retain a
validator warning—the generator does not invent an application route.

### Prisma deployment chain

For Prisma services, the adoption generator also updates the mapped Nx project's
`build.dependsOn` with each database's `generate` target and records the explicit
project dependencies. Review these changes with the Blueprint proposal. It never
runs a migration or promotes the proposal to `render.yaml`.

Register schema/project ownership in `megamono.json`. Database dependencies can
be selected from declared Nx/package dependencies, or supplied explicitly in the
adoption map (required when only source-inferred relationships are available):

```json
{
  "services": {
    "api": {
      "project": "api",
      "root": "apps/api",
      "databases": ["primary"]
    }
  }
}
```

`primary` is the logical Megamono database name, not a guessed Render resource
name. Every selection needs an existing schema and a database `generate` target.
An unresolved Node service in a Prisma workspace requires a reviewed selection;
use an empty list only for a service that does not consume Prisma. This does not
override a known Prisma dependency.

The proposal uses the workspace as Render's `rootDir` so sibling libraries,
Prisma configuration, and migrations remain available. An existing narrower
service root must be reviewed first. With npm, a typical result is:

```yaml
rootDir: .
buildCommand: npm ci && npm exec nx -- run 'api:build'
preDeployCommand: npm exec prisma -- migrate deploy --schema 'libs/prisma/primary/prisma' --config 'libs/prisma/primary/prisma.config.ts'
```

The schema and configuration paths come from the selected database, including
custom schema locations. The API build runs client generation through its Nx
dependencies. Keep the same service-to-project mapping in the Render inference
plugin when promoting this workspace-root proposal. Existing build commands must
invoke the mapped Nx build; existing custom pre-deploy commands require explicit
composition and are never silently replaced or appended to.

Render runs pre-deploy commands on a separate instance: generating a client there
does not update the deployed filesystem. Pre-deploy is supported for paid web,
private, and worker services. Docker, cron, and explicitly free services require
a separately reviewed strategy rather than this generated Node chain. See
[Render deploy steps](https://render.com/docs/deploys) and
[monorepo roots](https://render.com/docs/monorepo-support).

Before enabling deployment, review and commit migration SQL, confirm backups,
release approval, credentials, and the intended database. Keep the Prisma CLI,
configuration, schema, and migrations in the pre-deploy artifact. `migrate deploy`
applies committed migrations; it does not replace review or backup procedures.
Do not substitute `migrate dev`, `db push`, or reset commands in production.

</details>
