# @megamono/nx-laravel

Initial Laravel/Composer inference and staged application generation for Nx 22/23 and Node 22/24. Composer and PHP remain application-owned. Laravel 13 is the new-app default (PHP 8.3+); `--laravelVersion=^12.0` selects Laravel 12.

## Generate applications

Install this package and its Nx peers in your workspace first. Use your locally installed Nx executable:

```sh
nx g @megamono/nx-laravel:application --name=api --dry-run
nx g @megamono/nx-laravel:application --name=api
nx g @megamono/nx-laravel:application --name=backoffice --directory=apps/php/backoffice
nx run api:setup
nx run backoffice:setup
```

Generation writes only `project.json`, `megamono-laravel.json`, and the plugin registration in `nx.json`. It never invokes Composer, changes global runtimes, installs dependencies, creates credentials, or migrates a database. Occupied project names/paths fail without overwriting files.

The explicit `setup` target downloads the official `laravel/laravel` skeleton into a temporary sibling directory with Composer installation, scripts and plugins disabled. After validation it copies into the otherwise-empty planned app. Completed setup is a no-op. Interrupted copies retain staged source and partial destination for manual recovery; setup never forces an overwrite or deletes application files. Constraints resolve at setup time: commit the resulting application and lockfiles for reproducibility.

After setup, review the upstream skeleton, create `.env` from `.env.example`, set URL/database configuration, and explicitly install dependencies:

```sh
nx run api:composer-install
# From apps/api, using the selected PHP and frontend package manager:
php artisan key:generate
npm install
npm run build
```

Composer installation can execute upstream application scripts. Database creation/migration, workers and deployment are not automated. Each app owns its Composer manifest, lockfile, vendor directory, environment and database. Review frontend workspace membership and lockfile ownership: asset targets initially use upstream npm scripts; pnpm/Yarn users can override `assets-build`/`assets-dev` in `project.json`.

## Herd and multiple apps

```sh
nx g @megamono/nx-laravel:application --name=portal --runtime=herd --herdDomain=acme-portal --phpVersion=8.4
nx run portal:herd-link
nx run portal:herd-isolate
nx run portal:setup
```

Optional targets run `herd link acme-portal` and `herd isolate 8.4` from the app root only when invoked. With `--runtime=herd`, PHP/Composer targets use `herd php`/`herd composer`. Give each app a distinct Herd name and matching `APP_URL`. Herd serves the linked Laravel app without Nx running `artisan serve` alongside it. No Springbar or Herd settings change automatically. See [Herd's CLI documentation](https://herd.laravel.com/docs/macos/advanced-usage/herd-cli).

## Adopt existing applications

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

## Initial scope

Not yet integrated into `create-megamono` shorthand or `megamono add`. Shared Composer/Blade library generation, Inertia cross-language edges, deployment scaffolding and native Windows command execution qualification remain follow-on work. See `@megamono/nx-phpnative` for separate desktop/mobile app roots.
