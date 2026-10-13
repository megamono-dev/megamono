import { packageVersion } from '../../../tools/package-version.mjs';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  pinManifest,
  qualificationSummary,
  selectLane,
} from './ui-qualification.mjs';

const workspace = resolve(import.meta.dirname, '../../..');
const compatibility = JSON.parse(
  await readFile(
    join(workspace, 'packages/create-megamono/compatibility.json'),
    'utf8',
  ),
);
const lane = selectLane(process.argv.slice(2), compatibility);
const temporary = await mkdtemp(join(tmpdir(), 'megamono-ui-bootstrap-'));
const consumer = join(temporary, 'consumer');
const store = join(temporary, 'yalc-store');
const reportRoot = join(workspace, 'tmp/ui-bootstrap', lane.name);
const exec = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const put = async (file, value) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof value === 'string' || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(value, null, 2),
  );
};
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('NX_') && key !== 'NODE_ENV' && key !== 'NODE_PATH',
    ),
  ),
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  NEXT_TELEMETRY_DISABLED: '1',
  npm_config_cache: join(temporary, 'npm-cache'),
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  PLAYSTACK_YALC_STORE: store,
  CI: 'true',
};
const run = async (command, args, cwd = consumer) => {
  const result = await exec(command, args, {
    cwd,
    env,
    timeout: 600_000,
    maxBuffer: 24_000_000,
  });
  return result.stdout;
};
const report = {
  lane,
  schemaVersion: 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  runtime: process.version,
  artifacts: [],
  checks: [],
  limitations: [
    'Fixed light color mode; no authentication, cache, database or provider qualification.',
    'TypeScript 6 consumer checks use generated skipLibCheck; TypeScript 7 is unqualified.',
    'Clean installs require the explicit .yalc artifact payload, not a public registry release.',
  ],
};
async function check(id, action) {
  console.log(`UI bootstrap: ${id}`);
  const started = Date.now();
  try {
    const output = String((await action()) ?? 'passed');
    await put(join(reportRoot, `${id}.log`), output);
    report.checks.push({
      id,
      status: 'passed',
      durationMs: Date.now() - started,
      sha256: hash(output),
    });
  } catch (error) {
    await put(
      join(reportRoot, `${id}.log`),
      `${error.stack}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`,
    );
    report.checks.push({
      id,
      status: 'failed',
      durationMs: Date.now() - started,
    });
    throw error;
  } finally {
    await put(join(reportRoot, 'report.json'), report);
  }
}
async function fingerprint(root, relative = '') {
  const result = {};
  for (const entry of await readdir(join(root, relative), {
    withFileTypes: true,
  })) {
    if (['node_modules', '.git', '.nx', '.next'].includes(entry.name)) continue;
    const file = join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(join(root, file));
      const resolved = resolve(root, dirname(file), target);
      assert(
        !target.startsWith('/') &&
          resolved.startsWith(`${resolve(root)}/`) &&
          !resolved.split('/').includes('node_modules'),
        `External bootstrap symlink: ${file}`,
      );
      result[file] = { symlink: target };
    } else if (entry.isDirectory())
      Object.assign(result, await fingerprint(root, file));
    else result[file] = hash(await readFile(join(root, file)));
  }
  return result;
}
let server;
try {
  await mkdir(reportRoot, { recursive: true });
  report.revision = (await run('git', ['rev-parse', 'HEAD'], workspace)).trim();
  report.dirty = Boolean(
    (await run('git', ['status', '--porcelain'], workspace)).trim(),
  );
  const realYalc = (await run('/usr/bin/which', ['yalc'], workspace)).trim();
  const sourceStore = (await run(realYalc, ['dir'], workspace)).trim();
  await check('isolated-artifacts', async () => {
    // Snapshot only the required real Playstack artifacts; never republish or push them.
    for (const name of [
      'cli',
      'core',
      'i18n',
      'i18n-react',
      'chakra',
      'app-ui',
    ]) {
      const source = join(
        sourceStore,
        'packages/@playstack',
        name,
        '0.1.0-beta.1',
      );
      const destination = join(
        store,
        'packages/@playstack',
        name,
        '0.1.0-beta.1',
      );
      await cp(source, destination, { recursive: true });
      report.artifacts.push({
        package: `@playstack/${name}`,
        files: await fingerprint(destination),
      });
    }
    for (const name of ['plugin', 'create-megamono']) {
      await run(
        realYalc,
        ['publish', '--private', `--store-folder=${store}`],
        join(workspace, 'packages', name),
      );
    }
    // create-megamono invokes `yalc dir` and `yalc add`; keep both in our private store.
    const wrapper = join(temporary, 'bin/yalc');
    await put(
      wrapper,
      `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');if(process.argv[2]==='dir'){console.log(${JSON.stringify(store)});}else{const args=process.argv.slice(2).filter(arg=>!arg.startsWith('--store-folder='));const r=spawnSync(${JSON.stringify(realYalc)},[...args,${JSON.stringify(`--store-folder=${store}`)}],{stdio:'inherit'});process.exit(r.status??1);}\n`,
    );
    await chmod(wrapper, 0o755);
    env.PATH = `${dirname(wrapper)}:${env.PATH}`;
    for (const name of ['@megamono/plugin', 'create-megamono']) {
      const location = join(
        store,
        'packages',
        name,
        await packageVersion(name),
      );
      report.artifacts.push({
        package: name,
        files: await fingerprint(location),
      });
    }
  });
  const toolRoot = join(temporary, 'tools');
  await put(join(toolRoot, 'package.json'), {
    private: true,
    dependencies: {
      npm: compatibility.packageManagers.npm,
      'create-megamono': `file:${store}/packages/create-megamono/${await packageVersion('create-megamono')}`,
      '@playstack/cli': `file:${store}/packages/@playstack/cli/0.1.0-beta.1`,
    },
  });
  // Install packed copies, not symlinks whose dependency lookup could escape the fixture.
  await check('install-clis', () =>
    run('npm', ['install', '--install-links', '--ignore-scripts'], toolRoot),
  );
  env.PATH = `${join(toolRoot, 'node_modules/.bin')}:${env.PATH}`;
  report.packageManager = (await run('npm', ['--version'], toolRoot)).trim();
  const create = join(toolRoot, 'node_modules/create-megamono/dist/cli.js');
  const playstack = join(toolRoot, 'node_modules/@playstack/cli/dist/bin.js');
  await check('create-workspace', () =>
    run(
      process.execPath,
      [
        create,
        'consumer',
        'site:site',
        '--router=app',
        '--styling=chakra',
        '--package-manager=npm',
        '--local-packages=yalc',
        '--interactive=false',
        '--verify=none',
      ],
      temporary,
    ),
  );
  await put(
    join(consumer, '.npmrc'),
    '@playstack:registry=http://127.0.0.1:9\n@megamono:registry=http://127.0.0.1:9\nfetch-retries=0\n',
  );
  const themeFile = join(consumer, 'packages/theme/src/lib/system.ts');
  const originalTheme = await readFile(themeFile, 'utf8');
  await check('select-version-combination', async () => {
    const rootFile = join(consumer, 'package.json');
    const manifest = JSON.parse(await readFile(rootFile, 'utf8'));
    await put(join(reportRoot, 'scaffold-package.json'), manifest);
    const theme = JSON.parse(
      await readFile(join(consumer, 'packages/theme/package.json'), 'utf8'),
    );
    // Recipes install at the workspace root. Reuse the generated theme's peers
    // there, instead of letting npm introduce a second Chakra context version.
    manifest.dependencies = { ...manifest.dependencies, ...theme.dependencies };
    const selectedManifest = pinManifest(manifest, lane.versions, true);
    await put(rootFile, selectedManifest);
    await put(join(reportRoot, 'selected-package.json'), selectedManifest);
    for (const file of [
      'apps/site/package.json',
      'packages/theme/package.json',
    ]) {
      const destination = join(consumer, file);
      await put(
        destination,
        pinManifest(
          JSON.parse(await readFile(destination, 'utf8')),
          lane.versions,
        ),
      );
    }
    // Resolve independently of the scaffold's old locked/installed peer graph.
    await rename(
      join(consumer, 'node_modules'),
      join(temporary, 'scaffold-node-modules'),
    );
    await rename(
      join(consumer, 'package-lock.json'),
      join(temporary, 'scaffold-package-lock.json'),
    );
    await run('npm', ['install', '--ignore-scripts']);
    return JSON.stringify(lane);
  });
  const recipe = (capability) => [
    playstack,
    'add',
    capability,
    '--web=apps/site',
    '--adapter=light',
    '--local-packages=yalc',
  ];
  for (const capability of ['chakra', 'app-ui']) {
    await check(`${capability}-plan`, async () => {
      const before = await fingerprint(consumer);
      const output = await run(process.execPath, [
        ...recipe(capability),
        '--dry-run',
        '--json',
      ]);
      const plan = JSON.parse(output);
      assert.equal(plan.writes, false);
      assert.deepEqual(await fingerprint(consumer), before);
      return output;
    });
    await check(`${capability}-install`, () =>
      run(process.execPath, [...recipe(capability), '--yes']),
    );
  }
  const integrate = [
    'exec',
    'nx',
    '--',
    'generate',
    '@megamono/plugin:playstack-integrate',
    '--packages=@playstack/chakra,@playstack/app-ui',
    '--web=apps/site',
    '--adapters=light',
    '--decisions=' +
      JSON.stringify({
        'ui.router': 'next-app',
        'ui.existingTheme':
          'Retain packages/theme; the generated client provider will delegate to the integrated provider with this system.',
        'ui.colorMode': 'light',
        'ui.collection.authority':
          'Public fixture rows; no private data or authorization claim.',
        'ui.localization': 'English defaults',
      }),
  ];
  await check('integration-plan', async () => {
    const before = await fingerprint(consumer);
    const output = await run('npm', [...integrate, '--planOnly']);
    assert.deepEqual(await fingerprint(consumer), before);
    return output;
  });
  await check('integrate-templates', () => run('npm', [...integrate, '--yes']));
  const integratedTheme = join(consumer, 'apps/site/src/playstack/ui/theme.ts');
  await check('compose-and-preserve-theme', async () => {
    assert.equal(await readFile(themeFile, 'utf8'), originalTheme);
    // Application-owned composition: keep one provider and the scaffold's existing theme.
    await put(
      integratedTheme,
      `'use client';\nexport { megamonoSystem as appSystem } from '@consumer/theme';\n`,
    );
    await put(
      join(consumer, 'apps/site/src/app/providers.tsx'),
      `'use client';\nexport { AppUIProvider as Providers } from '../playstack/ui/provider';\n`,
    );
    const layout = join(consumer, 'apps/site/src/app/layout.tsx');
    await put(
      layout,
      (await readFile(layout, 'utf8')).replace(
        '<html lang="en">',
        '<html lang="en" className="light" style={{ colorScheme: "light" }}>',
      ),
    );
    const retained = await readFile(integratedTheme, 'utf8');
    await run(process.execPath, [...recipe('app-ui'), '--yes']);
    // Customized templates need reviewed equivalence, never implicit overwrite.
    await assert.rejects(
      run('npm', [...integrate, '--yes']),
      /already exists with repository-owned content/,
    );
    assert.equal(await readFile(integratedTheme, 'utf8'), retained);
    await run('npm', [
      ...integrate,
      '--equivalences=' +
        JSON.stringify({
          '@playstack/chakra:chakra-theme:ui-theme':
            'existing:apps/site/src/playstack/ui/theme.ts',
        }),
      '--yes',
    ]);
    assert.equal(await readFile(integratedTheme, 'utf8'), retained);
    assert.equal(await readFile(themeFile, 'utf8'), originalTheme);
  });
  await put(
    join(consumer, 'apps/site/src/app/collection/page.tsx'),
    `import Link from 'next/link';\nimport { ItemCollection } from '../../playstack/ui/collection';\nexport default function Page() { return <main><h1>Recipe collection</h1><Link href="/">Home</Link><ItemCollection items={[{id:'alpha',name:'Alpha'},{id:'beta',name:'Beta'}]} /></main>; }\n`,
  );
  const clean = join(temporary, 'clean');
  await check('clean-artifact-bootstrap', async () => {
    await cp(consumer, clean, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) =>
        !source
          .split('/')
          .some((part) =>
            ['node_modules', '.git', '.nx', '.next'].includes(part),
          ),
    });
    await put(
      join(reportRoot, 'bootstrap.sha256.json'),
      await fingerprint(clean),
    );
    await put(
      join(reportRoot, 'package-lock.json'),
      await readFile(join(clean, 'package-lock.json')),
    );
    await rename(store, `${store}-unavailable`);
    await rename(consumer, `${consumer}-unavailable`);
    const before = await readFile(join(clean, 'package-lock.json'), 'utf8');
    const output = await run('npm', ['ci', '--ignore-scripts'], clean);
    assert.equal(
      await readFile(join(clean, 'package-lock.json'), 'utf8'),
      before,
    );
    return output;
  });
  const request = createRequire(join(clean, 'package.json'));
  const executable = (name, command) => {
    const file = request.resolve(`${name}/package.json`);
    const manifest = request(file);
    return resolve(
      dirname(file),
      typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[command],
    );
  };
  report.versions = Object.fromEntries(
    [
      'next',
      'typescript',
      'react',
      '@chakra-ui/react',
      'eslint',
      '@nx/next',
      'eslint-config-next',
      '@eslint/js',
    ].map((name) => [
      name,
      request(join(clean, 'node_modules', name, 'package.json')).version,
    ]),
  );
  await check('selected-versions', () => {
    for (const [name, version] of Object.entries(lane.versions))
      assert.equal(
        report.versions[name],
        version,
        `Unexpected ${name} resolution`,
      );
    const appRequest = createRequire(join(clean, 'apps/site/package.json'));
    const uiRequest = createRequire(
      join(clean, 'node_modules/@playstack/app-ui/package.json'),
    );
    assert.equal(
      appRequest.resolve('@chakra-ui/react'),
      uiRequest.resolve('@chakra-ui/react'),
      'Duplicate Chakra contexts',
    );
  });
  await check('clean-graph', () =>
    run('npm', ['exec', 'nx', '--', 'show', 'projects', '--json'], clean),
  );
  const app = join(clean, 'apps/site');
  await check('lint', () =>
    run(process.execPath, [executable('eslint', 'eslint'), 'src'], app),
  );
  await check('build', () =>
    run(
      process.execPath,
      [executable('next', 'next'), 'build', '--webpack'],
      app,
    ),
  );
  await check('typecheck', () =>
    run(
      process.execPath,
      [executable('typescript', 'tsc'), '--noEmit', '-p', 'tsconfig.json'],
      app,
    ),
  );
  await check('browser', async () => {
    const { chromium, expect } = request('@playwright/test');
    await run(
      process.execPath,
      [executable('@playwright/test', 'playwright'), 'install', 'chromium'],
      clean,
    );
    server = spawn(
      process.execPath,
      [
        executable('next', 'next'),
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        '0',
      ],
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
      origin = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (origin && output.includes('Ready')) break;
      assert.equal(server.exitCode, null, output);
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
      const search = page.getByRole('searchbox', { name: 'Search items' });
      await search.focus();
      await page.keyboard.type('Alpha');
      await expect(
        page.getByRole('rowheader', { name: 'Alpha', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('rowheader', { name: 'Beta', exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole('button', { name: 'Clear search', exact: true })
        .focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('rowheader', { name: 'Beta', exact: true }),
      ).toBeVisible();
      await page.getByRole('link', { name: 'Home' }).click();
      await expect(
        page.getByRole('heading', { name: /ready to build/ }),
      ).toBeVisible();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error.message;
  throw error;
} finally {
  server?.kill('SIGTERM');
  report.qualification = qualificationSummary(report.checks);
  await put(join(reportRoot, 'report.json'), report);
  await rm(temporary, { recursive: true, force: true });
}
