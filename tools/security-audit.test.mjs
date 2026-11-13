import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  auditArgs,
  auditEnvironment,
  evaluateAudit,
  runSecurityAudit,
  validateExceptionScope,
} from './security-audit.mjs';

const exception = JSON.parse(
  readFileSync(new URL('./security-audit-exception.json', import.meta.url)),
);
const reviewedNow = new Date('2026-11-13T18:00:00.000Z');
const advisory = () => ({
  module_name: 'deepmerge',
  github_advisory_id: 'GHSA-gcqx-w48m-w2h4',
  url: 'https://github.com/advisories/GHSA-gcqx-w48m-w2h4',
  severity: 'low',
  patched_versions: null,
  findings: [
    { version: '4.3.1', dev: true, paths: ['.>jest-config>deepmerge'] },
  ],
});
function audit(advisories = [advisory()]) {
  return {
    status: advisories.some((item) => item.severity !== 'info') ? 1 : 0,
    stdout: JSON.stringify({
      advisories: Object.fromEntries(
        advisories.map((item, index) => [index, item]),
      ),
      metadata: {
        vulnerabilities: Object.fromEntries(
          ['info', 'low', 'moderate', 'high', 'critical'].map((severity) => [
            severity,
            advisories.filter((item) => item.severity === severity).length,
          ]),
        ),
      },
    }),
  };
}
const evaluate = (result, now = reviewedNow) =>
  evaluateAudit(result, exception, now);

test('inherited pnpm settings cannot narrow the child audit', () => {
  const env = {
    PATH: '/bin',
    NODE_ENV: 'production',
    PNPM_CONFIG_PRODUCTION: 'true',
    pnpm_config_dev: 'true',
    NPM_CONFIG_ONLY: 'production',
    npm_config_optional: 'false',
    PNPM_CONFIG_FILTER: 'create-megamono',
    PNPM_CONFIG_LOCKFILE_DIR: '/other/workspace',
  };
  assert.deepEqual(auditEnvironment(env), {
    PATH: '/bin',
    NODE_ENV: 'production',
  });
  assert.equal(env.PNPM_CONFIG_PRODUCTION, 'true');
  for (const flag of [
    '--production=false',
    '--dev=false',
    '--optional=true',
    '--config.only=',
  ])
    assert(auditArgs.includes(flag));
});

test('lockfile coverage rejects new consumers even if audit paths are truncated', () => {
  const lock = {
    raw: { importers: { '.': {} } },
    entries: [
      { name: 'deepmerge', version: '4.3.1' },
      {
        name: 'jest-config',
        version: '30.5.2',
        dependencies: { deepmerge: '4.3.1' },
      },
    ],
  };
  assert.doesNotThrow(() => validateExceptionScope(lock, exception));
  for (const mutate of [
    (value) => {
      value.entries.push({
        name: 'new-consumer',
        version: '1.0.0',
        dependencies: { deepmerge: '4.3.1' },
      });
    },
    (value) => {
      value.entries[1].version = '30.5.3';
    },
    (value) => {
      value.entries[1].dependencies.deepmerge = '4.3.0';
    },
    (value) => {
      value.entries[0].version = '4.3.0';
    },
    (value) => {
      value.raw.importers['.'].devDependencies = {
        deepmerge: { version: '4.3.1' },
      };
    },
    (value) => {
      value.raw.importers['.'].dependencies = {
        deepmerge: { version: '4.3.1' },
      };
    },
    (value) => {
      value.entries = [];
    },
  ]) {
    const changed = structuredClone(lock);
    mutate(changed);
    assert.throws(
      () => validateExceptionScope(changed, exception),
      /new review/,
    );
  }
});

test('only the exact reviewed low development finding is accepted and remains visible', () => {
  assert.deepEqual(evaluate(audit()), { accepted: [advisory()], blocking: [] });
  assert.deepEqual(evaluate(audit([])), { accepted: [], blocking: [] });
});

test('info findings below the low threshold do not block admission', () => {
  const result = audit([]);
  const report = JSON.parse(result.stdout);
  report.metadata.vulnerabilities.info = 2;
  assert.deepEqual(evaluate({ ...result, stdout: JSON.stringify(report) }), {
    accepted: [],
    blocking: [],
  });
});

test('other advisories remain blocking even when the reviewed finding is present', () => {
  for (const severity of ['low', 'moderate', 'high', 'critical']) {
    const other = {
      ...advisory(),
      severity,
      github_advisory_id: 'GHSA-aaaa-bbbb-cccc',
    };
    assert.deepEqual(evaluate(audit([advisory(), other])), {
      accepted: [advisory()],
      blocking: [other],
    });
  }
});

test('changed severity, package, version, production use, or available fix requires review', () => {
  for (const change of [
    { module_name: 'other-package' },
    { github_advisory_id: 'GHSA-aaaa-bbbb-cccc' },
    { url: 'https://example.com/changed-advisory' },
    { severity: 'moderate' },
    { patched_versions: '>=4.3.2' },
    { findings: [{ ...advisory().findings[0], version: '4.3.0' }] },
    { findings: [{ ...advisory().findings[0], dev: false }] },
    {
      findings: [
        { ...advisory().findings[0], paths: ['.>unreviewed>deepmerge'] },
      ],
    },
    { findings: [{ version: '4.3.1', paths: ['.>deepmerge'] }] },
    {
      findings: [
        ...advisory().findings,
        { ...advisory().findings[0], dev: false },
      ],
    },
  ]) {
    const changed = { ...advisory(), ...change };
    assert.deepEqual(evaluate(audit([changed])), {
      accepted: [],
      blocking: [changed],
    });
  }
});

test('the exception expires without silently renewing even when no finding is returned', () => {
  for (const now of [
    new Date('2026-11-12T23:59:59.999Z'),
    new Date(exception.expiresAt),
    new Date('2026-12-14T00:00:00.000Z'),
    new Date('invalid'),
  ])
    for (const report of [audit(), audit([])])
      assert.throws(() => evaluate(report, now), /requires a current review/);
  assert.doesNotThrow(() =>
    evaluate(audit(), new Date('2026-12-12T23:59:59.999Z')),
  );
});

test('registry errors, malformed reports, and contradictory exit/count data fail closed', () => {
  const valid = audit();
  for (const changed of [
    { error: new Error('spawn failed') },
    { signal: 'SIGTERM', status: null },
    { status: 2 },
    { stdout: 'not JSON' },
    { stdout: '{}' },
    { stdout: '{"error":{"code":"ERR_PNPM_AUDIT_ENDPOINT_ERROR"}}' },
    { status: 0 },
  ])
    assert.throws(() => evaluate({ ...valid, ...changed }));
  for (const mutate of [
    (report) => {
      report.metadata.vulnerabilities.low = 0;
    },
    (report) => {
      report.metadata.vulnerabilities.other = 0;
    },
    (report) => {
      report.advisories[0].severity = 'unknown';
    },
    (report) => {
      report.advisories[0].findings = [];
    },
    (report) => {
      delete report.advisories[0].findings[0].paths;
    },
    (report) => {
      report.advisories[0].findings[0].paths = [];
    },
    (report) => {
      report.error = { message: 'partial response' };
    },
  ]) {
    const report = JSON.parse(valid.stdout);
    mutate(report);
    assert.throws(() => evaluate({ ...valid, stdout: JSON.stringify(report) }));
  }
});

test('the runner audits every dependency class, retains raw output and propagates failure', () => {
  const unrelated = {
    ...advisory(),
    github_advisory_id: 'GHSA-aaaa-bbbb-cccc',
  };
  for (const [report, expected] of [
    [audit(), 0],
    [audit([advisory(), unrelated]), 1],
    [{ status: 1, stdout: '{"error":"registry"}' }, 1],
  ]) {
    const output = [];
    const result = runSecurityAudit({
      run(command, args, options) {
        assert.equal(command, 'pnpm');
        assert.deepEqual(args, auditArgs);
        assert.equal(args.includes('--prod'), false);
        assert.equal(
          args.some((arg) => arg.startsWith('--ignore')),
          false,
        );
        assert.equal(options.encoding, 'utf8');
        return report;
      },
      log: (text) => output.push(text),
      error: (text) => output.push(text),
      now: reviewedNow,
    });
    assert.equal(output[0], report.stdout);
    assert.equal(result, expected);
    if (expected === 0) {
      assert(output.some((line) => /ACCEPTED UNTIL/.test(line)));
    }
  }
});
