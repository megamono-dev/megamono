import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '../../..');
const playstackPackages = [
  '@playstack/cli',
  '@playstack/content',
  '@playstack/lint',
  '@playstack/skills',
];
const developmentPackages = [
  '@playstack/cli',
  '@playstack/lint',
  '@playstack/skills',
];
const expectedPlaystackVersion = '0.1.0-beta.1';

function runResult(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspaceRoot,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolvePromise({ code, signal, stdout, stderr }),
    );
  });
}

async function run(command, args, options = {}) {
  const result = await runResult(command, args, options);
  if (result.code === 0) return result;
  throw new Error(
    [
      `${command} ${args.join(' ')} exited ${
        result.code === null
          ? `after signal ${result.signal ?? 'unknown'}`
          : result.code
      }`,
      result.stdout.trim(),
      result.stderr.trim(),
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function digestPath(path) {
  const details = await stat(path);
  if (details.isFile()) {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  }
  const entries = await readdir(path, { withFileTypes: true });
  const content = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    content.push(`${entry.name}:${await digestPath(join(path, entry.name))}`);
  }
  return createHash('sha256').update(content.join('\n')).digest('hex');
}

async function snapshot(fixtureRoot, manager) {
  const lockfile = manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
  const paths = [
    'package.json',
    lockfile,
    'eslint.config.mjs',
    'playstack.json',
    '.playstack/skills.json',
    '.agents/skills',
  ];
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        await digestPath(resolve(fixtureRoot, path)),
      ]),
    ),
  );
}

async function contentSnapshot(fixtureRoot) {
  const contentRoot = resolve(fixtureRoot, 'packages/editorial-content');
  const paths = [
    'project.json',
    'package.json',
    'content-collections.ts',
    'build-content.mjs',
    'schemas/article.ts',
  ];
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        await digestPath(resolve(contentRoot, path)),
      ]),
    ),
  );
}

function managerCommand(manager, executable, args) {
  return manager === 'npm'
    ? ['npm', ['exec', executable, '--', ...args]]
    : ['pnpm', ['exec', executable, ...args]];
}

async function invoke(manager, executable, args, options) {
  const [command, commandArgs] = managerCommand(manager, executable, args);
  return run(command, commandArgs, options);
}

async function assertYalcStore(yalcStore) {
  for (const packageName of playstackPackages) {
    const packageJsonPath = resolve(
      yalcStore,
      'packages',
      ...packageName.split('/'),
      expectedPlaystackVersion,
      'package.json',
    );
    assert(
      await exists(packageJsonPath),
      `${packageName}@${expectedPlaystackVersion} is missing from ${yalcStore}. Publish Playstack with yalc before running this fixture.`,
    );
    const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    assert(
      manifest.name === packageName &&
        manifest.version === expectedPlaystackVersion,
      `Invalid yalc artifact at ${packageJsonPath}.`,
    );
  }
}

async function createFixture(
  temporaryRoot,
  manager,
  pluginTarball,
  environment,
) {
  const fixtureRoot = resolve(temporaryRoot, `${manager}-workspace`);
  await mkdir(fixtureRoot, { recursive: true });
  await writeJson(resolve(fixtureRoot, 'package.json'), {
    name: `megamono-playstack-${manager}-fixture`,
    private: true,
    type: 'module',
    packageManager: manager === 'npm' ? 'npm@11.17.0' : 'pnpm@11.24.0',
    workspaces: ['packages/*'],
    dependencies: {},
    devDependencies: {
      '@megamono/plugin': `file:${pluginTarball}`,
      eslint: '9.39.3',
      nx: '23.1.1',
      typescript: '6.0.3',
    },
  });
  await writeJson(resolve(fixtureRoot, 'nx.json'), {
    $schema: './node_modules/nx/schemas/nx-schema.json',
    plugins: [],
  });
  await writeJson(resolve(fixtureRoot, 'tsconfig.base.json'), {
    compilerOptions: {
      baseUrl: '.',
      paths: {},
    },
  });
  await writeJson(resolve(fixtureRoot, 'megamono.json'), {
    $schema: './node_modules/@megamono/plugin/schemas/megamono.schema.json',
    version: 1,
    conventions: {
      nestFeatureLibraries: true,
      docsLocation: 'centralized',
      packageManager: manager,
      rules: {},
    },
    adoption: {
      modules: ['lint', 'skills'],
      reductions: [],
      inference: {},
      ratchets: [],
    },
    platforms: ['node'],
    topics: { extend: [] },
    docs: { root: 'docs', reportRetentionDays: 84 },
    health: {
      cadence: 'weekly',
      stalePlanDays: 30,
      checks: {},
      suppressions: [],
    },
    services: { runner: 'none', requirements: {} },
  });
  await writeFile(
    resolve(fixtureRoot, 'eslint.config.mjs'),
    'export default [];\n',
  );
  await writeFile(
    resolve(fixtureRoot, 'core.js'),
    'export const ambientConfiguration = process.env.PLAYSTACK_FIXTURE;\n',
  );
  if (manager === 'pnpm') {
    await writeFile(
      resolve(fixtureRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n\nautoInstallPeers: true\nallowBuilds:\n  esbuild: true\n  nx: true\n  unrs-resolver: true\n',
    );
  }

  await run('yalc', ['add', '@playstack/content', '--no-pure'], {
    cwd: fixtureRoot,
    env: environment,
  });
  await run('yalc', ['add', ...developmentPackages, '--dev', '--no-pure'], {
    cwd: fixtureRoot,
    env: environment,
  });
  await run(manager, ['install'], { cwd: fixtureRoot, env: environment });

  const before = JSON.parse(
    await readFile(resolve(fixtureRoot, 'package.json'), 'utf8'),
  );
  assert(
    before.dependencies['@playstack/content'] ===
      'file:.yalc/@playstack/content',
    `${manager} fixture did not consume @playstack/content through yalc.`,
  );
  for (const packageName of developmentPackages) {
    assert(
      before.devDependencies[packageName] === `file:.yalc/${packageName}`,
      `${manager} fixture did not consume ${packageName} through yalc.`,
    );
  }

  await invoke(
    manager,
    'nx',
    [
      'generate',
      '@megamono/plugin:playstack-lint',
      '--preset=recommended',
      '--interactive=false',
    ],
    { cwd: fixtureRoot, env: environment },
  );
  const lintConfig = await readFile(
    resolve(fixtureRoot, 'eslint.config.mjs'),
    'utf8',
  );
  assert(
    lintConfig.includes("from '@playstack/lint'") &&
      lintConfig.includes('playstackLintConfigs.recommended'),
    `${manager} fixture did not wire the Playstack recommended lint preset.`,
  );
  const lint = await invoke(manager, 'eslint', ['core.js'], {
    cwd: fixtureRoot,
    env: environment,
  });
  assert(
    lint.stdout.includes('@playstack/no-process-env-in-core') &&
      lint.stdout.includes('warning'),
    `${manager} fixture did not execute the yalc Playstack lint rule in warning mode.`,
  );

  await invoke(
    manager,
    'nx',
    ['generate', '@megamono/plugin:playstack-skills', '--interactive=false'],
    { cwd: fixtureRoot, env: environment },
  );
  assert(
    await exists(
      resolve(fixtureRoot, '.agents/skills/playstack-conventions/SKILL.md'),
    ),
    `${manager} fixture did not synchronize Playstack-owned skills.`,
  );
  assert(
    await exists(resolve(fixtureRoot, '.playstack/skills.json')),
    `${manager} fixture did not create Playstack package-owned state.`,
  );
  if (await exists(resolve(fixtureRoot, '.megamono/artifacts.json'))) {
    const artifacts = await readFile(
      resolve(fixtureRoot, '.megamono/artifacts.json'),
      'utf8',
    );
    assert(
      !artifacts.includes('playstack'),
      `${manager} fixture registered Playstack-owned skills as Megamono artifacts.`,
    );
  }

  const manifest = JSON.parse(
    await readFile(resolve(fixtureRoot, 'package.json'), 'utf8'),
  );
  for (const packageName of developmentPackages) {
    assert(
      manifest.devDependencies[packageName] === `file:.yalc/${packageName}`,
      `${manager} generator replaced the local ${packageName} reference.`,
    );
  }

  const stable = await snapshot(fixtureRoot, manager);
  await invoke(
    manager,
    'nx',
    [
      'generate',
      '@megamono/plugin:playstack-lint',
      '--preset=recommended',
      '--interactive=false',
    ],
    { cwd: fixtureRoot, env: environment },
  );
  await invoke(
    manager,
    'nx',
    ['generate', '@megamono/plugin:playstack-skills', '--interactive=false'],
    { cwd: fixtureRoot, env: environment },
  );
  assert(
    JSON.stringify(await snapshot(fixtureRoot, manager)) ===
      JSON.stringify(stable),
    `${manager} Playstack generators were not stable on rerun.`,
  );

  await invoke(
    manager,
    'nx',
    [
      'generate',
      '@megamono/plugin:content-lib',
      'editorial-content',
      '--no-interactive',
    ],
    { cwd: fixtureRoot, env: environment },
  );
  await invoke(
    manager,
    'nx',
    [
      'generate',
      '@megamono/plugin:content-type',
      'editorial-content',
      'article',
      '--no-interactive',
    ],
    { cwd: fixtureRoot, env: environment },
  );
  const contentRoot = resolve(fixtureRoot, 'packages/editorial-content');
  await run(manager, ['install'], { cwd: fixtureRoot, env: environment });
  const contentManifest = JSON.parse(
    await readFile(resolve(contentRoot, 'package.json'), 'utf8'),
  );
  assert(
    contentManifest.dependencies['@playstack/content'] ===
      'file:../../.yalc/@playstack/content',
    `${manager} content library did not consume @playstack/content through yalc.`,
  );
  const contentProject = `@megamono-playstack-${manager}-fixture/editorial-content`;
  await invoke(manager, 'nx', ['run', `${contentProject}:build`], {
    cwd: fixtureRoot,
    env: environment,
  });
  assert(
    await exists(resolve(contentRoot, '.content-collections/index.js')),
    `${manager} content library did not build its generated import.`,
  );
  const contentStable = await contentSnapshot(fixtureRoot);
  await invoke(
    manager,
    'nx',
    [
      'generate',
      '@megamono/plugin:content-lib',
      'editorial-content',
      '--no-interactive',
    ],
    { cwd: fixtureRoot, env: environment },
  );
  await invoke(
    manager,
    'nx',
    [
      'generate',
      '@megamono/plugin:content-type',
      'editorial-content',
      'article',
      '--no-interactive',
    ],
    { cwd: fixtureRoot, env: environment },
  );
  assert(
    JSON.stringify(await contentSnapshot(fixtureRoot)) ===
      JSON.stringify(contentStable),
    `${manager} content generators were not stable on rerun.`,
  );
}

const temporaryRoot = await mkdtemp(
  join(tmpdir(), 'megamono-playstack-yalc-e2e-'),
);
let succeeded = false;
try {
  const yalcStore = (await run('yalc', ['dir'])).stdout.trim();
  await assertYalcStore(yalcStore);
  const packDirectory = resolve(temporaryRoot, 'pack');
  await mkdir(packDirectory, { recursive: true });
  const packed = JSON.parse(
    (
      await run(
        'npm',
        [
          'pack',
          './packages/plugin',
          '--pack-destination',
          packDirectory,
          '--json',
        ],
        { env: { npm_config_audit: 'false', npm_config_fund: 'false' } },
      )
    ).stdout,
  );
  const pluginTarball = resolve(packDirectory, packed[0].filename);
  const environment = {
    FORCE_COLOR: '0',
    NX_DAEMON: 'false',
    npm_config_audit: 'false',
    npm_config_cache: resolve(temporaryRoot, 'npm-cache'),
    npm_config_fund: 'false',
  };
  for (const manager of ['npm', 'pnpm']) {
    await createFixture(temporaryRoot, manager, pluginTarball, environment);
  }
  succeeded = true;
  process.stdout.write(
    'Playstack yalc e2e passed: packed Megamono generators built content, wired lint, and synchronized skills idempotently with npm and pnpm.\n',
  );
} finally {
  if (succeeded || process.env.MEGAMONO_E2E_KEEP !== 'true') {
    await rm(temporaryRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(
      `Retained failed Playstack fixture: ${temporaryRoot}\n`,
    );
  }
}
