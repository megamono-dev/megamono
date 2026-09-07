import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { writeJson } from '@nx/devkit';
import { initGenerator as initTypeScript } from '@nx/js';
import { satisfies } from 'semver';

const workspace = resolve(import.meta.dirname, '../../..');
const root = await mkdtemp(join(tmpdir(), 'megamono-web-ui-'));
const consumer = join(root, 'consumer');
const reportRoot = join(workspace, 'tmp/web-ui-consumer');
const compatibility = JSON.parse(
  await readFile(join(workspace, 'packages/plugin/compatibility.json'), 'utf8'),
);
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('NX_') && key !== 'NODE_ENV',
    ),
  ),
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  NEXT_TELEMETRY_DISABLED: '1',
  npm_config_cache: join(root, 'npm-cache'),
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  CI: 'true',
};
const exec = promisify(execFile);
const run = async (command, args, cwd = consumer) =>
  (
    await exec(command, args, {
      cwd,
      env,
      timeout: 300_000,
      maxBuffer: 12_000_000,
    })
  ).stdout;
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const digest = (content) => createHash('sha256').update(content).digest('hex');
const put = async (path, content) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    typeof content === 'string' || Buffer.isBuffer(content)
      ? content
      : JSON.stringify(content, null, 2),
  );
};
const report = {
  schemaVersion: 1,
  fixture: 'generated-next-playstack-ui',
  runtime: process.version,
  startedAt: new Date().toISOString(),
  checks: [],
  packages: [],
  status: 'partial',
  limitations: [
    'Generation uses the local Nx toolchain with the packed Megamono plugin; runtime dependencies install independently.',
    'Explicit Yalc package selection substitutes for the still-separate Playstack UI recipe. No recipe qualification is claimed.',
    'TypeScript 7 is not qualified by this TypeScript 6 lane.',
  ],
};
const check = async (id, action) => {
  console.log(`Web UI consumer: ${id}`);
  const started = Date.now();
  try {
    const output = String((await action()) ?? 'passed');
    await put(join(reportRoot, `${id}.log`), output);
    report.checks.push({
      id,
      status: 'passed',
      durationMs: Date.now() - started,
      sha256: digest(output),
    });
  } catch (error) {
    const output = `${error.stack}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    await put(join(reportRoot, `${id}.log`), output);
    report.checks.push({
      id,
      status: 'failed',
      durationMs: Date.now() - started,
      sha256: digest(output),
    });
    throw error;
  }
};
let server;
let yalcAdded = false;
try {
  await mkdir(consumer, { recursive: true });
  await mkdir(reportRoot, { recursive: true });
  report.sourceRevision = (
    await run('git', ['rev-parse', 'HEAD'], workspace)
  ).trim();
  report.sourceDirty = Boolean(
    (await run('git', ['status', '--porcelain'], workspace)).trim(),
  );
  const packed = JSON.parse(
    await run('npm', [
      'pack',
      join(workspace, 'packages/plugin'),
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      root,
    ]),
  )[0];
  const plugin = join(root, 'packed-plugin');
  await mkdir(plugin);
  await run('tar', [
    '-xzf',
    join(root, packed.filename),
    '-C',
    plugin,
    '--strip-components=1',
  ]);
  await symlink(
    join(workspace, 'node_modules'),
    join(plugin, 'node_modules'),
    'dir',
  );
  report.pluginTarballSha256 = digest(
    await readFile(join(root, packed.filename)),
  );
  const { appGenerator } = createRequire(join(plugin, 'package.json'))(
    './dist/generators/app/app.js',
  );
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    name: 'web-ui-consumer',
    private: true,
    workspaces: ['apps/*', 'packages/*'],
    packageManager: `npm@${compatibility.packageManagers.npm}`,
    devDependencies: { nx: compatibility.scaffoldPackages.nx },
  });
  await check('generate-both-routers', async () => {
    // The testing helper's empty config is not the TypeScript workspace preset.
    // Initialize Nx's real base config (including its declaration-check policy).
    tree.delete('tsconfig.base.json');
    await initTypeScript(tree, {
      addTsConfigBase: true,
      addPlugin: false,
      addTsPlugin: false,
      skipFormat: true,
    });
    for (const router of ['app', 'pages'])
      await appGenerator(tree, {
        type: 'site',
        name: router,
        router,
        scope: 'fixture',
        styling: 'chakra',
        bootstrap: true,
        interactive: false,
        yes: true,
      });
    for (const change of tree.listChanges())
      if (change.type !== 'DELETE')
        await put(join(consumer, change.path), change.content);
    assert(tree.exists('apps/app/src/app/providers.tsx'));
    assert(tree.exists('apps/pages/src/pages/_app.tsx'));
  });
  const store = (await run('yalc', ['dir'])).trim();
  const closure = new Map();
  async function visit(name, range = '0.1.0-beta.1') {
    if (closure.has(name)) {
      assert(
        satisfies(closure.get(name).version, range),
        `Incompatible closure for ${name}`,
      );
      return;
    }
    const directory = join(store, 'packages', name, '0.1.0-beta.1');
    const manifest = await json(join(directory, 'package.json'));
    assert(
      satisfies(manifest.version, range),
      `Unsupported ${name}@${manifest.version}`,
    );
    closure.set(name, manifest);
    report.packages.push({
      name,
      version: manifest.version,
      manifestSha256: digest(await readFile(join(directory, 'package.json'))),
      yalcSignature: await readFile(join(directory, 'yalc.sig'), 'utf8'),
    });
    for (const [dependency, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.peerDependencies,
    }))
      if (
        dependency.startsWith('@playstack/') &&
        !manifest.peerDependenciesMeta?.[dependency]?.optional
      )
        await visit(dependency, version);
  }
  await check('yalc-closure', async () => {
    await visit('@playstack/chakra');
    await visit('@playstack/app-ui');
    yalcAdded = true;
    return run('yalc', ['add', ...closure.keys(), '--pure']);
  });
  const manifest = await json(join(consumer, 'package.json'));
  const themeManifestPath = join(consumer, 'packages/theme/package.json');
  const themeManifest = await json(themeManifestPath);
  manifest.dependencies = {
    ...manifest.dependencies,
    // Reuse the scaffold's provider versions for root-installed UI peers.
    // Two Chakra copies create distinct contexts even with matching peer majors.
    ...themeManifest.dependencies,
    ...Object.fromEntries(
      [...closure.keys()].map((name) => [name, `file:.yalc/${name}`]),
    ),
  };
  manifest.devDependencies = {
    ...manifest.devDependencies,
    typescript: compatibility.scaffoldPackages.typescript,
  };
  assert(
    manifest.devDependencies['@playwright/test'],
    'Generated Playwright dependency is required.',
  );
  await put(join(consumer, 'package.json'), manifest);
  themeManifest.dependencies['@playstack/chakra'] =
    'file:../../.yalc/@playstack/chakra';
  await put(themeManifestPath, themeManifest);
  for (const router of ['app', 'pages']) {
    const path = join(consumer, 'apps', router, 'package.json');
    const appManifest = await json(path);
    appManifest.dependencies['@playstack/app-ui'] =
      'file:../../.yalc/@playstack/app-ui';
    await put(path, appManifest);
  }
  // Product-owned custom theme: never serialize a Chakra system from a server component.
  await put(
    join(consumer, 'packages/theme/src/lib/system.ts'),
    `import { createPlaystackSystem } from '@playstack/chakra';\nexport const megamonoSystem = createPlaystackSystem({ theme: { tokens: { colors: { brand: { value: '#663399' } } } }, globalCss: { body: { color: '#111', background: '#fff' } } });\n`,
  );
  await check('install', () => run('npm', ['install', '--ignore-scripts']));
  report.lockfileSha256 = digest(
    await readFile(join(consumer, 'package-lock.json')),
  );
  await put(
    join(reportRoot, 'package-lock.json'),
    await readFile(join(consumer, 'package-lock.json')),
  );
  const request = createRequire(join(consumer, 'package.json'));
  await check('shared-chakra-context', () => {
    const uiRequest = createRequire(
      join(consumer, 'node_modules/@playstack/app-ui/package.json'),
    );
    for (const router of ['app', 'pages']) {
      const appRequest = createRequire(
        join(consumer, 'apps', router, 'package.json'),
      );
      assert.equal(
        appRequest.resolve('@chakra-ui/react'),
        uiRequest.resolve('@chakra-ui/react'),
      );
    }
  });
  const executable = (name, command) => {
    const metadata = request(`${name}/package.json`);
    return resolve(
      dirname(request.resolve(`${name}/package.json`)),
      typeof metadata.bin === 'string' ? metadata.bin : metadata.bin[command],
    );
  };
  report.versions = Object.fromEntries(
    [
      'typescript',
      'next',
      'react',
      '@chakra-ui/react',
      'eslint',
      '@playwright/test',
    ].map((name) => [name, request(`${name}/package.json`).version]),
  );
  const typescript = executable('typescript', 'tsc');
  assert(request('typescript/package.json').version.startsWith('6.0.'));
  const next = executable('next', 'next');
  const eslint = executable('eslint', 'eslint');
  await check('consumer-graph', () =>
    run('npm', ['exec', 'nx', '--', 'show', 'projects', '--json']),
  );
  env.NODE_ENV = 'production';
  const demo = `'use client';\nimport { useState } from 'react';\nimport Link from 'next/link';\nimport { SearchField, DataTable, CollectionPagination } from '@playstack/app-ui';\nexport default function Collection() { const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const rows = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }].filter(row => row.name.toLowerCase().includes(query.toLowerCase())); return <main><h1>Collection fixture</h1><Link href="/">Home</Link><SearchField label="Find records" value={query} onValueChange={setQuery}/><DataTable label="Records" rows={rows} columns={[{ id: 'name', header: 'Name', cell: row => row.name }]} getRowId={row => row.id}/><CollectionPagination label="Pagination" summary={'Page ' + page} hasPrevious={page > 1} hasNext={page < 2} onPrevious={() => setPage(page - 1)} onNext={() => setPage(page + 1)} /></main>; }\n`;
  for (const router of ['app', 'pages']) {
    const app = join(consumer, 'apps', router);
    await put(
      join(
        app,
        router === 'app'
          ? 'src/app/collection/page.tsx'
          : 'src/pages/collection.tsx',
      ),
      demo,
    );
    await check(`${router}-lint`, () =>
      run(process.execPath, [eslint, 'src'], app),
    );
    await check(`${router}-build`, () =>
      run(process.execPath, [next, 'build', '--webpack'], app),
    );
    await check(`${router}-typecheck`, () =>
      run(
        process.execPath,
        [typescript, '--noEmit', '-p', 'tsconfig.json'],
        app,
      ),
    );
    await check(`${router}-browser`, async () => {
      const { chromium } = request('@playwright/test');
      const playwright = executable('@playwright/test', 'playwright');
      await run(process.execPath, [playwright, 'install', 'chromium']);
      server = spawn(
        process.execPath,
        [next, 'start', '--hostname', '127.0.0.1', '--port', '0'],
        { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      server.stdout.on('data', (chunk) => {
        output += chunk;
      });
      server.stderr.on('data', (chunk) => {
        output += chunk;
      });
      let origin;
      for (let attempt = 0; attempt < 300; attempt++) {
        origin = output.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[0];
        if (origin && output.includes('Ready')) break;
        if (server.exitCode !== null) throw Error(output);
        await new Promise((done) => setTimeout(done, 100));
      }
      assert(origin && output.includes('Ready'), output);
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(`${origin}/collection`);
        await page
          .getByRole('heading', { name: 'Collection fixture' })
          .waitFor();
        const search = page.getByRole('searchbox', { name: 'Find records' });
        await search.fill('Alpha');
        await page.getByRole('cell', { name: 'Alpha', exact: true }).waitFor();
        assert.equal(
          await page.getByRole('cell', { name: 'Beta', exact: true }).count(),
          0,
        );
        await page.getByRole('button', { name: 'Next', exact: true }).focus();
        await page.keyboard.press('Enter');
        await page.getByText('Page 2', { exact: true }).waitFor();
        await page.getByRole('link', { name: 'Home', exact: true }).click();
        await page.getByRole('heading', { name: /ready to build/ }).waitFor();
        assert.deepEqual(errors, []);
        return `Hydration, collection filtering, keyboard pagination, and navigation passed at ${origin}`;
      } finally {
        await browser.close();
        server.kill('SIGTERM');
        server = undefined;
      }
    });
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error.message;
  throw error;
} finally {
  server?.kill('SIGTERM');
  await put(join(reportRoot, 'report.json'), report);
  if (yalcAdded) await run('yalc', ['remove', '--all']).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
