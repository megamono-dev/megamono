# `@megamono/nx-laravel`

Bring Laravel applications and Composer packages into an Nx workspace. Run
PHP tasks beside your other projects and connect local Composer path dependencies
in the Nx graph.

[Documentation](https://megamono.com/docs/platforms/laravel) · [Requirements](https://megamono.com/docs/workflows/requirements)

## When to use it

Choose this plugin to adopt an existing Laravel/Composer project or create a
separate Laravel application inside Nx. PHP, Composer, the application lifecycle,
and deployment remain owned by your repository.

For PHP desktop or mobile applications, pair this package with
[`@megamono/nx-phpnative`](https://megamono.com/docs/platforms/phpnative).

## Get started

Install the public prerelease at the root of a compatible Nx workspace:

```sh
npm install --save-dev @megamono/nx-laravel@next
```

To discover existing applications and packages, merge this registration into
`nx.json`. Do not generate over an existing application:

```json
{
  "plugins": ["@megamono/nx-laravel"]
}
```

```sh
npm exec nx -- show projects
npm exec nx -- show project your-php-project
```

Replace `your-php-project` with a discovered name. The plugin recognizes
repository-owned `composer.json` files; Laravel applications additionally
contain `laravel/framework` and `artisan`.

| Project                | Typical targets                                        |
| ---------------------- | ------------------------------------------------------ |
| Composer package       | `composer-validate`, `composer-install`                |
| Laravel application    | Composer targets plus `test`, `serve`, `laravel-about` |
| Project declaring Pint | `lint`                                                 |

## Create a Laravel application

Preview a new app, then rerun without `--dry-run` to write the scaffold plan:

```sh
npm exec nx -- generate @megamono/nx-laravel:application --name=api --dry-run
```

Fetch the Laravel skeleton explicitly after generating the plan:

```sh
npm exec nx -- run api:setup
```

Generation writes Nx configuration and the setup plan; `setup` fetches the
upstream skeleton without installing Composer dependencies or running scripts.
Review that skeleton, prepare the application's `.env`, and select its PHP and
database configuration before continuing:

```sh
npm exec nx -- run api:composer-install
```

From `apps/api`, generate the Laravel key and install/build frontend assets using
the application's chosen package manager. Composer installation may run upstream
scripts. Database creation, migrations, workers, and deployment are explicit
application steps. Use the reference below for Herd and multiple apps.

## Requirements and help

This is a workspace development dependency. It can be used with Nx without
adopting the core Megamono workspace modules or creating a hosted account.
Examples use npm; retain your workspace's established package manager.

See [requirements and compatibility](https://megamono.com/docs/workflows/requirements)
for supported Node/Nx versions and platform tools, and the
[package guide](https://megamono.com/docs/platforms/laravel) for the full workflow.
For problems, [report an issue](https://github.com/megamono-dev/megamono/issues).

MIT licensed. See [LICENSE](./LICENSE).

## Advanced reference

<details>
<summary>Configuration, execution details, and maintainer qualification</summary>

Initial Laravel/Composer inference and staged application generation for Nx 22/23 and Node 22/24. Composer and PHP remain application-owned. Laravel 13 is the new-app default (PHP 8.3+); `--laravelVersion=^12.0` selects Laravel 12.

### Generate applications

Install this package and its Nx peers in your workspace first. Use your locally installed Nx executable:

```sh
npm exec nx -- generate @megamono/nx-laravel:application --name=api --dry-run
npm exec nx -- generate @megamono/nx-laravel:application --name=api
npm exec nx -- generate @megamono/nx-laravel:application --name=backoffice --directory=apps/php/backoffice
npm exec nx -- run api:setup
npm exec nx -- run backoffice:setup
```

Generation writes only `project.json`, `megamono-laravel.json`, and the plugin registration in `nx.json`. It never invokes Composer, changes global runtimes, installs dependencies, creates credentials, or migrates a database. Occupied project names/paths fail without overwriting files.

The explicit `setup` target downloads the official `laravel/laravel` skeleton into a temporary sibling directory with Composer installation, scripts and plugins disabled. After validation it copies into the otherwise-empty planned app. Completed setup is a no-op. Interrupted copies retain staged source and partial destination for manual recovery; setup never forces an overwrite or deletes application files. Constraints resolve at setup time: commit the resulting application and lockfiles for reproducibility.

After setup, review the upstream skeleton, create `.env` from `.env.example`, set URL/database configuration, and explicitly install dependencies:

```sh
npm exec nx -- run api:composer-install
# From apps/api, using the selected PHP and frontend package manager:
php artisan key:generate
npm install
npm run build
```

Composer installation can execute upstream application scripts. Database creation/migration, workers and deployment are not automated. Each app owns its Composer manifest, lockfile, vendor directory, environment and database. Review frontend workspace membership and lockfile ownership: asset targets initially use upstream npm scripts; pnpm/Yarn users can override `assets-build`/`assets-dev` in `project.json`.

### Herd and multiple apps

```sh
npm exec nx -- generate @megamono/nx-laravel:application --name=portal --runtime=herd --herdDomain=acme-portal --phpVersion=8.4
npm exec nx -- run portal:herd-link
npm exec nx -- run portal:herd-isolate
npm exec nx -- run portal:setup
```

Optional targets run `herd link acme-portal` and `herd isolate 8.4` from the app root only when invoked. With `--runtime=herd`, PHP/Composer targets use `herd php`/`herd composer`. Give each app a distinct Herd name and matching `APP_URL`. Herd serves the linked Laravel app without Nx running `artisan serve` alongside it. No Springbar or Herd settings change automatically. See [Herd's CLI documentation](https://herd.laravel.com/docs/macos/advanced-usage/herd-cli).

### Adopt existing applications

Register the plugin without running generation over existing files:

```json
{
  "plugins": [
    {
      "plugin": "@megamono/nx-laravel",
      "options": { "runtime": "herd", "scope": "shared" }
    }
  ]
}
```

Owned `composer.json` files become PHP projects. `laravel/framework` plus `artisan` identifies an application; ordinary Composer packages remain libraries. Targets include `composer-validate`, `composer-install`, Laravel `test`, `serve`, `laravel-about`, and Pint `lint` when declared. Explicit `project.json` targets are the place for application overrides. All inferred commands disable caching because tests/framework commands can affect external state.

Composer `path` repositories add graph edges only to actually required local package names. Explicit paths and `*` patterns are supported; complex globs require review. Vendor, node_modules, Yalc, build output and generated NativePHP trees are excluded.

### Initial scope

Not yet integrated into `create-megamono` shorthand or `megamono add`. Shared Composer/Blade library generation, Inertia cross-language edges, deployment scaffolding and native Windows command execution qualification remain follow-on work. See `@megamono/nx-phpnative` for separate desktop/mobile app roots.

</details>
