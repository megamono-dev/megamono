import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const workspace = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(workspace, 'package.json'));
const root = mkdtempSync(join(tmpdir(), 'megamono-governance-consumer-'));
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run through npm exec nx.');
const env = {
  ...process.env,
  CI: 'false',
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
};
for (const key of Object.keys(env))
  if (
    key.startsWith('NX_') &&
    !['NX_DAEMON', 'NX_ISOLATE_PLUGINS'].includes(key)
  )
    delete env[key];
const run = (file, args, cwd = root) =>
  execFileSync(file, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 8000000,
    stdio: 'pipe',
  });
const npm = (args, cwd = root) => run(process.execPath, [npmCli, ...args], cwd);
const put = (path, value) => {
  const file = join(root, path);
  const previous = existsSync(file)
    ? Math.floor(statSync(file).mtimeMs / 1000)
    : 0;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );
  // Nx's persisted file hashes can reuse a same-second modification time.
  // Model distinct edits without sleeps or clearing the graph/task caches.
  const modified = Math.max(Math.floor(Date.now() / 1000), previous + 1);
  utimesSync(file, modified, modified);
};
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
try {
  const [{ filename }] = JSON.parse(
    npm(
      ['pack', '--ignore-scripts', '--json', '--pack-destination', root],
      join(workspace, 'packages/plugin'),
    ),
  );
  put('package.json', {
    private: true,
    devDependencies: {
      '@megamono/plugin': `file:./${filename}`,
      ...Object.fromEntries(
        ['nx', '@nx/devkit', '@nx/js', 'typescript'].map((name) => [
          name,
          require(`${name}/package.json`).version,
        ]),
      ),
    },
  });
  npm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--legacy-peer-deps',
  ]);
  put('nx.json', {});
  put('tsconfig.base.json', {
    compilerOptions: {
      baseUrl: '.',
      paths: { '@fixture/server': ['libs/server/index.ts'] },
    },
  });
  const web = {
    name: 'web',
    projectType: 'library',
    tags: ['type:util', 'scope:shared', 'platform:web'],
  };
  put('libs/web/project.json', web);
  put('libs/server/project.json', {
    name: 'server',
    projectType: 'library',
    tags: ['type:util', 'scope:shared', 'platform:node'],
  });
  put('libs/web/index.ts', 'export const browser = true;\n');
  put('libs/server/index.ts', 'export const server = true;\n');
  const nxPackage = join(root, 'node_modules/nx/package.json');
  const nxBin = resolve(
    dirname(nxPackage),
    JSON.parse(readFileSync(nxPackage, 'utf8')).bin.nx,
  );
  const nx = (args) => run(process.execPath, [nxBin, ...args]);
  nx([
    'g',
    '@megamono/plugin:workspace-init',
    '--only=lint',
    '--bootstrap',
    '--yes',
    '--interactive=false',
  ]);
  assert.equal(read('.megamono/project.json').targets.check.cache, false);
  const check = (errorCode) => {
    let output;
    let failed = false;
    try {
      output = nx(['run', 'megamono:check', '--verbose']);
    } catch (error) {
      if (!errorCode) throw error;
      failed = true;
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    assert.equal(
      failed,
      Boolean(errorCode),
      `Expected ${errorCode ?? 'success'}: ${output}`,
    );
    if (errorCode) assert.match(output, new RegExp(errorCode));
    assert(!output.includes('[local cache]'));
  };
  check();
  check();
  put(
    'libs/web/index.ts',
    "import { server } from '@fixture/server'; export const browser = server;\n",
  );
  check('platform-boundary');
  put('libs/web/index.ts', 'export const browser = true;\n');
  check();
  put('libs/web/project.json', {
    ...web,
    tags: web.tags.filter((tag) => tag !== 'type:util'),
  });
  check('require-tags');
  put('libs/web/project.json', web);
  check();
  put('libs/web/project.json', { ...web, implicitDependencies: ['server'] });
  check('platform-boundary');
  const config = read('megamono.json');
  config.conventions.rules['platform-boundary'] = { severity: 'warning' };
  config.adoption.ratchets = [
    { rule: 'platform-boundary', initialCount: 0, targetSeverity: 'error' },
  ];
  put('megamono.json', config);
  check('adoption-ratchet-exceeded');
  config.adoption.ratchets[0].initialCount = 1;
  put('megamono.json', config);
  check();
  config.conventions.rules['require-tags'] = { severity: 'warning' };
  put('megamono.json', config);
  put('libs/web/project.json', {
    ...web,
    tags: web.tags.filter((tag) => tag !== 'scope:shared'),
  });
  check('adoption-ratchet-exceeded');
  put('libs/web/project.json', web);
  config.adoption.ratchets[0].initialCount = 0;
  put('megamono.json', config);
  check();
  console.log(
    'Packed generated governance target recomputes imports, tags, edges, removals and warning budgets without cache reuse.',
  );
} catch (error) {
  console.error(error.stdout?.toString(), error.stderr?.toString());
  throw error;
} finally {
  if (process.env.MEGAMONO_E2E_KEEP === 'true')
    console.error(`Retained governance fixture: ${root}`);
  else rmSync(root, { recursive: true, force: true });
}
