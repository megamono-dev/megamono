import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import {
  patchMinimatchConsumers,
  provenance,
} from './patch-minimatch-consumers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const temporaryRoot = mkdtempSync(join(tmpdir(), 'megamono-minimatch-patch-'));
const originals = new Map();
const dependencies = new Map();
let fixtureNumber = 0;
const hash = (source) => createHash('sha256').update(source).digest('hex');
const artifactName = (expected) =>
  `${expected.name.replace(/^@/, '').replaceAll('/', '-')}-${expected.version}.tgz`;

before(() => {
  for (const expected of provenance.packages) {
    let tarball;
    if (process.env.MEGAMONO_MINIMATCH_TARBALL_DIR) {
      tarball = join(
        process.env.MEGAMONO_MINIMATCH_TARBALL_DIR,
        artifactName(expected),
      );
    } else {
      try {
        const result = JSON.parse(
          execFileSync(
            process.platform === 'win32' ? 'npm.cmd' : 'npm',
            [
              'pack',
              expected.tarball,
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
          `Immutable ${expected.name}@${expected.version} is not in the npm cache. ` +
            'Prepare the recorded artifacts in a temporary directory and set MEGAMONO_MINIMATCH_TARBALL_DIR; no test was skipped.',
          { cause: error },
        );
      }
    }
    const bytes = readFileSync(tarball);
    assert.equal(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      expected.tarballIntegrity,
    );
    const unpack = join(temporaryRoot, artifactName(expected).slice(0, -4));
    mkdirSync(unpack);
    execFileSync('tar', ['-xzf', tarball, '-C', unpack]);
    const directory = join(unpack, 'package');
    assert.equal(
      hash(readFileSync(join(directory, 'package.json'))),
      expected.manifestSha256,
    );
    for (const file of expected.files) {
      assert.equal(
        hash(readFileSync(join(directory, file.path))),
        file.originalSha256,
      );
    }
    originals.set(expected.name, directory);
  }
  // These reviewed dependencies already exist through the qualified glob14 path.
  const reporterRequire = createRequire(require.resolve('@jest/reporters'));
  const globRequire = createRequire(reporterRequire.resolve('glob'));
  for (const dependency of Object.values(provenance.dependencies)) {
    const resolver = dependency.name === 'glob' ? reporterRequire : globRequire;
    const bytes = readFileSync(
      resolver.resolve(`${dependency.name}/package.json`),
    );
    assert.equal(hash(bytes), dependency.manifestSha256);
    dependencies.set(dependency.name, bytes);
  }
});

after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function fixture() {
  const directory = join(temporaryRoot, `fixture-${fixtureNumber++}`);
  const lock = { lockfileVersion: 3, packages: {} };
  for (const expected of provenance.packages) {
    const key = `node_modules/${expected.name}`;
    const source = originals.get(expected.name);
    write(
      join(directory, key, 'package.json'),
      readFileSync(join(source, 'package.json')),
    );
    for (const file of expected.files) {
      write(
        join(directory, key, file.path),
        readFileSync(join(source, file.path)),
      );
    }
    lock.packages[key] = {
      version: expected.version,
      integrity: expected.tarballIntegrity,
    };
  }
  for (const dependency of Object.values(provenance.dependencies)) {
    const key = `node_modules/${dependency.name}`;
    write(
      join(directory, key, 'package.json'),
      dependencies.get(dependency.name),
    );
    lock.packages[key] = {
      version: dependency.version,
      integrity: dependency.tarballIntegrity,
    };
  }
  write(join(directory, 'package-lock.json'), JSON.stringify(lock));
  return directory;
}

function files(directory) {
  return provenance.packages.flatMap((expected) =>
    expected.files.map((file) => ({
      ...file,
      path: join(directory, 'node_modules', expected.name, file.path),
    })),
  );
}

const snapshot = (directory) =>
  files(directory).map((file) => hash(readFileSync(file.path)));

test('all four immutable artifacts migrate, verify, and rerun without changes', () => {
  const directory = fixture();
  const before = snapshot(directory);
  assert.throws(
    () => patchMinimatchConsumers(directory, { check: true }),
    /still require the minimatch migration/,
  );
  assert.deepEqual(snapshot(directory), before);
  assert.deepEqual(patchMinimatchConsumers(directory), {
    status: 'patched',
    changedFiles: 8,
    reviewedFiles: 8,
  });
  for (const file of files(directory)) {
    assert.equal(hash(readFileSync(file.path)), file.patchedSha256);
    const type =
      file.path.endsWith('.mjs') || file.path.includes('/dist/es/')
        ? 'module'
        : 'commonjs';
    execFileSync(process.execPath, ['--check', `--input-type=${type}`], {
      input: readFileSync(file.path),
    });
  }
  const patched = snapshot(directory);
  for (const check of [true, false]) {
    assert.deepEqual(patchMinimatchConsumers(directory, { check }), {
      status: 'verified',
      changedFiles: 0,
      reviewedFiles: 8,
    });
    assert.deepEqual(snapshot(directory), patched);
  }
});

test('unknown bytes in the last package fail before any package is changed', () => {
  const directory = fixture();
  const last = files(directory).at(-1);
  writeFileSync(last.path, `${readFileSync(last.path, 'utf8')}\n// changed\n`);
  const before = snapshot(directory);
  assert.throws(
    () => patchMinimatchConsumers(directory),
    /Unrecognized .*SHA256/,
  );
  assert.deepEqual(snapshot(directory), before);
});

test('package, dependency, and lockfile identity changes fail without patching', () => {
  for (const variation of ['package', 'dependency', 'lock']) {
    const directory = fixture();
    const target =
      variation === 'lock'
        ? join(directory, 'package-lock.json')
        : join(
            directory,
            'node_modules',
            variation === 'package' ? 'nx' : 'minimatch',
            'package.json',
          );
    const value = JSON.parse(readFileSync(target, 'utf8'));
    if (variation === 'lock')
      value.packages['node_modules/nx'].integrity = 'sha512-changed';
    else value.version = '99.0.0';
    writeFileSync(target, JSON.stringify(value));
    const before = snapshot(directory);
    assert.throws(
      () => patchMinimatchConsumers(directory),
      /Unreviewed .*manifest|Unreviewed locked/,
    );
    assert.deepEqual(snapshot(directory), before);
  }
});

test('a late temporary-file collision leaves destinations and collision bytes untouched', () => {
  const directory = fixture();
  const paths = files(directory);
  const collision = `${paths.at(-1).path}.megamono-minimatch-${process.pid}.tmp`;
  writeFileSync(collision, 'owned by another operation');
  const before = snapshot(directory);
  assert.throws(() => patchMinimatchConsumers(directory), { code: 'EEXIST' });
  assert.deepEqual(snapshot(directory), before);
  assert.equal(readFileSync(collision, 'utf8'), 'owned by another operation');
  for (const file of paths.slice(0, -1)) {
    assert.equal(
      existsSync(`${file.path}.megamono-minimatch-${process.pid}.tmp`),
      false,
    );
  }
});

test('symlinked sources, dependencies, and intermediate directories cannot be patched', () => {
  for (const variation of ['source', 'dependency', 'directory']) {
    const directory = fixture();
    const outside = join(temporaryRoot, `outside-${fixtureNumber}`);
    mkdirSync(outside);
    const source = files(directory)[0];
    const bytes = readFileSync(source.path);
    writeFileSync(join(outside, 'artifact.js'), bytes);
    let target;
    let destination;
    if (variation === 'source') {
      target = source.path;
      destination = join(outside, 'artifact.js');
    } else if (variation === 'dependency') {
      target = join(directory, 'node_modules/minimatch/package.json');
      destination = join(outside, 'package.json');
      writeFileSync(destination, dependencies.get('minimatch'));
    } else {
      target = dirname(source.path);
      destination = outside;
    }
    rmSync(target, { recursive: true });
    symlinkSync(
      destination,
      target,
      variation === 'directory' ? 'dir' : 'file',
    );
    assert.throws(
      () => patchMinimatchConsumers(directory),
      /symlinked tooling path|tooling path outside/,
    );
    assert.deepEqual(readFileSync(join(outside, 'artifact.js')), bytes);
  }
});

test('an interrupted migration with reviewed mixed states is safely completed', () => {
  const directory = fixture();
  patchMinimatchConsumers(directory);
  const expected = provenance.packages[0];
  const first = expected.files[0];
  writeFileSync(
    join(directory, 'node_modules', expected.name, first.path),
    readFileSync(join(originals.get(expected.name), first.path)),
  );
  assert.equal(patchMinimatchConsumers(directory).changedFiles, 1);
  assert.equal(
    patchMinimatchConsumers(directory, { check: true }).status,
    'verified',
  );
});
