#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXPECTED_REPOSITORY = 'megamono-dev/megamono';
const STABLE_SPECIFIERS = new Set(['patch', 'minor', 'major']);
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const NEXT_VERSION = /^\d+\.\d+\.\d+-next\.\d+$/;

export function resolveReleaseChannel({
  channel,
  specifier = '',
  repository,
  refName,
  refType,
  hasMegamonoRelease,
  hasCreateRelease,
}) {
  if (repository !== EXPECTED_REPOSITORY) {
    throw new Error(
      `Releases are restricted to ${EXPECTED_REPOSITORY}; received ${repository || '(empty)'}.`,
    );
  }
  if (refType !== 'branch') {
    throw new Error('Releases must be dispatched from a branch ref.');
  }
  if (hasMegamonoRelease !== hasCreateRelease) {
    throw new Error(
      'Megamono and create-megamono release histories are inconsistent.',
    );
  }

  if (channel === 'next') {
    if (refName !== 'main' && !/^release\/.+/.test(refName)) {
      throw new Error(
        'The next channel may only publish from main or a release/* branch.',
      );
    }
    const resolvedSpecifier = specifier || 'prerelease';
    if (
      resolvedSpecifier !== 'prerelease' &&
      !NEXT_VERSION.test(resolvedSpecifier)
    ) {
      throw new Error(
        'The next channel requires "prerelease" or an exact X.Y.Z-next.N version.',
      );
    }
    return {
      channel,
      specifier: resolvedSpecifier,
      preid: 'next',
      distTag: 'next',
      prerelease: true,
      firstRelease: !hasMegamonoRelease,
    };
  }

  if (channel === 'latest') {
    if (refName !== 'main') {
      throw new Error('The latest channel may only publish from main.');
    }
    const resolvedSpecifier = specifier || 'patch';
    if (
      !STABLE_SPECIFIERS.has(resolvedSpecifier) &&
      !STABLE_VERSION.test(resolvedSpecifier)
    ) {
      throw new Error(
        'The latest channel requires patch, minor, major, or an exact X.Y.Z version.',
      );
    }
    if (!hasMegamonoRelease) {
      throw new Error(
        'The latest channel requires an existing next release history.',
      );
    }
    return {
      channel,
      specifier: resolvedSpecifier,
      preid: '',
      distTag: 'latest',
      prerelease: false,
      firstRelease: false,
    };
  }

  throw new Error(`Unsupported release channel: ${channel || '(empty)'}.`);
}

function hasTag(pattern) {
  return (
    execFileSync('git', ['tag', '--list', pattern], { encoding: 'utf8' }).trim()
      .length > 0
  );
}

function writeOutputs(result) {
  const output = process.env.GITHUB_OUTPUT;
  const entries = {
    channel: result.channel,
    specifier: result.specifier,
    preid: result.preid,
    dist_tag: result.distTag,
    prerelease: String(result.prerelease),
    first_release: String(result.firstRelease),
  };
  if (!output) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }
  appendFileSync(
    output,
    `${Object.entries(entries)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    writeOutputs(
      resolveReleaseChannel({
        channel: process.env.RELEASE_CHANNEL,
        specifier: process.env.RELEASE_SPECIFIER?.trim(),
        repository: process.env.GITHUB_REPOSITORY,
        refName: process.env.GITHUB_REF_NAME,
        refType: process.env.GITHUB_REF_TYPE,
        hasMegamonoRelease: hasTag('megamono@*'),
        hasCreateRelease: hasTag('create-megamono@*'),
      }),
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
