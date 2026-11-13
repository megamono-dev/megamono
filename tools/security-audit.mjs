#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readToolingLock } from './tooling-lock.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const auditArgs = [
  'audit',
  '--audit-level=low',
  '--production=false',
  '--dev=false',
  '--optional=true',
  '--config.only=',
  '--registry=https://registry.npmjs.org',
  '--json',
];
const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// pnpm normalizes false/false to both classes, but its PNPM_CONFIG_* environment
// layer can override those flags. Never let inherited settings narrow the audit.
export function auditEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^(?:pnpm|npm)_config_/i.test(key)),
  );
}

/** Audit paths may be truncated; verify every direct lockfile edge as well. */
export function validateExceptionScope(lock, exception) {
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies'];
  const directImport = Object.values(lock.raw.importers ?? {}).some(
    (importer) =>
      sections.some((section) => importer[section]?.[exception.package]),
  );
  const targets = lock.entries.filter(
    (entry) => entry.name === exception.package,
  );
  const consumers = lock.entries.filter((entry) =>
    sections.some((section) => entry[section]?.[exception.package]),
  );
  if (
    directImport ||
    !targets.length ||
    targets.some((entry) => entry.version !== exception.version) ||
    !consumers.length ||
    consumers.some(
      (entry) =>
        exception.consumers[entry.name] !== entry.version ||
        sections.some(
          (section) =>
            entry[section]?.[exception.package] &&
            entry[section][exception.package] !== exception.version,
        ),
    )
  )
    throw new Error('The deepmerge lockfile scope requires a new review.');
}

/** Evaluate the complete, unfiltered pnpm report; never suppress a whole package. */
export function evaluateAudit(result, exception, now = new Date()) {
  if (result.error || result.signal || ![0, 1].includes(result.status))
    throw new Error('pnpm audit did not complete successfully.');
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(Date.parse(exception.reviewedAt)) ||
    !Number.isFinite(Date.parse(exception.expiresAt)) ||
    now < new Date(exception.reviewedAt) ||
    now >= new Date(exception.expiresAt)
  )
    throw new Error('The deepmerge audit exception requires a current review.');
  const report = JSON.parse(result.stdout);
  const counts = report.metadata?.vulnerabilities;
  if (!object(report.advisories) || !object(counts) || report.error)
    throw new Error('pnpm audit returned an incomplete report.');
  const observed = Object.fromEntries(
    severities.map((severity) => [severity, 0]),
  );
  const accepted = [];
  const blocking = [];
  for (const advisory of Object.values(report.advisories)) {
    if (
      !object(advisory) ||
      !severities.includes(advisory.severity) ||
      typeof advisory.module_name !== 'string' ||
      !Array.isArray(advisory.findings) ||
      !advisory.findings.length ||
      advisory.findings.some(
        (finding) =>
          !object(finding) ||
          typeof finding.version !== 'string' ||
          !Array.isArray(finding.paths) ||
          !finding.paths.length ||
          finding.paths.some((path) => typeof path !== 'string' || !path),
      )
    )
      throw new Error('pnpm audit returned a malformed advisory.');
    observed[advisory.severity]++;
    const reviewed =
      advisory.github_advisory_id === exception.advisory &&
      advisory.url === `https://github.com/advisories/${exception.advisory}` &&
      advisory.module_name === exception.package &&
      advisory.severity === exception.severity &&
      advisory.patched_versions === null &&
      advisory.findings.every(
        (finding) =>
          finding.version === exception.version &&
          finding.dev === true &&
          finding.paths.every((path) => {
            const segments = path.split('>');
            return (
              segments.at(-1) === exception.package &&
              Object.hasOwn(exception.consumers, segments.at(-2))
            );
          }),
      );
    if (reviewed) accepted.push(advisory);
    else if (advisory.severity !== 'info') blocking.push(advisory);
  }
  if (
    severities.some(
      (severity) =>
        !Number.isSafeInteger(counts[severity]) ||
        counts[severity] < 0 ||
        // pnpm's low threshold omits info advisories, but retains their count.
        (severity !== 'info' && counts[severity] !== observed[severity]),
    ) ||
    Object.keys(counts).some((severity) => !severities.includes(severity)) ||
    result.status !== (severities.slice(1).some((key) => observed[key]) ? 1 : 0)
  )
    throw new Error('pnpm audit status and vulnerability counts disagree.');
  return { accepted, blocking };
}

export function runSecurityAudit({
  run = spawnSync,
  log = console.log,
  error = console.error,
  now = new Date(),
} = {}) {
  const result = run('pnpm', auditArgs, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env: auditEnvironment(process.env),
  });
  // Preserve the actual registry findings in CI, including the accepted finding.
  if (result.stdout) log(result.stdout.trimEnd());
  if (result.stderr) error(result.stderr.trimEnd());
  try {
    const exception = JSON.parse(
      readFileSync(new URL('./security-audit-exception.json', import.meta.url)),
    );
    const { accepted, blocking } = evaluateAudit(result, exception, now);
    if (accepted.length)
      validateExceptionScope(readToolingLock(root), exception);
    for (const advisory of accepted)
      log(
        `ACCEPTED UNTIL ${exception.expiresAt}: ${advisory.github_advisory_id} ${exception.package}@${exception.version} (${exception.severity}, development only). Review: ${exception.decision}`,
      );
    if (blocking.length) {
      error(
        `${blocking.length} unaccepted advisories block release admission.`,
      );
      return 1;
    }
    log(
      `Audit admission passed: ${accepted.length} time-limited exceptions; no unaccepted advisories at low severity or above.`,
    );
    return 0;
  } catch (failure) {
    error(`Audit admission failed: ${failure.message}`);
    return 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  process.exitCode = runSecurityAudit();
