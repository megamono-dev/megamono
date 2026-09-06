import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

// Opt-in, isolated packed-consumer test. No existing application is touched.
const exec = promisify(execFile);
const workspace = resolve(import.meta.dirname, '../../..');
const root = await mkdtemp(join(tmpdir(), 'megamono-php-consumer-'));
const live = process.argv.includes('--composer');
const env = {
  ...Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  ),
  CI: 'true',
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  NX_INTERACTIVE: 'false',
  npm_config_cache: join(root, '.npm-cache'),
  COMPOSER_HOME: join(root, '.composer'),
  COMPOSER_CACHE_DIR: join(root, '.composer-cache'),
};
const run = async (command, args, cwd = root) => {
  try {
    return (
      await exec(command, args, {
        cwd,
        env,
        timeout: 300_000,
        maxBuffer: 8_000_000,
      })
    ).stdout;
  } catch (error) {
    throw new Error(
      `${command} ${args.join(' ')}\n${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`,
      { cause: error },
    );
  }
};
const put = async (path, value) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(
    join(root, path),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );
};
const json = async (path) =>
  JSON.parse(await readFile(join(root, path), 'utf8'));
try {
  const nxVersion = process.env.MEGAMONO_TEST_NX_VERSION ?? '23.1.1';
  const dependencies = { nx: nxVersion, '@nx/devkit': nxVersion };
  for (const name of ['nx-laravel', 'nx-phpnative']) {
    const packed = JSON.parse(
      await run('npm', [
        'pack',
        join(workspace, 'packages', name),
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        root,
      ]),
    )[0];
    dependencies[`@megamono/${name}`] = `file:./${packed.filename}`;
  }
  await put('package.json', {
    name: 'php-consumer',
    private: true,
    dependencies,
  });
  await put('nx.json', { plugins: [] });
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  // Frozen reinstall proves this is not relying on the publisher's node_modules.
  await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  const require = createRequire(join(root, 'package.json'));
  const nxManifest = require.resolve('nx/package.json');
  const nxBin = resolve(dirname(nxManifest), require(nxManifest).bin.nx);
  const nx = (...args) => run(process.execPath, [nxBin, ...args]);
  for (const name of ['api', 'admin', 'desktop', 'mobile']) {
    const native = ['desktop', 'mobile'].includes(name);
    const args = [
      'g',
      `@megamono/${native ? 'nx-phpnative' : 'nx-laravel'}:application`,
      `--name=${name}`,
      '--interactive=false',
      ...(native ? [`--platform=${name}`, `--appId=com.example.${name}`] : []),
    ];
    if (name === 'api') {
      const before = await readFile(join(root, 'nx.json'), 'utf8');
      await nx(...args, '--dry-run');
      assert.equal(await readFile(join(root, 'nx.json'), 'utf8'), before);
      await assert.rejects(readFile(join(root, 'apps/api/project.json')));
    }
    await nx(...args);
    assert.deepEqual((await readdir(join(root, 'apps', name))).sort(), [
      'megamono-laravel.json',
      'project.json',
    ]);
    if (live) {
      const { materializeLaravel } = require(
        join(root, 'node_modules/@megamono/nx-laravel'),
      );
      const composer = process.env.MEGAMONO_TEST_COMPOSER;
      const php = process.env.MEGAMONO_TEST_PHP;
      assert.ok(
        composer && php,
        '--composer requires explicit MEGAMONO_TEST_PHP and MEGAMONO_TEST_COMPOSER executable paths',
      );
      await materializeLaravel(
        root,
        `apps/${name}`,
        (_tool, commandArgs, cwd) => run(php, [composer, ...commandArgs], cwd),
      );
      await run(
        php,
        [composer, 'validate', '--no-check-publish', '--no-interaction'],
        join(root, 'apps', name),
      );
      const manifest = await json(`apps/${name}/composer.json`);
      if (native)
        assert.equal(
          manifest.require[`nativephp/${name}`],
          name === 'desktop' ? '^2.0' : '^4.0',
        );
      await assert.rejects(readFile(join(root, 'apps', name, '.env')));
      await assert.rejects(readFile(join(root, 'apps', name, 'composer.lock')));
      if (native && process.argv.includes('--resolve')) {
        await run(
          php,
          [
            composer,
            'update',
            '--no-install',
            '--no-scripts',
            '--no-plugins',
            '--no-interaction',
          ],
          join(root, 'apps', name),
        );
        const lock = await json(`apps/${name}/composer.lock`);
        assert.ok(
          lock.packages.some((pkg) => pkg.name === `nativephp/${name}`),
        );
        console.log(
          `Resolved Laravel + NativePHP ${name} dependencies without installing or launching native tools.`,
        );
      }
    } else {
      await put(`apps/${name}/composer.json`, {
        name: `fixture/${name}`,
        require: {
          'laravel/framework': '^13.0',
          ...(native
            ? { [`nativephp/${name}`]: name === 'desktop' ? '^2.0' : '^4.0' }
            : {}),
        },
      });
      await put(`apps/${name}/artisan`, '<?php\n');
    }
  }
  const api = await json('apps/api/composer.json');
  api.repositories = [{ type: 'path', url: '../../libs/contracts' }];
  api.require['fixture/contracts'] = '*';
  await put('apps/api/composer.json', api);
  await put('libs/contracts/composer.json', {
    name: 'fixture/contracts',
    type: 'library',
  });
  await put('apps/mobile/nativephp/generated/composer.json', {
    require: { 'laravel/framework': '^13.0' },
  });
  await put('apps/mobile/nativephp/generated/artisan', '<?php\n');
  const projects = JSON.parse(await nx('show', 'projects', '--json'));
  assert.equal(projects.filter((name) => name.includes('generated')).length, 0);
  for (const name of ['api', 'admin', 'desktop', 'mobile'])
    assert.ok(projects.includes(name));
  const desktop = JSON.parse(await nx('show', 'project', 'desktop', '--json'));
  assert.equal(desktop.targets['native-build'].cache, false);
  assert.equal(desktop.targets.setup.executor, '@megamono/nx-laravel:setup');
  assert.equal(desktop.targets.serve.options.root, 'apps/desktop');
  await nx('graph', '--file=graph.json');
  const graph = await json('graph.json');
  assert.ok(
    graph.graph.dependencies.api.some(
      (edge) => edge.target === 'php-libs-contracts',
    ),
  );
  console.log(
    `Packed PHP consumer passed: frozen npm install, Nx dry-run/generation, four apps, ignored native output and Composer graph edge; Composer skeletons ${live ? 'verified live' : 'not requested'}. Native install/build/device testing was not run.`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
