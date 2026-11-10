# `create-megamono`

Create a new Megamono workspace: an Nx monorepo with conventions,
documentation, and governance configured from the first commit.

[Getting started](https://megamono.com/docs/cli/create-megamono) ·
[Repository structure](https://megamono.com/docs/workflows/repository-structure) ·
[Requirements](https://megamono.com/docs/workflows/requirements)

## When to use this package

Start here when you want a new repository containing applications, publishable
TypeScript packages, or both. The guided setup creates the Nx workspace and
configures the local Megamono plugin. You do not need to install a global CLI first.

For an existing Nx workspace, use
[`@megamono/cli`](https://megamono.com/docs/cli) and the
[adoption workflow](https://megamono.com/docs/workflows/adoption) instead.

## Create your first workspace

Use Node 24 and run the current public prerelease with npm:

```sh
npx create-megamono@next my-workspace
```

The `@next` tag selects the prerelease channel. The default package manager for
the new workspace is npm; pnpm, Yarn, and Bun are also supported through
`--package-manager`. Local workspace creation does not require a hosted account
or Playstack.

Creation installs the exact Nx baseline with matching Nx plugins and verifies
the installed versions before generating applications. The workspace records
its Node runtime in `.nvmrc` and `engines.node`; run `nvm use` after entering
the repository when using nvm. Source export conditions use the workspace's
scope rather than Nx's `@org/source` placeholder.

The guided flow selects named applications, optional publishable TypeScript
packages, a database adapter, web styling, and local services. Springbar can
optionally configure the requested apps and services; setup never starts them.
Use arrow keys and Enter for menus, and Space to toggle services.

After setup, explore the generated projects:

```sh
cd my-workspace
npm exec nx -- show projects
```

Use a reported project name with `npm exec nx -- show project <project>` to see
its targets, then run the appropriate development target. Native applications
need their platform toolchains. Review generated environment examples and
database configuration before connecting services.

## Choose a starting shape

Create a web application and API without the guided prompts:

```sh
npx create-megamono@next my-workspace \
  --apps=web,api \
  --database-adapter=prisma \
  --database-name=core \
  --services=postgres,redis \
  --service-runner=none \
  --package-manager=npm \
  --interactive=false
```

Use positional `type:name` descriptors for a marketing site and several apps:

```sh
npx create-megamono@next studio site:marketing api web:admin web
```

Or start a toolkit with publishable packages and no applications:

```sh
npx create-megamono@next toolkit \
  --packages=core,client \
  --package-scope=acme \
  --package-access=public \
  --package-manager=npm \
  --interactive=false
```

Package creation does not publish anything. Add `--dry-run` to preview a setup.
Use `npx create-megamono@next --help` for the full command reference.

## Options

| Option                | Values                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--apps`              | `web`, `api`, `worker`, `mobile`, `desktop`, `apple`, `android`, `site`, `extension`; optional `:name` suffix |
| `--packages`          | Comma-separated TypeScript library names under `packages/`                                                    |
| `--package-scope`     | npm scope for generated libraries                                                                             |
| `--package-access`    | `restricted` (default), `public`; creation does not publish                                                   |
| `--database-adapter`  | `none`, `prisma`, `drizzle`                                                                                   |
| `--database-name`     | Database project name                                                                                         |
| `--styling`           | `chakra`, `emotion`, `tailwind`, `panda`, `stylex`, `css-modules`, `inline`                                   |
| `--router`            | `pages` (default), `app`                                                                                      |
| `--services`          | `postgres`, `redis`, `clickhouse`, `typesense`                                                                |
| `--service-runner`    | `none`, `springbar`                                                                                           |
| `--springbar`         | Shortcut for `--service-runner=springbar`                                                                     |
| `--package-manager`   | `npm`, `pnpm`, `yarn`, `bun`                                                                                  |
| `--directory`         | Target directory for the new workspace                                                                        |
| `--interactive=false` | Disable guided prompts                                                                                        |
| `--dry-run`           | Print the plan without creating a workspace                                                                   |
| `--help`              | Show usage and options                                                                                        |

Use `--apps=` to create without applications and `--packages=` to skip
publishable libraries. Pass app descriptors positionally or through `--apps`,
not both. See the [requirements guide](https://megamono.com/docs/workflows/requirements)
for the scaffold baseline, supported package managers, and platform-specific tools.

## What happens during creation

Megamono builds the workspace from a reviewed plan and configures its applications,
libraries, and repository tooling. Service configuration is optional. It does not
deploy applications, publish packages, start services, or run database migrations.
Application behavior, environment values, credentials, and release approval stay
with your repository.

## Related packages

- [`@megamono/cli`](https://megamono.com/docs/cli) — the `megamono` command for working with an existing workspace
- [`@megamono/plugin`](https://megamono.com/docs/generators) — workspace-local generators, conventions, and checks
- [Platform plugins](https://megamono.com/docs/platforms) — native projects, Workers, browser extensions, Render, and PHP

For help, use the [documentation](https://megamono.com/docs) or
[report an issue](https://github.com/megamono-dev/megamono/issues).

## License

MIT © Ryan Hefner
