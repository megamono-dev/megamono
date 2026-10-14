# `create-megamono`

Create a new Megamono workspace: an Nx monorepo with conventions,
documentation, and governance configured from the first commit.

```sh
npm create megamono@next my-workspace
# or
npx create-megamono@next my-workspace
pnpm create megamono@next my-workspace
```

Early releases use the `next` dist-tag. Use `@latest` after a stable release
has been published.

The guided flow selects named applications, optional publishable TypeScript
packages, a database adapter, web styling, and local services. Springbar can
optionally configure the requested apps and services; setup never starts them.
Use arrow keys and Enter for menus, and Space to toggle services.

Automation can supply the same decisions up front:

```sh
npx create-megamono@next my-workspace \
  --apps=web,api \
  --database-adapter=prisma \
  --database-name=core \
  --services=postgres,redis \
  --service-runner=none \
  --package-manager=pnpm \
  --interactive=false
```

Use positional `type:name` descriptors to create multiple apps of one type:

```sh
npx create-megamono@next studio site:marketing api web:admin web
```

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
not both. New workspaces use the Node 24, Nx 23.1, and TypeScript 6 scaffold
baseline. Native applications require their platform toolchains to build.

## Related packages

- [`@megamono/cli`](https://github.com/megamono-dev/megamono/tree/main/packages/cli#readme) — the global `megamono` command for existing workspaces
- [`@megamono/plugin`](https://github.com/megamono-dev/megamono/tree/main/packages/plugin#readme) — workspace, docs, conventions, and health generators

## License

MIT © Ryan Hefner
