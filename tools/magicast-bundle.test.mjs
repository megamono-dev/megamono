import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  linkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { patchMagicastBundle, provenance } from './patch-magicast-bundle.mjs';
import { stringify } from 'yaml';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRequire = createRequire(join(root, 'package.json'));
const temporaryRoot = mkdtempSync(
  join(tmpdir(), 'megamono-magicast-qualification-'),
);
let originalPackage;
let fixtureNumber = 0;
const hash = (source) => createHash('sha256').update(source).digest('hex');

function packageRoot(name, from = root) {
  const resolver =
    from === root
      ? workspaceRequire
      : createRequire(join(from, 'package.json'));
  let entry;
  try {
    entry = resolver.resolve(`${name}/package.json`);
  } catch {
    entry = resolver.resolve(name);
  }
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    const manifest = join(directory, 'package.json');
    if (
      existsSync(manifest) &&
      JSON.parse(readFileSync(manifest, 'utf8')).name === name
    ) {
      return directory;
    }
    directory = dirname(directory);
  }
  throw new Error(`Cannot find installed ${name} package.`);
}

function linkPackage(fixture, name, from = root) {
  const target = join(fixture, 'node_modules', name);
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(packageRoot(name, from), target, 'dir');
}

function linkDependencies(fixture, name) {
  const source = packageRoot(name);
  const manifest = JSON.parse(
    readFileSync(join(source, 'package.json'), 'utf8'),
  );
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    linkPackage(fixture, dependency, source);
  }
}

function fixture() {
  const directory = join(temporaryRoot, `fixture-${fixtureNumber++}`);
  mkdirSync(join(directory, 'node_modules'), { recursive: true });
  cpSync(originalPackage, join(directory, 'node_modules/magicast'), {
    recursive: true,
  });
  cpSync(
    packageRoot('source-map-js'),
    join(directory, 'node_modules/source-map-js'),
    { recursive: true },
  );
  linkDependencies(directory, 'magicast');
  writeFileSync(
    join(directory, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/magicast': {
          version: provenance.version,
          integrity: provenance.tarballIntegrity,
        },
        'node_modules/source-map-js': {
          version: provenance.externalVersion,
          integrity: provenance.externalTarballIntegrity,
        },
      },
    }),
  );
  return directory;
}

function pnpmFixture() {
  const directory = fixture();
  const packages = [
    {
      name: provenance.package,
      version: provenance.version,
      integrity: provenance.tarballIntegrity,
    },
    {
      name: provenance.externalPackage,
      version: provenance.externalVersion,
      integrity: provenance.externalTarballIntegrity,
    },
  ];
  const roots = [];
  for (const entry of packages) {
    const target = join(
      directory,
      'node_modules/.pnpm',
      `${entry.name}@${entry.version}`,
      'node_modules',
      entry.name,
    );
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(directory, 'node_modules', entry.name), target);
    symlinkSync(target, join(directory, 'node_modules', entry.name), 'dir');
    if (entry.name === provenance.package) roots.push(target);
  }
  const duplicate = join(
    directory,
    'node_modules/.pnpm',
    `magicast@${provenance.version}_peer@1`,
    'node_modules/magicast',
  );
  cpSync(roots[0], duplicate, { recursive: true });
  roots.push(duplicate);
  const external = join(
    directory,
    'node_modules/.pnpm',
    `source-map-js@${provenance.externalVersion}`,
    'node_modules/source-map-js',
  );
  for (const path of roots)
    symlinkSync(external, join(dirname(path), 'source-map-js'), 'dir');
  rmSync(join(directory, 'package-lock.json'));
  writeFileSync(
    join(directory, 'pnpm-lock.yaml'),
    stringify({
      lockfileVersion: '9.0',
      packages: Object.fromEntries(
        packages.map((entry) => [
          `${entry.name}@${entry.version}`,
          { resolution: { integrity: entry.integrity } },
        ]),
      ),
      snapshots: {
        [`magicast@${provenance.version}`]: {},
        [`magicast@${provenance.version}(peer@1)`]: {},
        [`source-map-js@${provenance.externalVersion}`]: {},
      },
    }),
  );
  return {
    directory,
    bundles: roots.map((path) => join(path, provenance.bundle)),
  };
}

test('pnpm managed copies all migrate atomically without mutating a shared store hardlink', () => {
  const { directory, bundles } = pnpmFixture();
  const storeFile = join(directory, 'simulated-global-store-file.js');
  linkSync(bundles[0], storeFile);
  assert.equal(patchMagicastBundle(directory).status, 'patched');
  for (const file of bundles)
    assert.equal(hash(readFileSync(file)), provenance.patchedSha256);
  assert.equal(hash(readFileSync(storeFile)), provenance.originalSha256);
  assert.equal(
    patchMagicastBundle(directory, { check: true }).status,
    'verified',
  );
});

test('an unknown late pnpm copy or lock integrity fails before any Magicast copy is changed', () => {
  for (const variation of ['bytes', 'integrity']) {
    const { directory, bundles } = pnpmFixture();
    if (variation === 'bytes') writeFileSync(bundles[1], 'unreviewed bundle');
    else {
      const lock = readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8');
      writeFileSync(
        join(directory, 'pnpm-lock.yaml'),
        lock.replace(provenance.tarballIntegrity, 'sha512-unreviewed'),
      );
    }
    const before = bundles.map((file) => readFileSync(file, 'utf8'));
    assert.throws(
      () => patchMagicastBundle(directory),
      /Unrecognized Magicast|Unreviewed locked/,
    );
    assert.deepEqual(
      bundles.map((file) => readFileSync(file, 'utf8')),
      before,
    );
  }
});

before(() => {
  let tarball = process.env.MEGAMONO_MAGICAST_TARBALL;
  if (!tarball) {
    try {
      const result = JSON.parse(
        execFileSync(
          process.platform === 'win32' ? 'npm.cmd' : 'npm',
          [
            'pack',
            provenance.tarball,
            '--offline',
            '--ignore-scripts',
            '--json',
            '--pack-destination',
            temporaryRoot,
          ],
          { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ),
      );
      tarball = join(temporaryRoot, result[0].filename);
    } catch (error) {
      throw new Error(
        'The immutable Magicast source artifact is not available from the npm cache. ' +
          `Prepare it with npm pack ${provenance.tarball} --ignore-scripts --pack-destination /tmp, ` +
          'then set MEGAMONO_MAGICAST_TARBALL to that file. No tests were skipped.',
        { cause: error },
      );
    }
  }
  const bytes = readFileSync(tarball);
  assert.equal(
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    provenance.tarballIntegrity,
  );
  const unpack = join(temporaryRoot, 'published');
  mkdirSync(unpack);
  execFileSync('tar', ['-xzf', tarball, '-C', unpack]);
  originalPackage = join(unpack, 'package');
  assert.equal(
    hash(readFileSync(join(originalPackage, provenance.bundle))),
    provenance.originalSha256,
  );
});

after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

test('the reviewed published artifact is fully externalized, verified, and idempotent', () => {
  const directory = fixture();
  assert.throws(
    () => patchMagicastBundle(directory, { check: true }),
    /still contains the embedded/,
  );
  assert.equal(patchMagicastBundle(directory).status, 'patched');
  const bundle = readFileSync(
    join(directory, 'node_modules/magicast', provenance.bundle),
    'utf8',
  );
  assert.equal(hash(bundle), provenance.patchedSha256);
  assert.equal(Buffer.byteLength(bundle), provenance.patchedBytes);
  assert.doesNotMatch(
    bundle,
    /source-map-js@1\.2\.1|require_source_map_consumer|require_source_map_generator/,
  );
  assert.match(bundle, /import \* as import_source_map from "source-map-js"/);
  assert.equal(
    patchMagicastBundle(directory, { check: true }).status,
    'verified',
  );
  assert.equal(patchMagicastBundle(directory).status, 'verified');
  assert.equal(
    readFileSync(
      join(directory, 'node_modules/magicast', provenance.bundle),
      'utf8',
    ),
    bundle,
  );
});

test('unknown bundle bytes fail closed without changing the artifact', () => {
  const directory = fixture();
  const file = join(directory, 'node_modules/magicast', provenance.bundle);
  const changed = `${readFileSync(file, 'utf8')}\n// unreviewed upstream edit\n`;
  writeFileSync(file, changed);
  assert.throws(
    () => patchMagicastBundle(directory),
    /Unrecognized Magicast bundle SHA256/,
  );
  assert.equal(readFileSync(file, 'utf8'), changed);
});

test('a colliding temporary file is preserved without modifying the bundle', () => {
  const directory = fixture();
  const bundle = join(directory, 'node_modules/magicast', provenance.bundle);
  const temporaryPath = `${bundle}.megamono-${process.pid}.tmp`;
  writeFileSync(temporaryPath, 'Preserve this existing file.');
  assert.throws(() => patchMagicastBundle(directory), { code: 'EEXIST' });
  assert.equal(
    readFileSync(temporaryPath, 'utf8'),
    'Preserve this existing file.',
  );
  assert.equal(hash(readFileSync(bundle)), provenance.originalSha256);
});

test('unreviewed package and external dependency versions fail closed', () => {
  for (const [name, version, message] of [
    ['magicast', '0.5.6', /Expected magicast@0\.5\.5/],
    ['source-map-js', '1.2.1', /Expected resolved source-map-js@1\.2\.2/],
  ]) {
    const directory = fixture();
    const manifest = join(directory, 'node_modules', name, 'package.json');
    const data = JSON.parse(readFileSync(manifest, 'utf8'));
    writeFileSync(manifest, JSON.stringify({ ...data, version }));
    assert.throws(() => patchMagicastBundle(directory), message);
    assert.equal(
      hash(
        readFileSync(
          join(directory, 'node_modules/magicast', provenance.bundle),
        ),
      ),
      provenance.originalSha256,
    );
  }
});

test('symlinked artifacts outside the fixture cannot be modified or trusted', () => {
  for (const name of ['magicast', 'source-map-js']) {
    const directory = fixture();
    const target = join(directory, 'node_modules', name);
    rmSync(target, { recursive: true });
    symlinkSync(packageRoot(name), target, 'dir');
    assert.throws(
      () => patchMagicastBundle(directory),
      /external or symlinked tooling path|tooling path outside/,
    );
  }
});

test('patched Magicast preserves parse/edit/generate, helpers, and valid source maps', async () => {
  const directory = fixture();
  patchMagicastBundle(directory);
  const packageDirectory = join(directory, 'node_modules/magicast/dist');
  const { parseModule, generateCode } = await import(
    pathToFileURL(join(packageDirectory, 'index.js')).href
  );
  const { parseExpression } = await import(
    pathToFileURL(join(packageDirectory, 'core.js')).href
  );
  const { addVitePlugin } = await import(
    pathToFileURL(join(packageDirectory, 'helpers.js')).href
  );
  assert.equal(typeof addVitePlugin, 'function');
  assert.equal(parseExpression('{ enabled: true }').enabled, true);
  const source =
    '// Preserve this comment.\nexport default { test: { coverage: { thresholds: { lines: 80 } } } };\n';
  const module = parseModule(source, { sourceFileName: 'vitest.config.ts' });
  module.exports.default.test.coverage.thresholds.lines = 85;
  const result = generateCode(module, {
    sourceMapName: 'vitest.config.ts.map',
  });
  assert.match(result.code, /Preserve this comment/);
  assert.equal(
    parseModule(result.code).exports.default.test.coverage.thresholds.lines,
    85,
  );
  assert.deepEqual(result.map.sources, ['vitest.config.ts']);
  assert.deepEqual(result.map.sourcesContent, [source]);
  const { SourceMapConsumer } = await import(
    pathToFileURL(join(directory, 'node_modules/source-map-js/source-map.js'))
      .href
  );
  const consumer = new SourceMapConsumer(result.map);
  assert.equal(
    consumer.originalPositionFor({ line: 2, column: 0 }).source,
    'vitest.config.ts',
  );
});

test(
  'Vitest V8 coverage rewrites thresholds through the patched Magicast dependency',
  { timeout: 60000 },
  () => {
    const directory = fixture();
    patchMagicastBundle(directory);
    for (const name of ['vitest', '@vitest/coverage-v8']) {
      const target = join(directory, 'node_modules', name);
      mkdirSync(dirname(target), { recursive: true });
      const source = packageRoot(name);
      cpSync(source, target, {
        recursive: true,
        filter: (file) => file !== join(source, 'node_modules'),
      });
      linkDependencies(directory, name);
    }
    const configPath = join(directory, 'vitest.config.mjs');
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    writeFileSync(
      configPath,
      `export default {
  test: {
    include: ['fixture.test.mjs'],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['value.mjs'],
      reporter: ['json-summary'],
      thresholds: { lines: 1, statements: 1, functions: 1, branches: 1, autoUpdate: true },
    },
  },
};
`,
    );
    writeFileSync(
      join(directory, 'value.mjs'),
      'export function value() { return 42; }\n',
    );
    writeFileSync(
      join(directory, 'fixture.test.mjs'),
      "import { expect, test } from 'vitest';\nimport { value } from './value.mjs';\ntest('covered value', () => expect(value()).toBe(42));\n",
    );
    const resolutionLog = join(directory, 'module-resolution.jsonl');
    const traceLoader = join(directory, 'trace-resolution.mjs');
    writeFileSync(
      traceLoader,
      `import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (specifier === 'magicast' || specifier === 'source-map-js') {
      appendFileSync(${JSON.stringify(resolutionLog)}, JSON.stringify({ specifier, parent: context.parentURL, url: result.url }) + '\\n');
    }
    return result;
  },
});
`,
    );
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        traceLoader,
        join(directory, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--root',
        directory,
        '--config',
        configPath,
        '--maxWorkers=1',
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 55000,
      },
    );
    assert.match(output, /Updating thresholds to configuration file/);
    const rewritten = readFileSync(configPath, 'utf8');
    for (const metric of ['lines', 'statements', 'functions', 'branches']) {
      assert.match(rewritten, new RegExp(`${metric}: 100`));
    }
    assert.doesNotMatch(rewritten, /__VITEST_COVERAGE_MARKER__/);
    const coverage = JSON.parse(
      readFileSync(join(directory, 'coverage/coverage-summary.json'), 'utf8'),
    );
    assert.equal(coverage.total.lines.pct, 100);
    const resolutions = readFileSync(resolutionLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(
      resolutions.some(
        (entry) =>
          entry.specifier === 'magicast' &&
          fileURLToPath(entry.url) ===
            join(
              realpathSync(directory),
              'node_modules/magicast/dist/index.js',
            ),
      ),
    );
    assert.ok(
      resolutions.some(
        (entry) =>
          entry.specifier === 'source-map-js' &&
          fileURLToPath(entry.url) ===
            join(
              realpathSync(directory),
              'node_modules/source-map-js/source-map.js',
            ) &&
          entry.parent.endsWith('/magicast/dist/builders-CDdrUKLb.js'),
      ),
    );
    assert.equal(
      patchMagicastBundle(directory, { check: true }).status,
      'verified',
    );
  },
);
