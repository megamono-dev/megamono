import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import { inventoryToolingDependency } from './tooling-dependency-inventory.mjs';
import { reviewMinimatch } from './minimatch-tooling-review.mjs';

const put = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
};
async function fixture(
  t,
  { pnpm = false, contexts = ['peer@1.0.0'], importer = false } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'megamono-dependency-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(join(root, 'package.json'), {
    name: 'inventory-fixture',
    version: '1.0.0',
    private: true,
    ...(importer ? { devDependencies: { minimatch: '^3.1.5' } } : {}),
  });
  const target = pnpm
    ? 'node_modules/.pnpm/minimatch@3.1.5/node_modules/minimatch'
    : 'node_modules/minimatch';
  await put(join(root, target, 'package.json'), {
    name: 'minimatch',
    version: '3.1.5',
    main: 'index.js',
  });
  await put(join(root, target, 'index.js'), 'module.exports = () => true;\n');
  const owners = [];
  for (const context of pnpm ? contexts : ['']) {
    const owner = pnpm
      ? `node_modules/.pnpm/review-consumer@1.0.0_${context.replace('@', '-')}/node_modules/review-consumer`
      : 'node_modules/review-consumer';
    owners.push(owner);
    await put(join(root, owner, 'package.json'), {
      name: 'review-consumer',
      version: '1.0.0',
      dependencies: { minimatch: '^3.1.5' },
    });
    if (pnpm)
      await symlink(
        join(root, target),
        join(root, dirname(owner), 'minimatch'),
      );
  }
  if (pnpm) {
    await symlink(
      join(root, owners[0]),
      join(root, 'node_modules/review-consumer'),
    );
    if (importer)
      await symlink(join(root, target), join(root, 'node_modules/minimatch'));
    const raw = {
      lockfileVersion: '9.0',
      importers: {
        '.': importer
          ? {
              devDependencies: {
                minimatch: { specifier: '^3.1.5', version: '3.1.5' },
              },
            }
          : {},
      },
      packages: {
        'review-consumer@1.0.0': {
          resolution: { integrity: 'sha512-fixture' },
        },
        'minimatch@3.1.5': { resolution: { integrity: 'sha512-target' } },
      },
      snapshots: {
        'minimatch@3.1.5': {},
        ...Object.fromEntries(
          contexts.map((context) => [
            `review-consumer@1.0.0(${context})`,
            { dependencies: { minimatch: '3.1.5' } },
          ]),
        ),
      },
    };
    await put(join(root, 'pnpm-lock.yaml'), stringify(raw));
    return { root, target, owners, raw };
  }
  await put(join(root, 'package-lock.json'), {
    lockfileVersion: 3,
    packages: {
      '': { name: 'inventory-fixture' },
      'node_modules/review-consumer': {
        version: '1.0.0',
        dependencies: { minimatch: '^3.1.5' },
      },
      'node_modules/minimatch': { version: '3.1.5' },
    },
  });
  return { root, target, owners };
}

test('npm inventory checks concrete owner paths and remains read-only', async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, 'package-lock.json'));
  const report = await inventoryToolingDependency(f.root, 'minimatch');
  assert.deepEqual(report.errors, []);
  assert.equal(report.lockfile.format, 'npm');
  assert.equal(report.consumers.length, 1);
  assert.equal(report.consumers[0].path, f.owners[0]);
  assert.equal(report.consumers[0].declaredRange, '^3.1.5');
  assert.equal(report.consumers[0].installed.matchesLockedVersion, true);
  assert.deepEqual(await readFile(join(f.root, 'package-lock.json')), before);
});

test('PNPM snapshots enumerate every installed peer-context copy without inventing physical context keys', async (t) => {
  const f = await fixture(t, {
    pnpm: true,
    contexts: ['peer@1.0.0', 'peer@2.0.0'],
  });
  const before = await readFile(join(f.root, 'pnpm-lock.yaml'));
  const report = await inventoryToolingDependency(f.root, 'minimatch');
  assert.deepEqual(report.errors, []);
  assert.equal(report.consumers.length, 2);
  assert.equal(report.lockfile.format, 'pnpm');
  for (const consumer of report.consumers) {
    assert.equal(consumer.lockKeys.length, 2);
    assert.deepEqual(consumer.resolutionRefs, ['3.1.5', '3.1.5']);
    assert.equal(consumer.range, '^3.1.5');
    assert.equal(consumer.installed.version, '3.1.5');
    assert.equal(consumer.installed.matchesLockedVersion, true);
    assert.equal(
      consumer.installed.peerContextAssociation,
      'not-inferred-identical-target-versions',
    );
  }
  assert.deepEqual(await readFile(join(f.root, 'pnpm-lock.yaml')), before);
});

test('PNPM importer dev dependency remains distinct from transitive snapshot edges', async (t) => {
  const f = await fixture(t, { pnpm: true, importer: true });
  const report = await inventoryToolingDependency(f.root, 'minimatch');
  assert.deepEqual(report.errors, []);
  const importer = report.consumers.find((c) => c.importer === '.');
  assert(importer);
  assert.equal(importer.path, '');
  assert.equal(importer.section, 'devDependencies');
  assert.equal(importer.declaredRange, '^3.1.5');
  assert.equal(importer.installed.matchesLockedVersion, true);
  assert.equal(report.consumers.length, 2);
});

test('different target candidates for identical named/versioned peer contexts cannot produce a false match', async (t) => {
  const f = await fixture(t, {
    pnpm: true,
    contexts: ['peer@1.0.0', 'peer@2.0.0'],
  });
  f.raw.packages['minimatch@3.1.4'] = {
    resolution: { integrity: 'sha512-older' },
  };
  f.raw.snapshots['minimatch@3.1.4'] = {};
  f.raw.snapshots['review-consumer@1.0.0(peer@2.0.0)'].dependencies.minimatch =
    '3.1.4';
  await put(join(f.root, 'pnpm-lock.yaml'), stringify(f.raw));
  const report = await inventoryToolingDependency(f.root, 'minimatch');
  assert.equal(report.installedResolutions, 'partial');
  assert(report.errors.length);
  assert(
    report.consumers.every((c) => c.installed.matchesLockedVersion === false),
  );
  assert(
    report.consumers.every(
      (c) =>
        c.installed.peerContextAssociation ===
        'ambiguous-differing-target-versions',
    ),
  );
});

test('installed package version drift and absent physical consumers are explicit incomplete coverage', async (t) => {
  const drift = await fixture(t, { pnpm: true });
  await put(join(drift.root, drift.target, 'package.json'), {
    name: 'minimatch',
    version: '3.1.4',
    main: 'index.js',
  });
  const report = await inventoryToolingDependency(drift.root, 'minimatch');
  assert.equal(report.installedResolutions, 'partial');
  assert.equal(report.consumers[0].installed.matchesLockedVersion, false);
  const missing = await fixture(t, { pnpm: true });
  await rm(join(missing.root, 'node_modules/review-consumer'));
  await rm(join(missing.root, missing.owners[0]), { recursive: true });
  const absent = await inventoryToolingDependency(missing.root, 'minimatch');
  assert.equal(absent.installedResolutions, 'partial');
  assert.match(absent.consumers[0].error, /No installed physical copy/);
});

test('consumer target symlinks outside the virtual store are refused', async (t) => {
  const f = await fixture(t, { pnpm: true });
  const outside = join(f.root, 'outside');
  await put(join(outside, 'package.json'), {
    name: 'minimatch',
    version: '3.1.5',
    main: 'index.js',
  });
  await put(join(outside, 'index.js'), 'throw new Error("must not execute");');
  const link = join(f.root, dirname(f.owners[0]), 'minimatch');
  await rm(link);
  await symlink(outside, link);
  const report = await inventoryToolingDependency(f.root, 'minimatch');
  assert.equal(report.installedResolutions, 'partial');
  assert.match(report.consumers[0].error, /outside|symlinked/);
});

test('minimatch review resolves legacy source anchors under the actual PNPM physical package', async (t) => {
  const f = await fixture(t, { pnpm: true });
  const nx = 'node_modules/.pnpm/nx@23.3.1/node_modules/nx';
  await put(join(f.root, nx, 'package.json'), {
    name: 'nx',
    version: '23.3.1',
  });
  await put(
    join(f.root, nx, 'dist/src/utils/find-matching-projects.js'),
    '// bounded makeRe( anchor\n',
  );
  const report = await reviewMinimatch(f.root);
  assert.deepEqual(report.errors, []);
  assert.equal(report.consumers[0].requestedMinimatch, '^3.1.5');
  assert.equal(report.consumers[0].installed.matchesLock, true);
  const anchor = report.sourceEvidence.find(
    (a) => a.owner === 'nx' && a.path?.endsWith('find-matching-projects.js'),
  );
  assert(anchor);
  assert.deepEqual(anchor.lines, [1]);
  assert.match(anchor.path, /node_modules\/\.pnpm\/nx@23\.3\.1/);
});
