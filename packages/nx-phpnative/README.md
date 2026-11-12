# `@megamono/nx-phpnative`

Add separate NativePHP desktop and mobile applications to an Nx workspace.
Built on `@megamono/nx-laravel`, this plugin provides native app planning and
inferred NativePHP targets while keeping each app's Laravel root independent.

[Documentation](https://megamono.com/docs/platforms/phpnative) · [Requirements](https://megamono.com/docs/workflows/requirements)

## When to use it

Choose this plugin when PHP applications need desktop or mobile shells and you
want their development tasks in the same Nx graph as the rest of your code.
Use `@megamono/nx-laravel` alone for a web/API Laravel application. Desktop,
mobile, and public API applications must have separate runtime roots.

## Get started

Install both plugins at your Nx workspace root. For existing NativePHP apps,
register Laravel first and NativePHP second in your existing `nx.json` list:

```sh
npm install --save-dev @megamono/nx-laravel@next @megamono/nx-phpnative@next
```

```json
{
  "plugins": ["@megamono/nx-laravel", "@megamono/nx-phpnative"]
}
```

Inspect discovered projects before running native commands:

```sh
npm exec nx -- show projects
npm exec nx -- show project your-native-project
```

Replace `your-native-project` with the discovered name. Existing Composer
dependencies determine desktop/mobile inference; legacy NativePHP dependencies
are not silently migrated.

## Create a native application

Preview a desktop app and rerun without `--dry-run` to create its plan:

```sh
npm exec nx -- generate @megamono/nx-phpnative:application \
  --name=desktop \
  --platform=desktop \
  --appId=com.example.desktop \
  --dry-run
```

For mobile, choose another name, `--platform=mobile`, and a distinct app ID.
Then run setup for the generated project:

```sh
npm exec nx -- run desktop:setup
```

Setup fetches a Laravel skeleton, adds the selected NativePHP Composer dependency,
and records the app ID in `.env.example`. It does not install dependencies or
native SDKs. Follow the [Laravel setup guide](https://megamono.com/docs/platforms/laravel)
to prepare `.env`, install Composer/frontend dependencies, generate the Laravel
key, and configure the database. Keep `NATIVEPHP_APP_ID` in the local `.env`.

## Run native tooling

After application and host prerequisites are ready, install the native tooling
and launch the desktop app explicitly:

```sh
npm exec nx -- run desktop:native-install
npm exec nx -- run desktop:native-run
```

| Platform | Native targets                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------- |
| Desktop  | `native-install`, `native-run`, `native-build`                                                           |
| Mobile   | `native-install`, `native-run-ios`, `native-run-android`, `native-package-ios`, `native-package-android` |

Native installation can download tools and generate projects. Targets are
non-cacheable; generation is not device, signing, or store-release qualification.
Review the required PHP version, host SDKs, simulators, and native tooling for
the selected platform before running installation or packaging targets.

## Requirements and help

This is a workspace development dependency. It can be used with Nx without
adopting the core Megamono workspace modules or creating a hosted account.
Examples use npm; retain your workspace's established package manager.

See [requirements and compatibility](https://megamono.com/docs/workflows/requirements)
for supported Node/Nx versions and platform tools, and the
[package guide](https://megamono.com/docs/platforms/phpnative) for the full workflow.
For problems, [report an issue](https://github.com/megamono-dev/megamono/issues).

MIT licensed. See [LICENSE](./LICENSE).

## Advanced reference

<details>
<summary>Configuration, execution details, and maintainer qualification</summary>

Initial NativePHP generators and Nx inference, built on `@megamono/nx-laravel`. Each native application gets its own Laravel root; public API, desktop and mobile apps must not share one runtime root.

### Generate

Install both packages and their Nx peers, then use the locally installed Nx executable:

```sh
npm exec nx -- generate @megamono/nx-phpnative:application --name=desktop --platform=desktop --appId=com.example.desktop --dry-run
npm exec nx -- generate @megamono/nx-phpnative:application --name=desktop --platform=desktop --appId=com.example.desktop
npm exec nx -- generate @megamono/nx-phpnative:application --name=mobile --platform=mobile --appId=com.example.mobile --runtime=herd --phpVersion=8.4
npm exec nx -- run desktop:setup
npm exec nx -- run mobile:herd-isolate
npm exec nx -- run mobile:setup
```

Generation only writes a reviewable Nx/scaffold plan. Explicit setup fetches the official Laravel skeleton, adds `nativephp/desktop:^2.0` or `nativephp/mobile:^4.0` to Composer, and writes the app ID to `.env.example`. It does **not** install dependencies or establish native runtime compatibility merely by generating files.

Desktop 2 requires PHP 8.3+; current Mobile 4 requires PHP 8.4+. Laravel 13 is the default, with Laravel 12 selectable via `--laravelVersion=^12.0`. Select the actual PHP runtime before installing. Composer is the authority for resolved PHP/extensions/framework constraints; commit the lockfile. Desktop and mobile packages cannot be combined in one app.

Create/review `.env`, install Composer and frontend dependencies, generate the Laravel key, and configure the database as described by `@megamono/nx-laravel`. Keep `NATIVEPHP_APP_ID` in `.env`. Then install native tooling explicitly:

```sh
npm exec nx -- run desktop:composer-install
npm exec nx -- run desktop:native-install
npm exec nx -- run desktop:native-run

npm exec nx -- run mobile:composer-install
npm exec nx -- run mobile:native-install
npm exec nx -- run mobile:native-run-ios
# Or mobile:native-run-android
```

Native installation may download tools and generate projects. It is never a generator callback, build dependency or automatic setup action. No target adds `--force`. Signing, credentials, OS SDKs, simulators, store submission and database lifecycle remain application responsibilities. Follow the official [Desktop installation](https://nativephp.com/docs/desktop/2/getting-started/installation) and [Mobile installation](https://nativephp.com/docs/mobile/4/getting-started/installation) guides and platform prerequisites.

### Existing projects and targets

Register `@megamono/nx-laravel` first, then `@megamono/nx-phpnative` in `nx.json`. Both accept `runtime: "system" | "herd"` and `scope`. Existing Composer dependencies drive inference. Mixed desktop/mobile roots fail with a diagnostic; legacy `nativephp/electron`/`nativephp/laravel` packages are not silently upgraded.

Desktop adds `native-install`, `native-run`, `native-build`. Mobile adds `native-install`, `native-run-ios`, `native-run-android`, `native-package-ios`, `native-package-android`. All native targets are uncached; launches are continuous. Generated `nativephp/` trees are not independently indexed.

The initial scope is planning, Composer scaffolding and Nx integration, not signed builds or real-device qualification. Test those separately on the intended host/SDKs. No `create-megamono` shorthand, device setup or publishing workflow is introduced.

### Maintainer qualification

From the Megamono source workspace, `npm exec nx -- run nx-phpnative:e2e-php-consumer` builds and packs both plugins, installs them into a disposable consumer, repeats installation with `npm ci`, and tests real Nx generation and graph inference. It requires registry access but no PHP installation. The default fixture uses Nx 23.3.1; set `MEGAMONO_TEST_NX_VERSION=22.2.3` or `MEGAMONO_TEST_NX_VERSION=24.0.4` to select the other supported stable anchors. The compatibility workflow runs all three.

The optional `node packages/nx-phpnative/e2e/consumer.mjs --composer --resolve` mode additionally downloads real Laravel skeletons and resolves desktop/mobile Composer dependencies without installing them or running scripts. Set `MEGAMONO_TEST_PHP` to an explicit PHP 8.4+ executable and `MEGAMONO_TEST_COMPOSER` to the Composer PHP executable/PHAR path. It does not change Herd's global PHP selection. The fixture deletes only its own temporary workspace when complete.

Verified on 2026-09-06: 24 package unit tests, build/lint/type checks, clean packed Nx 22.2.3 and 23.1.1 consumers under Node 24, and real Laravel 13 skeleton/NativePHP dependency resolution with PHP 8.4.13. Herd site registration, Composer script execution, native installation, signing and real-device builds were **not** exercised. PHP requirements should be rechecked against the resolved [Mobile Composer manifest](https://github.com/NativePHP/mobile-air/blob/4.3.2/composer.json) on upgrades.

</details>
