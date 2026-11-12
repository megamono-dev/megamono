import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const baseline = process.env.MEGAMONO_MINIMATCH_BASELINE === 'true';
const nx = (path) => require(`nx/src/${path}`);
const isolatedEnv = {
  ...process.env,
  CI: 'true',
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
};

async function fixture(t) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'megamono-minimatch-nx-')),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const write = async (path, content) => {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  return { directory, write };
}

test('the nine named/class API consumers resolve the qualified minimatch', () => {
  for (const name of [
    'nx',
    '@nx/devkit',
    '@nx/jest',
    '@nx/playwright',
    '@nx/react',
    'eslint',
    '@eslint/config-array',
    '@typescript-eslint/typescript-estree',
    '@swc/cli',
  ]) {
    const consumer = createRequire(require.resolve(name));
    assert.equal(
      consumer('minimatch/package.json').version,
      baseline ? (name === '@swc/cli' ? '9.0.9' : '10.2.5') : '11.0.4',
      name,
    );
  }
});

test('Nx project selection preserves names, tags, directories, exclusions, dot paths, and case', () => {
  const { findMatchingProjects, getMatchingStringsWithCache } = nx(
    'utils/find-matching-projects',
  );
  const projects = {
    site: {
      data: { root: 'apps/site', tags: ['platform:web', 'scope:public'] },
    },
    api: {
      data: { root: 'apps/api', tags: ['platform:node', 'scope:private'] },
    },
    '.internal': {
      data: {
        root: 'apps/.internal',
        tags: ['platform:node', 'scope:private'],
      },
    },
    shared: { data: { root: 'libs/shared', tags: ['platform:shared'] } },
    'Site-e2e': { data: { root: 'e2e/site', tags: ['type:e2e'] } },
  };
  const select = (...patterns) =>
    findMatchingProjects(patterns, projects).sort();
  assert.deepEqual(select('name:s*'), ['shared', 'site']);
  assert.deepEqual(select('name:S*'), ['Site-e2e']);
  assert.deepEqual(select('tag:platform:*', '!tag:scope:private'), [
    'shared',
    'site',
  ]);
  assert.deepEqual(select('directory:apps/*', '!name:api'), [
    '.internal',
    'site',
  ]);
  assert.deepEqual(select('!directory:apps/*'), ['Site-e2e', 'shared']);
  assert.deepEqual(select('name:site', 'name:site'), ['site']);
  assert.deepEqual(select('nx-cloud:other/workspace'), []);
  assert.deepEqual(
    getMatchingStringsWithCache('apps/*', [
      'apps/.internal',
      'apps/api',
      'libs/api',
    ]),
    ['apps/.internal', 'apps/api'],
  );
  assert.deepEqual(getMatchingStringsWithCache('!api', ['', 'api', 'site']), [
    'site',
  ]);
  assert.deepEqual(
    getMatchingStringsWithCache('[literal', ['[literal', 'literal']),
    ['[literal'],
  );
  assert.throws(
    () => getMatchingStringsWithCache('', ['']),
    /Invalid glob pattern/,
  );
  assert.throws(
    () => getMatchingStringsWithCache('#comment', ['site']),
    /Invalid glob pattern/,
  );
});

test('Nx sync and async glob include virtual creates, retain updates, and hide pending deletes', async (t) => {
  const { directory, write } = await fixture(t);
  await write('nx.json', '{}');
  await write('package.json', '{"name":"glob-fixture","private":true}');
  await write('src/existing.ts', 'export {};');
  await write('src/deleted.ts', 'export {};');
  await write('src/updated.ts', 'export const old = true;');
  await write('src/upper.TS', 'export {};');
  const script = `const { FsTree } = require(${JSON.stringify(require.resolve('nx/src/generators/tree'))});
    const { glob, globAsync } = require(${JSON.stringify(require.resolve('nx/src/generators/utils/glob'))});
    const tree = new FsTree(${JSON.stringify(directory)}, false);
    tree.write('src/nested/new.ts', 'export {};');
    tree.write('src/updated.ts', 'export const updated = true;');
    tree.write('src/new.js', 'export {};');
    tree.delete('src/deleted.ts');
    (async () => console.log(JSON.stringify([
      glob(tree, ['src/**/*.ts']).sort(),
      (await globAsync(tree, ['src/**/*.ts'])).sort(),
      glob(tree, ['src/**/*.ts', 'src/**/*.js']).sort(),
    ])))().catch(error => { console.error(error); process.exitCode = 1; });`;
  const { stdout } = await run(process.execPath, ['--eval', script], {
    cwd: directory,
    env: isolatedEnv,
    timeout: 30_000,
  });
  const expected = ['src/existing.ts', 'src/nested/new.ts', 'src/updated.ts'];
  assert.deepEqual(JSON.parse(stdout), [
    expected,
    expected,
    [...expected, 'src/new.js'].sort(),
  ]);
});

test('Nx release branch patterns preserve merged/all-tag strategies and invalid-pattern behavior', async (t) => {
  const { directory, write } = await fixture(t);
  const git = async (...args) =>
    run('git', args, {
      cwd: directory,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Megamono fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Megamono fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
  await git('init', '--initial-branch=main');
  await write('value.txt', 'main\n');
  await git('add', 'value.txt');
  await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Main fixture');
  await git('tag', 'v1.0.0');
  await git('checkout', '-b', 'release/v2');
  await write('value.txt', 'unmerged\n');
  await git('add', 'value.txt');
  await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Unmerged fixture');
  await git('tag', 'v2.0.0');
  await git('checkout', 'main');
  const module =
    require.resolve('nx/src/command-line/release/utils/repository-git-tags');
  const script = `const { RepoGitTags } = require(${JSON.stringify(module)});
    (async () => {
      const results = [];
      for (const strategy of [false, true, ['ma?n'], ['release/*'], ['M*'], ['', '#comment']]) {
        results.push(await RepoGitTags.create().resolveTags(strategy));
      }
      console.log(JSON.stringify(results));
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const { stdout } = await run(process.execPath, ['--eval', script], {
    cwd: directory,
    env: isolatedEnv,
    timeout: 30_000,
  });
  assert.deepEqual(JSON.parse(stdout), [
    ['v1.0.0'],
    ['v2.0.0', 'v1.0.0'],
    ['v2.0.0', 'v1.0.0'],
    ['v1.0.0'],
    ['v1.0.0'],
    ['v1.0.0'],
  ]);
});

test('ESLint discovers nested and hidden files while respecting directory exclusions', async (t) => {
  const { directory, write } = await fixture(t);
  for (const path of [
    'src/index.js',
    'src/nested/value.js',
    'src/.hidden.js',
    'src/ignored/private.js',
  ]) {
    await write(path, 'missing();\n');
  }
  const { ESLint } = require('eslint');
  const eslint = new ESLint({
    cwd: directory,
    overrideConfigFile: true,
    ignorePatterns: ['src/ignored/**'],
    overrideConfig: [
      { files: ['src/**/*.js'], rules: { 'no-undef': 'error' } },
    ],
  });
  const results = await eslint.lintFiles(['src/**/*.js']);
  assert.deepEqual(results.map((result) => result.filePath).sort(), [
    join(directory, 'src/.hidden.js'),
    join(directory, 'src/index.js'),
    join(directory, 'src/nested/value.js'),
  ]);
  assert.ok(
    results.every((result) =>
      result.messages.some((message) => message.ruleId === 'no-undef'),
    ),
  );
  assert.equal(
    await eslint.isPathIgnored(join(directory, 'src/ignored/private.js')),
    true,
  );
});

test('ConfigArray applies ordered file globs, ignores, and merged configuration', async (t) => {
  const { directory } = await fixture(t);
  const { ConfigArray } = require('@eslint/config-array');
  const configs = new ConfigArray(
    [
      { files: ['src/**/*.js'], ignores: ['**/*.test.js'], level: 1 },
      { files: ['src/private/**'], level: 2 },
    ],
    {
      basePath: directory,
      schema: {
        level: {
          merge: (previous, current) => current ?? previous,
          validate: (value) => assert.equal(typeof value, 'number'),
        },
      },
    },
  );
  await configs.normalize();
  assert.deepEqual(configs.getConfig(join(directory, 'src/main.js')), {
    level: 1,
  });
  assert.deepEqual(configs.getConfig(join(directory, 'src/private/main.js')), {
    level: 2,
  });
  assert.equal(
    configs.getConfig(join(directory, 'src/main.test.js')),
    undefined,
  );
  assert.equal(configs.getConfig(join(directory, 'other/main.js')), undefined);
});

test('Nx devkit resolves the config plugin through include, exclude, and plugin globs', async (t) => {
  const { directory } = await fixture(t);
  const { FsTree } = nx('generators/tree');
  const tree = new FsTree(directory, false);
  const registration = {
    plugin: '@nx/jest/plugin',
    include: ['apps/**'],
    exclude: ['apps/private/**'],
  };
  tree.write('nx.json', JSON.stringify({ plugins: [registration] }));
  const { findPluginForConfigFile } = require('@nx/devkit/internal');
  assert.deepEqual(
    await findPluginForConfigFile(
      tree,
      '@nx/jest/plugin',
      'apps/unit/jest.config.cjs',
    ),
    registration,
  );
  assert.equal(
    await findPluginForConfigFile(
      tree,
      '@nx/jest/plugin',
      'apps/private/jest.config.cjs',
    ),
    undefined,
  );
  assert.equal(
    await findPluginForConfigFile(
      tree,
      '@nx/jest/plugin',
      'apps/unit/other.config.cjs',
    ),
    undefined,
  );
  assert.equal(
    await findPluginForConfigFile(
      tree,
      '@nx/jest/plugin',
      'libs/unit/jest.config.cjs',
    ),
    undefined,
  );
});

test('TypeScript ESLint project service admits only files matching allowDefaultProject', async (t) => {
  const { directory, write } = await fixture(t);
  await write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { strict: true },
      include: ['src/**/*.ts'],
    }),
  );
  await write('src/index.ts', 'export {};');
  const script = `const assert = require('node:assert/strict');
    const { parseAndGenerateServices } = require(${JSON.stringify(require.resolve('@typescript-eslint/typescript-estree'))});
    const options = { tsconfigRootDir: ${JSON.stringify(directory)}, projectService: { allowDefaultProject: ['config.ts'], defaultProject: 'tsconfig.json' } };
    const parsed = parseAndGenerateServices('export const count: number = 1;', { ...options, filePath: ${JSON.stringify(join(directory, 'config.ts'))} });
    assert.equal(parsed.ast.type, 'Program');
    assert.ok(parsed.services.program);
    assert.throws(() => parseAndGenerateServices('export const count: number = 1;', { ...options, filePath: ${JSON.stringify(join(directory, 'private.ts'))} }), /does not match 'private.ts'/);
    console.log('Project service selection verified.');`;
  const { stdout } = await run(process.execPath, ['--eval', script], {
    cwd: directory,
    env: isolatedEnv,
    timeout: 30_000,
  });
  assert.match(stdout, /Project service selection verified/);
});

test('SWC source selection keeps only matching compiler inputs and respects ignores and dotfiles', async (t) => {
  const { directory, write } = await fixture(t);
  for (const path of [
    'src/index.ts',
    'src/nested/value.ts',
    'src/index.test.ts',
    'src/.hidden.ts',
    'src/other.js',
  ]) {
    await write(path, 'export {};');
  }
  const script = `const { globSources } = require(${JSON.stringify(require.resolve('@swc/cli/lib/swc/sources'))});
    (async () => console.log(JSON.stringify([
      (await globSources(['src'], ['src/**/*.ts'], ['src/**/*.test.ts'], true)).sort(),
      (await globSources(['src'], [], ['src/**/*.test.ts'], true)).sort(),
    ])))().catch(error => { console.error(error); process.exitCode = 1; });`;
  const { stdout } = await run(process.execPath, ['--eval', script], {
    cwd: directory,
    env: isolatedEnv,
    timeout: 30_000,
  });
  assert.deepEqual(JSON.parse(stdout), [
    ['src/index.ts', 'src/nested/value.ts'],
    ['src/.hidden.ts', 'src/index.ts', 'src/nested/value.ts', 'src/other.js'],
  ]);
});
