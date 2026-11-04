import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const run = promisify(execFile);
const fromConsumer = (name) => createRequire(require.resolve(name));

async function fixture(t) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'megamono-glob-tooling-')),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    directory,
    async write(path, contents) {
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    },
  };
}

test('modern consumers resolve the qualified glob while Rollup retains its legacy API', () => {
  for (const name of [
    '@jest/reporters',
    'jest-config',
    'jest-runtime',
    'test-exclude',
  ]) {
    const consumer = fromConsumer(name);
    assert.equal(consumer('glob/package.json').version, '14.0.3', name);
    const { glob } = consumer('glob');
    assert.equal(typeof glob, 'function', name);
    assert.equal(typeof glob.sync, 'function', name);
  }
  const rollup = fromConsumer('@rollup/plugin-commonjs');
  assert.equal(rollup('glob/package.json').version, '8.1.0');
  assert.equal(typeof rollup('glob'), 'function');
  assert.equal(typeof rollup('glob').sync, 'function');
});

test('test-exclude preserves synchronous and asynchronous coverage selection', async (t) => {
  const { directory, write } = await fixture(t);
  for (const path of [
    'src/index.js',
    'src/feature.ts',
    'src/feature.test.ts',
    'src/.hidden.js',
    'src/private/secret.js',
    'src/private/keep.js',
    'src/nested/value.js',
    'lib/outside.js',
    'node_modules/ignored/index.js',
    'README.md',
  ]) {
    await write(path, '');
  }
  const TestExclude = require('test-exclude');
  const base = {
    cwd: directory,
    include: ['src/**'],
    extension: ['.js', '.ts'],
  };
  for (const reinclude of [false, true]) {
    const exclude = new TestExclude({
      ...base,
      exclude: [
        '**/*.test.*',
        'src/private/**',
        ...(reinclude ? ['!src/private/keep.js'] : []),
      ],
    });
    const expected = [
      'src/.hidden.js',
      'src/feature.ts',
      'src/index.js',
      'src/nested/value.js',
      ...(reinclude ? ['src/private/keep.js'] : []),
    ].sort();
    assert.deepEqual(exclude.globSync().sort(), expected);
    assert.deepEqual((await exclude.glob()).sort(), expected);
  }
});

test('Jest expands projects, reports sibling extensions, and applies glob coverage thresholds', async (t) => {
  const { directory, write } = await fixture(t);
  await write(
    'jest.config.cjs',
    `module.exports = ${JSON.stringify({
      rootDir: directory,
      projects: ['<rootDir>/projects/*'],
      watchman: false,
      coverageDirectory: join(directory, 'coverage'),
      coverageReporters: ['json-summary'],
      coverageThreshold: { './projects/*/src/*.js': { lines: 100 } },
    })};\n`,
  );
  for (const name of ['alpha', 'beta']) {
    await write(
      `projects/${name}/jest.config.cjs`,
      `module.exports = ${JSON.stringify({
        displayName: name,
        rootDir: join(directory, 'projects', name),
        testEnvironment: 'node',
        testMatch: ['<rootDir>/tests/**/*.test.js'],
        moduleFileExtensions: ['js', 'json', 'node'],
        collectCoverageFrom: ['src/**/*.js'],
        transform: {},
      })};\n`,
    );
    await write(
      `projects/${name}/src/add.js`,
      'module.exports = (left, right) => left + right;\n',
    );
    await write(
      `projects/${name}/tests/add.test.js`,
      `test('adds', () => expect(require('../src/add')(2, 3)).toBe(5));\n`,
    );
  }
  await write('projects/alpha/src/typed-only.ts', 'module.exports = 1;\n');
  await write(
    'projects/alpha/tests/extension.test.js',
    `test('suggests the existing sibling extension', () => {
      expect(() => require('../src/typed-only')).toThrow(/typed-only\\.ts/);
    });\n`,
  );
  const resultsPath = join(directory, 'results.json');
  try {
    await run(
      process.execPath,
      [
        require.resolve('jest/bin/jest'),
        '--config',
        join(directory, 'jest.config.cjs'),
        '--runInBand',
        '--coverage',
        '--json',
        '--outputFile',
        resultsPath,
      ],
      {
        cwd: directory,
        env: { ...process.env, CI: 'true' },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    throw new Error(error.stderr || error.message, { cause: error });
  }
  const results = JSON.parse(await readFile(resultsPath, 'utf8'));
  assert.equal(results.success, true);
  assert.equal(results.numPassedTests, 3);
  assert.equal(results.numPassedTestSuites, 3);
  const coverage = JSON.parse(
    await readFile(
      join(directory, 'coverage', 'coverage-summary.json'),
      'utf8',
    ),
  );
  assert.equal(coverage.total.lines.pct, 100);
  assert.ok(coverage[join(directory, 'projects/alpha/src/add.js')]);
  assert.ok(coverage[join(directory, 'projects/beta/src/add.js')]);
});
