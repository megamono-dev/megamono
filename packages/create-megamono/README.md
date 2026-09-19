# `create-megamono`

Create a new Megamono workspace: an Nx monorepo with conventions,
documentation, and governance wired up from the first commit.

```sh
npm create megamono@latest my-workspace
# or
npx create-megamono my-workspace
pnpm create megamono my-workspace
```

The guided flow selects applications, a database adapter, optional local
services, and whether Springbar should configure the requested apps and
services. Automation can supply the same decisions up front:

```sh
npx create-megamono my-workspace \
  --apps=web,api \
  --database-adapter=prisma \
  --database-name=core \
  --services=postgres,redis \
  --service-runner=none \
  --package-manager=pnpm
```

## Options

| Option               | Values                                                       |
| -------------------- | ------------------------------------------------------------ |
| `--apps`             | `web`, `api`, `worker`, `mobile`, `desktop`, `apple`, `site` |
| `--database-adapter` | `none`, `prisma`, `drizzle`                                  |
| `--database-name`    | Any project name                                             |
| `--services`         | `postgres`, `redis`, `clickhouse`, `typesense`               |
| `--service-runner`   | `none`, `springbar`                                          |
| `--package-manager`  | `pnpm` (default), `npm`                                      |
| `--directory`        | Target directory for the new workspace                       |
| `--interactive`      | `false` to take every default without prompting              |
| `--dry-run`          | Print the plan without writing anything                      |

New workspaces are pinned to the Node 24, package-manager 11, Nx 23.1, and
TypeScript 6 scaffold baseline. To adopt Megamono in a workspace that already
exists, use [`@megamono/cli`](https://github.com/megamono-dev/megamono/tree/main/packages/cli#readme)
instead.

## Related packages

- [`@megamono/cli`](https://github.com/megamono-dev/megamono/tree/main/packages/cli#readme) — the global `megamono` command for existing workspaces
- [`@megamono/plugin`](https://github.com/megamono-dev/megamono/tree/main/packages/plugin#readme) — workspace, docs, conventions, and health generators

## License

MIT © Ryan Hefner
