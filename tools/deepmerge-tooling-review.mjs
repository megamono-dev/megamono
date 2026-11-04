#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolRoot = dirname(fileURLToPath(import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const dependency = 'deepmerge';
const advisoryId = 'GHSA-gcqx-w48m-w2h4';
const cveId = 'CVE-2026-93753';

export const evidenceRequests = {
  cve: {
    url: `https://raw.githubusercontent.com/CVEProject/cvelistV5/main/cves/2026/93xxx/${cveId}.json`,
  },
  github: { url: `https://api.github.com/advisories/${advisoryId}` },
  npm: { url: 'https://registry.npmjs.org/deepmerge/latest' },
  npmAdvisory: {
    url: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    method: 'POST',
    requestBody: { deepmerge: ['4.3.1'] },
  },
};

function inside(root, candidate) {
  const path = relative(root, candidate);
  return (
    !isAbsolute(path) &&
    path !== '..' &&
    !path.startsWith('../') &&
    !path.startsWith('..\\')
  );
}

/** Provider facts remain separate: a rejected CVE does not imply GHSA/npm withdrawal. */
export function summarizeDeepmergeEvidence(evidence) {
  const records = evidence.records;
  const cve = records?.cve?.body;
  const github = records?.github?.body;
  const npm = records?.npm?.body;
  const bulk = records?.npmAdvisory?.body;
  if (
    cve?.cveMetadata?.cveId !== cveId ||
    !['REJECTED', 'PUBLISHED', 'RESERVED'].includes(cve.cveMetadata.state)
  )
    throw new Error(
      'CVE response does not identify the expected record and state.',
    );
  if (
    github?.ghsa_id !== advisoryId ||
    github.cve_id !== cveId ||
    !Object.hasOwn(github, 'withdrawn_at') ||
    !(
      github.withdrawn_at === null ||
      (typeof github.withdrawn_at === 'string' &&
        Number.isFinite(Date.parse(github.withdrawn_at)))
    )
  )
    throw new Error(
      'GitHub response does not identify the expected advisory and withdrawal state.',
    );
  if (npm?.name !== dependency || typeof npm.version !== 'string')
    throw new Error(
      'npm latest response does not identify deepmerge and its version.',
    );
  if (
    !bulk ||
    typeof bulk !== 'object' ||
    Array.isArray(bulk) ||
    (bulk.deepmerge !== undefined && !Array.isArray(bulk.deepmerge))
  )
    throw new Error('npm bulk response is not an advisory record.');
  const requestedVersions = records.npmAdvisory.requestBody?.deepmerge;
  if (
    !Array.isArray(requestedVersions) ||
    requestedVersions.length !== 1 ||
    requestedVersions[0] !== '4.3.1'
  )
    throw new Error(
      'npm bulk evidence must state its exact requested deepmerge version.',
    );
  return {
    cve: {
      id: cveId,
      state: cve.cveMetadata.state,
      assigner: cve.cveMetadata.assignerShortName,
      updatedAt: cve.cveMetadata.dateUpdated,
      rejectedAt: cve.cveMetadata.dateRejected ?? null,
      reasons: (cve.containers?.cna?.rejectedReasons ?? []).map(
        (reason) => reason.value,
      ),
    },
    github: {
      id: advisoryId,
      updatedAt: github.updated_at,
      withdrawnAt: github.withdrawn_at,
      state: github.withdrawn_at === null ? 'active' : 'withdrawn',
      severity: github.severity,
      affected: github.vulnerabilities,
    },
    npm: {
      latest: npm.version,
      requestedVersions,
      advisoryReturned: (bulk.deepmerge ?? []).some(
        (item) => item.url === `https://github.com/advisories/${advisoryId}`,
      ),
      reportedAdvisories: bulk.deepmerge ?? [],
    },
  };
}

export async function fetchDeepmergeEvidence(
  fetchImplementation = globalThis.fetch,
) {
  const records = Object.fromEntries(
    await Promise.all(
      Object.entries(evidenceRequests).map(async ([key, request]) => {
        const response = await fetchImplementation(request.url, {
          method: request.method ?? 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Megamono-Dependency-Review',
            ...(request.requestBody
              ? { 'Content-Type': 'application/json' }
              : {}),
          },
          ...(request.requestBody
            ? { body: JSON.stringify(request.requestBody) }
            : {}),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok)
          throw new Error(`${request.url}: HTTP ${response.status}`);
        const raw = await response.text();
        return [
          key,
          {
            ...request,
            checkedAt: new Date().toISOString(),
            status: response.status,
            rawSha256: digest(raw),
            body: JSON.parse(raw),
          },
        ];
      }),
    ),
  );
  const evidence = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    records,
  };
  summarizeDeepmergeEvidence(evidence);
  return evidence;
}

const behaviorProgram = `
const merge = require(process.argv[1]);
const marker = '__megamonoDeepmergeReviewFlag__';
const payload = JSON.stringify({session: JSON.parse('{"__proto__":{"__megamonoDeepmergeReviewFlag__":true}}')});
const cases = [
  ['plain-object-target', () => ({session:{}}), () => JSON.parse(payload)],
  ['null-placeholder', () => ({session:null}), () => JSON.parse(payload)],
  ['null-prototype-target', () => Object.create(null), () => JSON.parse('{"__proto__":{"__megamonoDeepmergeReviewFlag__":true}}')],
  ['target-own-proto-key', () => JSON.parse('{"__proto__":{"__megamonoDeepmergeReviewFlag__":true}}'), () => ({})],
  ['ordinary-own-value', () => ({session:null}), () => ({session:{[marker]:true}})],
].map(([name,target,source]) => {
  const result = merge(target(),source());
  const inspected = Object.hasOwn(result,'session') ? result.session : result;
  return {name, resultDefaultPrototype:Object.getPrototypeOf(inspected)===Object.prototype,
    markerValue:inspected[marker] ?? null, ownMarker:Object.hasOwn(inspected,marker),
    globalPrototypeUnchanged:!Object.hasOwn(Object.prototype,marker) && ({})[marker]===undefined};
});
process.stdout.write(JSON.stringify(cases));
`;

async function inspectInstalled(root, lock, path) {
  const consumer = resolve(root, path);
  if (!inside(root, consumer))
    throw new Error(`Lockfile consumer path escapes the workspace: ${path}`);
  const require = createRequire(join(consumer, 'package.json'));
  const manifestPath = await realpath(
    require.resolve('deepmerge/package.json'),
  );
  if (!inside(root, manifestPath))
    throw new Error(
      `Installed deepmerge resolves outside the workspace for ${path}.`,
    );
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.name !== dependency)
    throw new Error(`Resolved manifest is not deepmerge for ${path}.`);
  const entry = await realpath(require.resolve('deepmerge'));
  if (!inside(dirname(manifestPath), entry))
    throw new Error(
      `Installed deepmerge entry escapes its package for ${path}.`,
    );
  const packagePath = relative(root, dirname(manifestPath)).replaceAll(
    '\\',
    '/',
  );
  const locked = lock.packages[packagePath];
  return {
    packagePath,
    version: manifest.version,
    manifestSha256: digest(manifestBytes),
    entry: relative(root, entry).replaceAll('\\', '/'),
    entrySha256: digest(await readFile(entry)),
    lockedVersion: locked?.version ?? null,
    matchesLockedVersion: locked?.version === manifest.version,
  };
}

export async function reviewDeepmerge(
  workspaceRoot,
  { live = false, fetchImplementation } = {},
) {
  const root = await realpath(workspaceRoot);
  const lockBytes = await readFile(join(root, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  if (!lock.packages || typeof lock.packages !== 'object')
    throw new Error('The npm lockfile has no packages inventory.');
  const errors = [];
  const consumers = [];
  for (const [path, manifest] of Object.entries(lock.packages).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    for (const section of ['dependencies', 'optionalDependencies']) {
      if (!manifest[section]?.deepmerge) continue;
      const consumer = {
        path,
        version: manifest.version,
        section,
        range: manifest[section].deepmerge,
      };
      try {
        consumer.installed = await inspectInstalled(root, lock, path);
        if (!consumer.installed.matchesLockedVersion)
          errors.push(
            `${path}: installed deepmerge does not match its locked version.`,
          );
      } catch (error) {
        consumer.error = error.message;
        errors.push(`${path}: ${error.message}`);
      }
      consumers.push(consumer);
    }
  }
  const boundedBehavior = [];
  const seen = new Set();
  for (const consumer of consumers) {
    const installed = consumer.installed;
    if (!installed || seen.has(installed.packagePath)) continue;
    seen.add(installed.packagePath);
    try {
      const output = execFileSync(
        process.execPath,
        ['-e', behaviorProgram, join(root, installed.entry)],
        {
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          env: { PATH: process.env.PATH ?? '' },
        },
      );
      boundedBehavior.push({
        packagePath: installed.packagePath,
        version: installed.version,
        cases: JSON.parse(output),
      });
    } catch (error) {
      errors.push(
        `${installed.packagePath}: bounded behavior inspection failed (${error.message}).`,
      );
    }
  }
  let advisoryEvidence;
  try {
    const snapshotPath = join(toolRoot, 'deepmerge-advisory.evidence.json');
    const snapshotBytes = live ? undefined : await readFile(snapshotPath);
    const evidence = live
      ? await fetchDeepmergeEvidence(fetchImplementation)
      : JSON.parse(snapshotBytes);
    advisoryEvidence = {
      mode: live ? 'live' : 'recorded',
      status: 'completed',
      recordedAt: evidence.recordedAt,
      ...(!live
        ? {
            snapshot: relative(root, snapshotPath).replaceAll('\\', '/'),
            snapshotSha256: digest(snapshotBytes),
          }
        : {}),
      sources: Object.fromEntries(
        Object.entries(evidence.records).map(([key, value]) => [
          key,
          {
            url: value.url,
            checkedAt: value.checkedAt,
            rawSha256: value.rawSha256,
          },
        ]),
      ),
      facts: summarizeDeepmergeEvidence(evidence),
      ...(!live && evidence.workspaceAudit
        ? { recordedWorkspaceAudit: evidence.workspaceAudit }
        : {}),
      ...(live ? { records: evidence.records } : {}),
    };
  } catch (error) {
    errors.push(`Advisory evidence: ${error.message}`);
    advisoryEvidence = {
      mode: live ? 'live' : 'recorded',
      status: 'incomplete',
      error: error.message,
    };
  }
  return {
    schemaVersion: 1,
    reviewedAt: new Date().toISOString(),
    scope:
      'Read-only lockfile/resolution inventory, bounded object behavior, and separate advisory-provider facts.',
    lockfileSha256: digest(lockBytes),
    consumers,
    boundedBehavior,
    advisoryEvidence,
    coverage: {
      lockInventory: 'completed',
      installedResolutions: consumers.some(
        (consumer) =>
          consumer.error || !consumer.installed?.matchesLockedVersion,
      )
        ? 'partial'
        : 'completed',
      boundedBehavior:
        boundedBehavior.length === seen.size
          ? seen.size
            ? 'completed'
            : 'not-assessed'
          : 'partial',
    },
    admission: { assessment: 'not-performed', auditPolicyChanged: false },
    errors,
    limitations: [
      'Recorded evidence is dated, not a fresh registry audit; use --live to refresh provider facts without writing files.',
      'Live npm bulk queries cover only deepmerge4.3.1, not a full-workspace audit. Any recorded full-workspace audit is dated evidence.',
      'CVE rejection, GitHub withdrawal, and npm advisory responses are distinct provider facts.',
      'Returned-object behavior is not an exploit demonstration or proof of a privilege boundary; global-prototype behavior is reported separately.',
      'Installed-resolution inventory and bounded examples do not establish all call-site reachability or absence of other security findings.',
      'This tool does not patch dependencies, suppress advisories, change audit thresholds, or approve a release.',
    ],
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => arg !== '--live') ||
    new Set(args).size !== args.length
  ) {
    console.error('Usage: node tools/deepmerge-tooling-review.mjs [--live]');
    process.exitCode = 1;
  } else {
    try {
      const report = await reviewDeepmerge(resolve(toolRoot, '..'), {
        live: args.includes('--live'),
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.errors.length) process.exitCode = 1;
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
