import { spawn } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '../../..');
const compatibility = JSON.parse(
  await readFile(
    resolve(workspaceRoot, 'packages/plugin/compatibility.json'),
    'utf8',
  ),
);

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
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });
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

function availablePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a local-registry port.'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePromise(address.port);
      });
    });
  });
}

async function waitForRegistry(registry, child, log) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Verdaccio exited before startup.\n${log()}`);
    }
    try {
      const response = await fetch(registry);
      if (response.ok) return;
    } catch {
      // The registry has not bound its socket yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for Verdaccio at ${registry}.\n${log()}`);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stripAnsi(value) {
  const escape = String.fromCharCode(27);
  return value.replaceAll(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

function planLines(value) {
  const lines = stripAnsi(value)
    .split(/\r?\n/)
    .map((line) => line.trim());
  const start = lines.indexOf('## Ordered plan');
  if (start < 0) return [];
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    if (/^\d+\. \*\*/.test(line)) section.push(line);
  }
  return section;
}

async function writeFixture(root) {
  const files = {
    'package.json': `${JSON.stringify(
      {
        name: 'convert-fixture-app',
        private: true,
        scripts: {
          build: 'node src/build.mjs',
          test: 'node --test src/index.test.mjs',
          lint: 'node --check src/index.mjs',
          deploy: 'node src/deploy.mjs',
        },
        devDependencies: {
          '@megamono/plugin': '0.0.1',
          nx: compatibility.scaffoldPackages['create-nx-workspace'],
          typescript: compatibility.scaffoldPackages.typescript,
        },
      },
      null,
      2,
    )}\n`,
    'nx.json': `${JSON.stringify(
      { $schema: './node_modules/nx/schemas/nx-schema.json', plugins: [] },
      null,
      2,
    )}\n`,
    'tsconfig.base.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
        },
      },
      null,
      2,
    )}\n`,
    'tsconfig.json': `${JSON.stringify(
      { extends: './tsconfig.base.json', files: [], references: [] },
      null,
      2,
    )}\n`,
    '.gitignore': 'node_modules/\n.nx/\ndist/\napps/*/dist/\n',
    'src/index.mjs': 'export const answer = 42;\n',
    'src/index.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { answer } from './index.mjs';

test('answer', () => assert.equal(answer, 42));
`,
    'src/build.mjs': `import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await writeFile('dist/artifact.txt', 'built\\n');
`,
    'src/deploy.mjs': "process.stdout.write('deploy fixture\\n');\n",
    'misc/asset.txt': 'application asset\n',
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = resolve(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
}

async function writeImportSource(root) {
  const files = {
    'package.json': `${JSON.stringify(
      {
        name: 'import-probe-source',
        private: true,
        packageManager: 'npm@11.0.0',
        scripts: {
          build: 'node src/index.mjs',
          test: 'node --test src/index.test.mjs',
          lint: 'node --check src/index.mjs',
        },
        dependencies: { '@fixture/host-shared': '*' },
      },
      null,
      2,
    )}\n`,
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          paths: { '@fixture/shared/*': ['./src/*'] },
        },
      },
      null,
      2,
    )}\n`,
    '.env.example': 'SHARED_TOKEN=source-example\nPUBLIC_URL=${SHARED_TOKEN}\n',
    'src/index.mjs':
      "import { hostShared } from '@fixture/host-shared';\nexport const imported = hostShared === 'host-shared';\nconst { SHARED_TOKEN } = process.env;\nexport const token = SHARED_TOKEN;\nexport const directToken = process.env.SHARED_TOKEN;\nexport const loadShared = () => import('@fixture/shared/tool');\nexport const resolveShared = () => require.resolve('@fixture/shared/tool');\n",
    'src/index.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { imported } from './index.mjs';

test('import fixture', () => assert.equal(imported, true));
`,
    'nx.json': `${JSON.stringify({ plugins: ['source-only-plugin'] }, null, 2)}\n`,
    '.github/workflows/source.yml': 'name: Source-only workflow\n',
    'docs/guides/overview.md':
      '# Import probe overview\n\nSource repository documentation.\n',
    'docs/decisions/source-boundary.md': `---
id: decision-20240102-source-boundary
type: decision
status: accepted
visibility: internal
projects: [import-probe-source]
topics: [sessions]
summary: Preserve the source boundary.
date: 2024-01-02
supersedes: null
references: []
external_references: []
---

# Preserve the source boundary
`,
    'docs/INDEX.md': '# Source documentation index\n',
  };
  for (const [path, content] of Object.entries(files)) {
    const absolute = resolve(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
}

function convertArgs(extra = []) {
  return [
    'exec',
    'nx',
    '--',
    'generate',
    '@megamono/plugin:convert',
    'probe-app',
    '--acceptPlan',
    '--resolutions.misc=application',
    '--verify=build',
    '--report=docs/reports/convert.md',
    '--no-interactive',
    ...extra,
  ];
}

const temporaryRoot = await mkdtemp(
  join(tmpdir(), 'megamono-convert-registry-e2e-'),
);
const fixtureRoot = resolve(temporaryRoot, 'fixture');
const npmCache = resolve(temporaryRoot, 'npm-cache');
const npmConfig = resolve(temporaryRoot, 'npmrc');
const registryConfig = resolve(temporaryRoot, 'verdaccio.json');
const port = await availablePort();
const registry = `http://127.0.0.1:${port}`;
await mkdir(fixtureRoot, { recursive: true });
await writeFile(
  npmConfig,
  `registry=${registry}\n//127.0.0.1:${port}/:_authToken=local-e2e-token\n`,
  'utf8',
);
await writeFile(
  registryConfig,
  `${JSON.stringify(
    {
      storage: resolve(temporaryRoot, 'registry-storage'),
      uplinks: { npmjs: { url: 'https://registry.npmjs.org/' } },
      packages: {
        '**': {
          access: '$all',
          publish: '$all',
          unpublish: '$all',
          proxy: 'npmjs',
        },
      },
      log: { type: 'stdout', format: 'pretty', level: 'warn' },
      publish: { allow_offline: true },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const verdaccio = spawn(
  process.execPath,
  [
    resolve(workspaceRoot, 'node_modules/verdaccio/bin/verdaccio'),
    '--config',
    registryConfig,
    '--listen',
    `127.0.0.1:${port}`,
  ],
  {
    cwd: workspaceRoot,
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let registryLog = '';
verdaccio.stdout.on('data', (chunk) => {
  registryLog += chunk;
});
verdaccio.stderr.on('data', (chunk) => {
  registryLog += chunk;
});

let succeeded = false;
try {
  await waitForRegistry(registry, verdaccio, () => registryLog);
  const environment = {
    FORCE_COLOR: '0',
    NX_DAEMON: 'false',
    npm_config_audit: 'false',
    npm_config_cache: npmCache,
    npm_config_fund: 'false',
    npm_config_userconfig: npmConfig,
  };
  await run(
    'npm',
    [
      'publish',
      './packages/plugin',
      '--registry',
      registry,
      '--access',
      'public',
      '--provenance=false',
    ],
    { env: environment },
  );
  await writeFixture(fixtureRoot);
  await run('npm', ['install', '--registry', registry], {
    cwd: fixtureRoot,
    env: environment,
  });

  const git = (...args) =>
    run('git', args, { cwd: fixtureRoot, env: environment });
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Megamono convert fixture');
  await git('config', 'user.email', 'convert-fixture@megamono.com');
  await git('add', '.');
  await git('commit', '-m', 'seed application');
  await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  await git(
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  );

  const defaultBranch = await runResult('npm', convertArgs(), {
    cwd: fixtureRoot,
    env: environment,
  });
  assert(defaultBranch.code === 1, 'Default-branch conversion did not fail.');
  assert(
    `${defaultBranch.stdout}\n${defaultBranch.stderr}`.includes(
      'convert-default-branch',
    ),
    'Default-branch refusal did not retain its Megamono preflight code.',
  );

  await git('switch', '-c', 'convert/probe-app');
  await writeFile(resolve(fixtureRoot, 'dirty.txt'), 'dirty\n', 'utf8');
  const dirty = await runResult('npm', convertArgs(), {
    cwd: fixtureRoot,
    env: environment,
  });
  assert(dirty.code === 1, 'Dirty-tree conversion did not fail.');
  assert(
    `${dirty.stdout}\n${dirty.stderr}`.includes('convert-dirty-tree'),
    'Dirty-tree refusal did not retain its Megamono preflight code.',
  );
  await rm(resolve(fixtureRoot, 'dirty.txt'));

  const unresolved = await runResult(
    'npm',
    convertArgs().filter((value) => !value.startsWith('--resolutions.')),
    { cwd: fixtureRoot, env: environment },
  );
  assert(unresolved.code === 1, 'Unresolved conversion did not fail.');
  assert(
    `${unresolved.stdout}\n${unresolved.stderr}`.includes(
      'convert-unclassified-path',
    ),
    'Unresolved refusal did not retain its Megamono decision code.',
  );

  const dryRun = await run('npm', convertArgs(['--dry-run']), {
    cwd: fixtureRoot,
    env: environment,
  });
  const statusAfterDryRun = await git('status', '--porcelain=v1');
  assert(
    statusAfterDryRun.stdout === '',
    `Dry-run changed the fixture:\n${statusAfterDryRun.stdout}`,
  );

  const execution = await run('npm', convertArgs(), {
    cwd: fixtureRoot,
    env: environment,
  });
  const persistedReport = await readFile(
    resolve(fixtureRoot, 'docs/reports/convert.md'),
    'utf8',
  );
  assert(planLines(dryRun.stdout).length > 0, 'Dry-run omitted its ordered plan.');
  assert(
    JSON.stringify(planLines(dryRun.stdout)) ===
      JSON.stringify(planLines(execution.stdout)),
    'Dry-run and execution emitted different ordered plans.',
  );
  assert(
    JSON.stringify(planLines(persistedReport)) ===
      JSON.stringify(planLines(execution.stdout)),
    'Persisted report and execution emitted different ordered plans.',
  );
  assert(
    await exists(resolve(fixtureRoot, 'apps/probe-app/src/index.mjs')),
    'Application source was not moved.',
  );
  assert(
    await exists(resolve(fixtureRoot, 'apps/probe-app/misc/asset.txt')),
    'Explicit application-owned root was not moved.',
  );
  assert(
    await exists(resolve(fixtureRoot, '.megamono/conversions/probe-app.json')),
    'Conversion marker was not written.',
  );
  assert(
    !(await exists(resolve(fixtureRoot, 'MEGAMONO-RECOVERY.md'))),
    'Successful conversion left a recovery report.',
  );

  const project = JSON.parse(
    (
      await run(
        'npm',
        ['exec', 'nx', '--', 'show', 'project', 'probe-app', '--json'],
        { cwd: fixtureRoot, env: environment },
      )
    ).stdout,
  );
  assert(project.root === 'apps/probe-app', 'Converted project root is wrong.');
  for (const target of ['build', 'test', 'lint', 'deploy']) {
    assert(project.targets[target], `Converted ${target} target is missing.`);
    assert(
      project.targets[target].options.cwd === 'apps/probe-app',
      `Converted ${target} target does not run from the application root.`,
    );
  }
  assert(project.targets.deploy.cache === false, 'Deploy target is cacheable.');

  await run('npm', ['exec', 'nx', '--', 'graph', '--file=graph.json'], {
    cwd: fixtureRoot,
    env: environment,
  });
  const graph = JSON.parse(
    await readFile(resolve(fixtureRoot, 'graph.json'), 'utf8'),
  );
  assert(graph.graph.nodes['probe-app'], 'Converted app is absent from graph.');
  await rm(resolve(fixtureRoot, 'graph.json'));

  await git('add', '.');
  await git('commit', '-m', 'convert to megamono');
  const history = await git(
    'log',
    '--follow',
    '--format=%s',
    '--',
    'apps/probe-app/src/index.mjs',
  );
  assert(
    history.stdout.includes('seed application') &&
      history.stdout.includes('convert to megamono'),
    `git log --follow did not cross the move:\n${history.stdout}`,
  );

  await rm(resolve(fixtureRoot, 'node_modules'), {
    recursive: true,
    force: true,
  });
  await rm(resolve(fixtureRoot, '.nx'), { recursive: true, force: true });
  await run('npm', ['ci', '--registry', registry], {
    cwd: fixtureRoot,
    env: environment,
  });
  for (const target of ['build', 'test', 'lint']) {
    await run(
      'npm',
      [
        'exec',
        'nx',
        '--',
        'run',
        `probe-app:${target}`,
        '--output-style=static',
      ],
      { cwd: fixtureRoot, env: environment },
    );
  }
  assert(
    await exists(resolve(fixtureRoot, 'apps/probe-app/dist/artifact.txt')),
    'Clean-install build did not produce its fixture artifact.',
  );

  const targetTsconfigPath = resolve(fixtureRoot, 'tsconfig.base.json');
  const targetTsconfig = JSON.parse(await readFile(targetTsconfigPath, 'utf8'));
  targetTsconfig.compilerOptions.paths = {
    '@fixture/shared/*': ['./libs/shared/*'],
  };
  await writeFile(
    targetTsconfigPath,
    `${JSON.stringify(targetTsconfig, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    resolve(fixtureRoot, '.env'),
    'SHARED_TOKEN=target-value\n',
    'utf8',
  );
  const targetManifestPath = resolve(fixtureRoot, 'package.json');
  const targetManifest = JSON.parse(await readFile(targetManifestPath, 'utf8'));
  targetManifest.workspaces = [
    ...new Set([...(targetManifest.workspaces ?? []), 'libs/host-shared']),
  ].sort();
  await writeFile(
    targetManifestPath,
    `${JSON.stringify(targetManifest, null, 2)}\n`,
    'utf8',
  );
  const hostSharedFiles = {
    'libs/host-shared/package.json': `${JSON.stringify(
      {
        name: '@fixture/host-shared',
        version: '0.0.0',
        type: 'module',
        exports: './src/index.mjs',
      },
      null,
      2,
    )}\n`,
    'libs/host-shared/project.json': `${JSON.stringify(
      {
        name: 'host-shared',
        projectType: 'library',
        sourceRoot: 'libs/host-shared/src',
        tags: [
          'platform:node',
          'scope:shared',
          'type:util',
          'visibility:internal',
        ],
      },
      null,
      2,
    )}\n`,
    'libs/host-shared/src/index.mjs':
      "export const hostShared = 'host-shared';\n",
  };
  for (const [path, content] of Object.entries(hostSharedFiles)) {
    const absolute = resolve(fixtureRoot, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  await git('add', 'tsconfig.base.json', '.env', 'package.json', 'libs');
  await git('commit', '-m', 'add host collision and graph fixtures');

  const importSourceRoot = resolve(temporaryRoot, 'import-source');
  await writeImportSource(importSourceRoot);
  const sourceGit = (...args) =>
    run('git', args, { cwd: importSourceRoot, env: environment });
  await sourceGit('init', '--initial-branch=main');
  await sourceGit('config', 'user.name', 'Megamono import fixture');
  await sourceGit('config', 'user.email', 'import-fixture@megamono.com');
  await sourceGit('add', '.');
  await sourceGit('commit', '-m', 'seed import source');
  const sourceSha = (await sourceGit('rev-parse', 'HEAD')).stdout.trim();
  const unresolvedImportArguments = [
    'exec',
    'nx',
    '--',
    'run',
    'megamono:import',
    '--',
    `--source=${importSourceRoot}`,
    '--ref=main',
    '--name=import-probe',
  ];
  const unresolvedImport = await run('npm', unresolvedImportArguments, {
    cwd: fixtureRoot,
    env: environment,
  });
  assert(
    unresolvedImport.stdout.includes('Ready: `false`') &&
      unresolvedImport.stdout.includes('import-alias-resolution') &&
      unresolvedImport.stdout.includes('import-environment-resolution'),
    'Packed import analysis did not require explicit collision resolutions.',
  );
  const importArguments = [
    ...unresolvedImportArguments,
    '--resolutions.aliases.@fixture/shared/*=@import-probe/shared/*',
    '--resolutions.environment.SHARED_TOKEN=IMPORT_PROBE_SHARED_TOKEN',
  ];
  const importAnalysis = await run('npm', importArguments, {
    cwd: fixtureRoot,
    env: environment,
  });
  assert(
    importAnalysis.stdout.includes(`Resolved source SHA: \`${sourceSha}\``) &&
      importAnalysis.stdout.includes('Ready: `true`') &&
      importAnalysis.stdout.includes('## Repository routes') &&
      importAnalysis.stdout.includes('`src/index.mjs`') &&
      importAnalysis.stdout.includes('`tsconfig.json`') &&
      importAnalysis.stdout.includes(
        '`import-probe` → `host-shared` via `@fixture/host-shared`',
      ),
    'Packed import executor did not emit ready immutable-source routing analysis.',
  );
  const beforeImport = (await git('rev-parse', 'HEAD')).stdout.trim();
  const executionArguments = [
    ...importArguments,
    `--expectedSourceSha=${sourceSha}`,
    '--history=subtree',
    '--verify=build',
    '--execute',
  ];
  const importExecution = await run('npm', executionArguments, {
    cwd: fixtureRoot,
    env: environment,
  });
  assert(
    importExecution.stdout.includes(`Imported import-probe at ${sourceSha}`),
    'Packed import executor did not report its integration commit.',
  );
  assert(
    await exists(resolve(fixtureRoot, 'apps/import-probe/src/index.mjs')),
    'Packed import did not create the destination application.',
  );
  assert(
    await exists(resolve(fixtureRoot, '.megamono/imports/import-probe.json')),
    'Packed import did not write its completion marker.',
  );
  const importMarker = JSON.parse(
    await readFile(
      resolve(fixtureRoot, '.megamono/imports/import-probe.json'),
      'utf8',
    ),
  );
  assert(
    importMarker.schemaVersion === 2 &&
      importMarker.repositoryRoutes.length === 5 &&
      importMarker.collisionRewrites.length === 2 &&
      importMarker.expectedGraphDependencies[0].project === 'host-shared',
    'Packed import marker did not retain its approved repository routes.',
  );
  const importedSource = await readFile(
    resolve(fixtureRoot, 'apps/import-probe/src/index.mjs'),
    'utf8',
  );
  assert(
    importedSource.includes("import('@import-probe/shared/tool')") &&
      importedSource.includes("require.resolve('@import-probe/shared/tool')") &&
      importedSource.includes('process.env.IMPORT_PROBE_SHARED_TOKEN') &&
      importedSource.includes(
        'const { IMPORT_PROBE_SHARED_TOKEN: SHARED_TOKEN } = process.env',
      ),
    'Packed import did not rewrite source-owned alias and environment references.',
  );
  const importedTsconfig = JSON.parse(
    await readFile(
      resolve(fixtureRoot, 'apps/import-probe/tsconfig.json'),
      'utf8',
    ),
  );
  assert(
    importedTsconfig.compilerOptions.paths['@import-probe/shared/*'],
    'Packed import did not rewrite the source TypeScript alias key.',
  );
  assert(
    (await readFile(resolve(fixtureRoot, '.env'), 'utf8')) ===
      'SHARED_TOKEN=target-value\n' &&
      (await readFile(
        resolve(fixtureRoot, 'apps/import-probe/.env.example'),
        'utf8',
      )) ===
        'IMPORT_PROBE_SHARED_TOKEN=source-example\nPUBLIC_URL=${IMPORT_PROBE_SHARED_TOKEN}\n',
    'Packed import changed host environment ownership or missed source environment references.',
  );
  assert(
    await exists(
      resolve(fixtureRoot, 'docs/specs/import-probe/guides/overview.md'),
    ),
    'Packed import did not migrate plain source documentation.',
  );
  assert(
    (
      await readFile(
        resolve(fixtureRoot, 'docs/decisions/source-boundary.md'),
        'utf8',
      )
    ).includes('date: "2024-01-02"'),
    'Packed import did not preserve an existing decision date.',
  );
  assert(
    await exists(
      resolve(
        fixtureRoot,
        '.megamono/imports/import-probe/source-infrastructure/.github/workflows/source.yml',
      ),
    ),
    'Packed import did not preserve inactive source infrastructure.',
  );
  assert(
    !(await exists(resolve(fixtureRoot, 'apps/import-probe/nx.json'))),
    'Packed import activated source repository configuration inside the app.',
  );
  const importedConfig = JSON.parse(
    await readFile(resolve(fixtureRoot, 'megamono.json'), 'utf8'),
  );
  assert(
    importedConfig.topics.extend.includes('sessions'),
    'Packed import did not reconcile the source documentation vocabulary.',
  );
  assert(
    !(await exists(resolve(fixtureRoot, 'MEGAMONO-RECOVERY.md'))),
    'Successful packed import left a recovery report.',
  );
  assert(
    (await git('status', '--porcelain=v1')).stdout === '',
    'Successful packed import left a dirty target repository.',
  );
  assert(
    (await sourceGit('status', '--porcelain=v1')).stdout === '',
    'Packed import changed the source repository.',
  );
  const importedProject = JSON.parse(
    (
      await run(
        'npm',
        ['exec', 'nx', '--', 'show', 'project', 'import-probe', '--json'],
        { cwd: fixtureRoot, env: environment },
      )
    ).stdout,
  );
  assert(
    importedProject.root === 'apps/import-probe',
    'Imported project root is wrong.',
  );
  for (const target of ['build', 'test', 'lint']) {
    assert(
      importedProject.targets[target],
      `Imported ${target} target is missing.`,
    );
    assert(
      importedProject.targets[target].options.cwd === 'apps/import-probe',
      `Imported ${target} target does not run from the application root.`,
    );
  }
  const importedGraph = JSON.parse(
    (
      await run('npm', ['exec', 'nx', '--', 'graph', '--print'], {
        cwd: fixtureRoot,
        env: environment,
      })
    ).stdout,
  );
  assert(
    importedGraph.graph.dependencies['import-probe'].some(
      ({ target }) => target === 'host-shared',
    ),
    'Packed import did not expose its expected target-project graph edge.',
  );
  const importedHistory = (await git('log', '--all', '--format=%s')).stdout;
  assert(
    importedHistory.includes('seed import source') &&
      importedHistory.includes('graft import-probe history') &&
      importedHistory.includes('import import-probe'),
    `Packed subtree import did not preserve its expected history:\n${importedHistory}`,
  );
  assert(
    (await git('rev-list', '--count', `${beforeImport}..HEAD`)).stdout ===
      '3\n',
    'Packed subtree import did not add the source, graft, and integration commits.',
  );
  const completedHead = (await git('rev-parse', 'HEAD')).stdout.trim();
  const importRerun = await run('npm', executionArguments, {
    cwd: fixtureRoot,
    env: environment,
  });
  assert(
    importRerun.stdout.includes('already complete') &&
      (await git('rev-parse', 'HEAD')).stdout.trim() === completedHead,
    'Completed import rerun was not a zero-commit success.',
  );

  const rerun = await run('npm', convertArgs(), {
    cwd: fixtureRoot,
    env: environment,
  });
  assert(
    rerun.stdout.includes('already applied; no structural changes made'),
    'Idempotent rerun did not report its no-op.',
  );
  const finalStatus = await git('status', '--porcelain=v1');
  assert(
    finalStatus.stdout === '',
    `Idempotent rerun changed the fixture:\n${finalStatus.stdout}`,
  );
  const installedPlugin = JSON.parse(
    await readFile(
      resolve(fixtureRoot, 'node_modules/@megamono/plugin/package.json'),
      'utf8',
    ),
  );
  assert(
    installedPlugin.version === '0.0.1',
    'Fixture did not install the locally published plugin.',
  );

  succeeded = true;
  process.stdout.write(
    'plugin local-registry e2e passed: convert refusals, plan parity, graph contracts, history, clean install, targets, idempotency, documentation routing, inactive infrastructure preservation, collision rewriting, and packed subtree import execution verified.\n',
  );
} finally {
  verdaccio.kill('SIGTERM');
  await new Promise((resolvePromise) => {
    if (verdaccio.exitCode !== null) resolvePromise();
    else verdaccio.once('exit', resolvePromise);
  });
  if (succeeded) await rm(temporaryRoot, { recursive: true, force: true });
  else
    process.stderr.write(`Retained failed convert fixture: ${temporaryRoot}\n`);
}
