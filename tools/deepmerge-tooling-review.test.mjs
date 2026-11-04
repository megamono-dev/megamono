import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  evidenceRequests,
  fetchDeepmergeEvidence,
  reviewDeepmerge,
  summarizeDeepmergeEvidence,
} from './deepmerge-tooling-review.mjs';

const tools = dirname(fileURLToPath(import.meta.url));
const root = resolve(tools, '..');
const snapshot = JSON.parse(
  await readFile(join(tools, 'deepmerge-advisory.evidence.json'), 'utf8'),
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function mockFetch(evidence = snapshot) {
  const calls = [];
  const fetch = async (url, options) => {
    const key = Object.keys(evidenceRequests).find(
      (key) => evidenceRequests[key].url === url,
    );
    assert(key, `Unexpected external request ${url}`);
    calls.push({ key, url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(evidence.records[key].body),
    };
  };
  return { fetch, calls };
}

async function fixture(
  t,
  {
    installed = true,
    lockedVersion = '4.3.1',
    consumerPath = 'node_modules/review-consumer',
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'megamono-deepmerge-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'package.json'),
    '{"name":"deepmerge-review-fixture","private":true}\n',
  );
  await writeFile(
    join(directory, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'deepmerge-review-fixture' },
        [consumerPath]: {
          version: '1.0.0',
          dependencies: { deepmerge: '^4.3.1' },
        },
        'node_modules/deepmerge': { version: lockedVersion },
      },
    }),
  );
  if (installed) {
    await mkdir(join(directory, 'node_modules/review-consumer'), {
      recursive: true,
    });
    await writeFile(
      join(directory, 'node_modules/review-consumer/package.json'),
      '{"name":"review-consumer","version":"1.0.0"}',
    );
    await cp(
      join(root, 'node_modules/deepmerge'),
      join(directory, 'node_modules/deepmerge'),
      { recursive: true },
    );
  }
  return directory;
}

test('dated evidence retains the rejected CVE and still-active GHSA/npm as separate facts', () => {
  const facts = summarizeDeepmergeEvidence(snapshot);
  assert.equal(facts.cve.state, 'REJECTED');
  assert.equal(facts.cve.rejectedAt, '2026-11-02T16:33:19.357Z');
  assert.equal(facts.github.state, 'active');
  assert.equal(facts.github.withdrawnAt, null);
  assert.equal(facts.npm.latest, '4.3.1');
  assert.equal(facts.npm.advisoryReturned, true);
  assert.deepEqual(facts.npm.requestedVersions, ['4.3.1']);
  for (const record of Object.values(snapshot.records)) {
    assert.match(record.rawSha256, /^[a-f0-9]{64}$/);
    assert(Number.isFinite(Date.parse(record.checkedAt)));
  }
});

test('read-only installed inventory and isolated behavior do not mutate files or imply release admission', async (t) => {
  const directory = await fixture(t);
  const entry = join(directory, 'node_modules/deepmerge/dist/cjs.js');
  const before = await Promise.all([
    readFile(entry),
    readFile(join(directory, 'package-lock.json')),
  ]);
  const report = await reviewDeepmerge(directory, {
    fetchImplementation: () =>
      assert.fail('Recorded mode must not request the network.'),
  });
  assert.deepEqual(report.errors, []);
  assert.equal(report.consumers.length, 1);
  assert.equal(report.consumers[0].installed.version, '4.3.1');
  assert.equal(report.consumers[0].installed.matchesLockedVersion, true);
  assert.equal(report.consumers[0].installed.entrySha256, hash(before[0]));
  assert.deepEqual(report.admission, {
    assessment: 'not-performed',
    auditPolicyChanged: false,
  });
  assert.equal(report.advisoryEvidence.mode, 'recorded');
  assert.equal(report.advisoryEvidence.recordedAt, snapshot.recordedAt);
  const cases = Object.fromEntries(
    report.boundedBehavior[0].cases.map((item) => [item.name, item]),
  );
  assert.equal(cases['plain-object-target'].markerValue, null);
  for (const name of [
    'null-placeholder',
    'null-prototype-target',
    'target-own-proto-key',
  ]) {
    assert.equal(cases[name].resultDefaultPrototype, false);
    assert.equal(cases[name].markerValue, true);
    assert.equal(cases[name].ownMarker, false);
  }
  assert.equal(cases['ordinary-own-value'].markerValue, true);
  assert.equal(cases['ordinary-own-value'].ownMarker, true);
  assert(
    report.boundedBehavior[0].cases.every(
      (item) => item.globalPrototypeUnchanged,
    ),
  );
  assert.deepEqual(
    await Promise.all([
      readFile(entry),
      readFile(join(directory, 'package-lock.json')),
    ]),
    before,
  );
});

test('actual workspace review inventories every deepmerge edge and installed resolution without downloads', async () => {
  const lock = JSON.parse(
    await readFile(join(root, 'package-lock.json'), 'utf8'),
  );
  const expected = Object.entries(lock.packages).flatMap(([path, manifest]) =>
    ['dependencies', 'optionalDependencies'].flatMap((section) =>
      manifest[section]?.deepmerge ? [`${path}:${section}`] : [],
    ),
  );
  const report = await reviewDeepmerge(root);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(
    report.consumers.map((item) => `${item.path}:${item.section}`).sort(),
    expected.sort(),
  );
  assert(report.consumers.every((item) => item.installed.matchesLockedVersion));
  assert.equal(
    report.boundedBehavior.length,
    new Set(report.consumers.map((item) => item.installed.packagePath)).size,
  );
});

test('missing installs and lock/version drift produce partial coverage and errors', async (t) => {
  const missing = await reviewDeepmerge(await fixture(t, { installed: false }));
  assert.equal(missing.coverage.installedResolutions, 'partial');
  assert.equal(missing.coverage.boundedBehavior, 'not-assessed');
  assert(missing.errors.length);
  assert.equal(missing.admission.assessment, 'not-performed');
  const drifted = await reviewDeepmerge(
    await fixture(t, { lockedVersion: '4.2.2' }),
  );
  assert.equal(drifted.coverage.installedResolutions, 'partial');
  assert.equal(drifted.consumers[0].installed.matchesLockedVersion, false);
  assert(drifted.errors.some((error) => /locked version/.test(error)));
});

test('lockfile escape paths are refused before resolving packages outside the workspace', async (t) => {
  const directory = await fixture(t, {
    installed: false,
    consumerPath: '../outside',
  });
  const report = await reviewDeepmerge(directory);
  assert.equal(report.coverage.installedResolutions, 'partial');
  assert.match(report.consumers[0].error, /escapes the workspace/);
  assert.equal(report.boundedBehavior.length, 0);
});

test('live verification requests all fixed primary sources and exact npm bulk input', async () => {
  const { fetch, calls } = mockFetch();
  const evidence = await fetchDeepmergeEvidence(fetch);
  assert.equal(calls.length, 4);
  assert.equal(summarizeDeepmergeEvidence(evidence).cve.state, 'REJECTED');
  assert.equal(summarizeDeepmergeEvidence(evidence).github.state, 'active');
  const bulk = calls.find((item) => item.key === 'npmAdvisory');
  assert.equal(bulk.options.method, 'POST');
  assert.deepEqual(JSON.parse(bulk.options.body), { deepmerge: ['4.3.1'] });
  assert(calls.every((call) => call.options.signal instanceof AbortSignal));
  for (const record of Object.values(evidence.records))
    assert.equal(record.rawSha256, hash(JSON.stringify(record.body)));
});

test('a live provider failure never falls back to dated withdrawal/rejection evidence', async (t) => {
  const directory = await fixture(t, { installed: false });
  const report = await reviewDeepmerge(directory, {
    live: true,
    fetchImplementation: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(report.advisoryEvidence.mode, 'live');
  assert.equal(report.advisoryEvidence.status, 'incomplete');
  assert.equal(report.advisoryEvidence.facts, undefined);
  assert(report.errors.some((error) => /HTTP 503/.test(error)));
  assert.equal(report.admission.auditPolicyChanged, false);
});

test('malformed, unrelated, or unspecified provider responses cannot imply withdrawal', async () => {
  for (const mutate of [
    (evidence) => {
      evidence.records.cve.body.cveMetadata.cveId = 'CVE-0000-0000';
    },
    (evidence) => {
      evidence.records.github.body.ghsa_id = 'GHSA-other';
    },
    (evidence) => {
      delete evidence.records.github.body.withdrawn_at;
    },
    (evidence) => {
      evidence.records.github.body.withdrawn_at = '';
    },
    (evidence) => {
      evidence.records.npmAdvisory.requestBody = {};
    },
  ]) {
    const altered = structuredClone(snapshot);
    mutate(altered);
    assert.throws(() => summarizeDeepmergeEvidence(altered));
  }
  const emptyBulk = structuredClone(snapshot);
  emptyBulk.records.npmAdvisory.body = {};
  const facts = summarizeDeepmergeEvidence(emptyBulk);
  assert.equal(facts.npm.advisoryReturned, false);
  assert.equal(facts.github.state, 'active');
  const malformed = mockFetch();
  await assert.rejects(
    fetchDeepmergeEvidence(async (url, options) =>
      url === evidenceRequests.cve.url
        ? { ok: true, status: 200, text: async () => '{' }
        : malformed.fetch(url, options),
    ),
    SyntaxError,
  );
});

test('CLI emits the read-only report and refuses unsupported flags', () => {
  const script = join(tools, 'deepmerge-tooling-review.mjs');
  const output = execFileSync(process.execPath, [script], { encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.admission.assessment, 'not-performed');
  assert.equal(report.advisoryEvidence.mode, 'recorded');
  const failure = spawnSync(process.execPath, [script, '--fix'], {
    encoding: 'utf8',
  });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /Usage:/);
});
