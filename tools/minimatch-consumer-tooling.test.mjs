import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const temporaryRoot = realpathSync(
  mkdtempSync(join(tmpdir(), 'megamono-minimatch-consumers-')),
);
const results = {};

function packageDirectory(name, from = root) {
  const resolver = createRequire(join(from, 'package.json'));
  let entry;
  try {
    entry = resolver.resolve(`${name}/package.json`);
  } catch {
    entry = resolver.resolve(name);
  }
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    try {
      if (
        JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
          .name === name
      )
        return directory;
    } catch {
      // Find the package owning the resolved public entry point.
    }
    directory = dirname(directory);
  }
  throw new Error(`Cannot locate installed ${name}.`);
}

function packageVersion(name, from) {
  return JSON.parse(
    readFileSync(join(packageDirectory(name, from), 'package.json'), 'utf8'),
  ).version;
}

const verdaccioRoot = packageDirectory('@verdaccio/core');
const checkerRoot = packageDirectory('fork-ts-checker-webpack-plugin');
const commonjsRoot = packageDirectory('@rollup/plugin-commonjs');
const rollupRoot = packageDirectory(
  'rollup',
  process.env.MEGAMONO_ROLLUP_TEST_ROOT ?? root,
);
const versions = {
  verdaccio: packageVersion('@verdaccio/core', root),
  verdaccioMinimatch: packageVersion('minimatch', verdaccioRoot),
  checker: packageVersion('fork-ts-checker-webpack-plugin', root),
  checkerMinimatch: packageVersion('minimatch', checkerRoot),
  commonjs: packageVersion('@rollup/plugin-commonjs', root),
  commonjsGlob: packageVersion('glob', commonjsRoot),
  rollup: packageVersion(
    'rollup',
    process.env.MEGAMONO_ROLLUP_TEST_ROOT ?? root,
  ),
};

after(() => {
  if (process.env.MEGAMONO_CONSUMER_RESULTS) {
    writeFileSync(
      process.env.MEGAMONO_CONSUMER_RESULTS,
      JSON.stringify({ versions, results }, null, 2) + '\n',
    );
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
});

for (const format of ['cjs', 'esm']) {
  test(`Verdaccio ${format} retains case-insensitive ACL matching and first-match ordering`, async () => {
    const file = join(
      verdaccioRoot,
      'build',
      `auth-utils.${format === 'cjs' ? 'js' : 'mjs'}`,
    );
    const { getMatchedPackagesSpec } =
      format === 'cjs' ? require(file) : await import(pathToFileURL(file).href);
    const policies = {
      '@scope/exact': { access: 'exact' },
      '@scope/*': { access: 'scope' },
      'library-*': { access: 'prefix' },
      '**': { access: 'fallback' },
    };
    const selected = [
      '@SCOPE/EXACT',
      '@Scope/other',
      'LIBRARY-client',
      'elsewhere',
      '@other/pkg',
    ].map((name) => getMatchedPackagesSpec(name, policies)?.access);
    assert.deepEqual(selected, [
      'exact',
      'scope',
      'prefix',
      'fallback',
      'fallback',
    ]);
    assert.equal(
      getMatchedPackagesSpec('@scope/exact', {
        '**': policies['**'],
        '@scope/exact': policies['@scope/exact'],
      }),
      policies['**'],
    );
    assert.equal(
      getMatchedPackagesSpec('@other/pkg', {
        '@scope/*': policies['@scope/*'],
      }),
      undefined,
    );
    assert.equal(
      getMatchedPackagesSpec('public-client', {
        '!private-*': policies['library-*'],
      }),
      policies['library-*'],
    );
    assert.equal(
      getMatchedPackagesSpec('private-client', {
        '!private-*': policies['library-*'],
      }),
      undefined,
    );
    assert.equal(
      getMatchedPackagesSpec('', { '!private-*': policies['library-*'] }),
      undefined,
    );
    assert.throws(
      () => getMatchedPackagesSpec('package', { '#comment': policies['**'] }),
      TypeError,
    );
    assert.throws(
      () => getMatchedPackagesSpec('package', { '': policies['**'] }),
      TypeError,
    );
    results[`verdaccio-${format}`] = {
      selected,
      firstMatch: 'fallback',
      unconfigured: 'unmatched',
      invalidPatterns: 'TypeError',
    };
  });
}

test('fork-ts-checker preserves issue file, severity, and code include/exclude filters', () => {
  const { createIssueConfig } = require(
    join(checkerRoot, 'lib/issue/issue-config.js'),
  );
  const { createIssuePredicateFromIssueMatch } = require(
    join(checkerRoot, 'lib/issue/issue-match.js'),
  );
  const context = join(temporaryRoot, 'checker');
  const { predicate } = createIssueConfig(
    { options: { context } },
    {
      include: [{ file: 'src/**/*.{ts,tsx}', severity: 'error' }],
      exclude: [{ file: '**/*.spec.ts' }, { code: 'TS999' }],
    },
  );
  const issue = (file, severity = 'error', code = 'TS2322') => ({
    origin: 'typescript',
    severity,
    code,
    message: 'Fixture diagnostic',
    file: join(context, file),
  });
  const observed = [
    issue('src/index.ts'),
    issue('src/components/Button.tsx'),
    issue('src\\components\\Button.tsx'),
    issue('src/index.spec.ts'),
    issue('src/index.ts', 'warning'),
    issue('src/index.ts', 'error', 'TS999'),
    issue('scripts/build.ts'),
    issue('src/.hidden.ts'),
  ].map(predicate);
  assert.deepEqual(observed, [
    true,
    true,
    true,
    false,
    false,
    false,
    false,
    false,
  ]);
  const exact = createIssuePredicateFromIssueMatch(context, {
    file: 'src/index.ts',
    code: 'TS2322',
    severity: 'error',
  });
  assert.equal(exact(issue('src/index.ts')), true);
  assert.equal(exact(issue('src/Index.ts')), false);
  assert.equal(
    exact({
      origin: 'typescript',
      severity: 'error',
      code: 'TS2322',
      message: 'Global diagnostic',
    }),
    true,
  );
  results.checkerIssues = observed;
});

test('fork-ts-checker watch ignores preserve glob, regexp, excluded-directory, and builtin filters', () => {
  const { InclusiveNodeWatchFileSystem } = require(
    join(checkerRoot, 'lib/watch/inclusive-node-watch-file-system.js'),
  );
  const { getFilesChange } = require(join(checkerRoot, 'lib/files-change.js'));
  const context = join(temporaryRoot, 'watch');
  const emitter = new EventEmitter();
  const noop = () => {};
  const compiler = {
    getInfrastructureLogger: () => ({
      log: noop,
      debug: noop,
      error: noop,
      warn: noop,
      info: noop,
    }),
  };
  const underlying = {
    watcher: emitter,
    watch: () => ({ close: noop, pause: noop }),
  };
  const wrapper = new InclusiveNodeWatchFileSystem(underlying, compiler, {
    lastDependencies: { dirs: [], excluded: [join(context, 'excluded')] },
  });
  const watching = wrapper.watch(
    [],
    [],
    [],
    Date.now(),
    { ignored: ['**/*.generated.ts', /legacy/, 42] },
    noop,
    noop,
  );
  for (const file of [
    'src/index.ts',
    'src/schema.generated.ts',
    'legacy/old.ts',
    'excluded/file.ts',
    '.git/config',
  ]) {
    emitter.emit('change', join(context, file));
  }
  emitter.emit('remove', join(context, 'src/deleted.ts'));
  emitter.emit('remove', join(context, 'src/deleted.ts'));
  emitter.emit('remove', join(context, 'src/schema.generated.ts'));
  const observed = getFilesChange(compiler);
  assert.deepEqual(observed.changedFiles, [join(context, 'src/index.ts')]);
  assert.deepEqual(observed.deletedFiles, [join(context, 'src/deleted.ts')]);
  watching.close();
  results.checkerWatch = {
    changed: ['src/index.ts'],
    deleted: ['src/deleted.ts'],
  };
});

for (const pluginFormat of ['cjs', 'esm']) {
  for (const outputFormat of ['cjs', 'es']) {
    test(`Rollup ${pluginFormat} CommonJS plugin bundles dynamic globs into executable ${outputFormat}`, async () => {
      const pluginFile = join(
        commonjsRoot,
        'dist',
        pluginFormat === 'cjs' ? 'cjs' : 'es',
        'index.js',
      );
      const commonjs =
        pluginFormat === 'cjs'
          ? require(pluginFile)
          : (await import(pathToFileURL(pluginFile).href)).default;
      const { rollup } = await import(
        pathToFileURL(join(rollupRoot, 'dist/es/rollup.js')).href
      );
      const directory = join(
        temporaryRoot,
        `rollup-${pluginFormat}-${outputFormat}`,
      );
      mkdirSync(join(directory, 'fixtures/nested'), { recursive: true });
      mkdirSync(join(directory, 'fixtures/excluded'), { recursive: true });
      mkdirSync(join(directory, 'fixtures/package/lib'), { recursive: true });
      mkdirSync(join(directory, 'fixtures/hidden'), { recursive: true });
      const entry = join(directory, 'entry.js');
      writeFileSync(
        entry,
        "module.exports = name => require('./fixtures/' + name);\n",
      );
      writeFileSync(
        join(directory, 'fixtures/a.js'),
        "module.exports = 'alpha';\n",
      );
      writeFileSync(
        join(directory, 'fixtures/nested/b.js'),
        "module.exports = 'beta';\n",
      );
      writeFileSync(
        join(directory, 'fixtures/extra.cjs'),
        "module.exports = 'gamma';\n",
      );
      writeFileSync(
        join(directory, 'fixtures/excluded/ignored.js'),
        "module.exports = 'excluded';\n",
      );
      writeFileSync(
        join(directory, 'fixtures/hidden/.private.js'),
        "module.exports = 'hidden';\n",
      );
      writeFileSync(
        join(directory, 'fixtures/package/package.json'),
        JSON.stringify({ main: 'lib/main.js' }),
      );
      writeFileSync(
        join(directory, 'fixtures/package/lib/main.js'),
        "module.exports = 'package-main';\n",
      );
      const bundle = await rollup({
        input: entry,
        plugins: [
          commonjs({
            extensions: ['.js', '.cjs'],
            dynamicRequireRoot: directory,
            dynamicRequireTargets: [
              join(directory, 'fixtures/**/*.{js,cjs}'),
              `!${join(directory, 'fixtures/excluded/**')}`,
              join(directory, 'fixtures/package'),
            ],
          }),
        ],
        onwarn(warning) {
          throw new Error(warning.message);
        },
      });
      const outputFile = join(
        directory,
        `bundle.${outputFormat === 'cjs' ? 'cjs' : 'mjs'}`,
      );
      try {
        await bundle.write({
          file: outputFile,
          format: outputFormat,
          exports: 'default',
          sourcemap: true,
        });
      } finally {
        await bundle.close();
      }
      const load =
        outputFormat === 'cjs'
          ? require(outputFile)
          : (await import(pathToFileURL(outputFile).href)).default;
      const observed = ['a.js', 'nested/b.js', 'extra.cjs', 'package'].map(
        load,
      );
      assert.deepEqual(observed, ['alpha', 'beta', 'gamma', 'package-main']);
      assert.throws(
        () => load('excluded/ignored.js'),
        /Could not dynamically require/,
      );
      assert.throws(
        () => load('hidden/.private.js'),
        /Could not dynamically require/,
      );
      assert.throws(() => load('missing.js'), /Could not dynamically require/);
      assert.ok(
        JSON.parse(readFileSync(`${outputFile}.map`, 'utf8')).sources.length >
          0,
      );
      results[`rollup-${pluginFormat}-${outputFormat}`] = {
        values: observed,
        excluded: true,
        hidden: true,
        missing: true,
      };
    });
  }
}
