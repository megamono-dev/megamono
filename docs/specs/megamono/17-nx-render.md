---
id: spec-megamono-0017
type: spec
status: accepted
visibility: internal
projects: [megamono, nx-render]
topics: [generators, graph, health, integrations, nx, release, testing]
summary: Defines repository-owned Render Blueprint inference, bounded command targets, deployment metadata, and fail-closed preflight.
date: 2026-09-03
supersedes: null
references: [spec-megamono-0000, spec-megamono-0003, spec-megamono-0006]
external_references: []
---

# Nx Render integration

`@megamono/nx-render` makes declared Render services visible in the Nx graph while leaving deployment configuration, secrets, and release authority with the repository and Render.

## Compatibility and authority

The package supports Nx 18–23 and Node 18.18–24. It reads `render.yaml`, including direct services/databases and Render project/environment groups. A Procfile by itself remains partial deployment evidence in the core workspace survey; the plugin never invents dashboard-owned services or writes a Blueprint.

Every service must either declare a safe workspace-relative `rootDir` or have an explicit `serviceProjects` mapping. A root-level service without that mapping is ambiguous and is not attached to a guessed Nx project.

## Inference contract

For an explicitly resolved service, the plugin records service type, runtime, health path, instance count, build filters, environment-variable names, resource references, PostgreSQL resources, and Key Value resources under versioned `megamono:render` metadata. Secret values are never retained.

When the Blueprint declares a command, the plugin exposes the corresponding non-cacheable `render-build`, `render-start`, or `render-pre-deploy` target. It does not synthesize commands. Start targets are continuous on Nx versions that support that metadata, and omit it on older supported versions. Multiple services sharing one Nx root receive service-qualified target names.

## Preflight

Versioned preflight diagnostics cover malformed Blueprints, unsafe or missing roots, duplicate services, invalid or missing web health paths, unresolved service/database references, build filters that omit the owning project root, and multi-instance Next services without a detectable shared cache handler. These diagnostics inform repository health and adoption review; they do not disclose environment values.

## Adoption and release gates

The existing-workspace survey detects a repository-owned `render.yaml`. It inventories services and derives a proposed mapping only from an explicit `rootDir` or exact Nx project references in declared service commands. Root-level services remain decision-required: the caller reviews `adoptionTemplates.render.serviceProjects` and passes its `serviceProjects` value through `--renderServiceProjects`. Init validates every service, project, and root before registering the plugin object in `nx.json`; it does not change the Blueprint or reinterpret a workspace-root command as an app-root command. Selecting the inference module registers `@megamono/nx-render`, records the manifest in `megamono.json`, and preserves the Blueprint unchanged. The package belongs to the fixed-version public `megamono` release group. Unit tests and the packed Nx compatibility fixture must validate inference across the declared Nx range before `next` or `latest` publication.
