import assert from 'node:assert/strict';
import test from 'node:test';

import { validateNextPromotion } from './check-next-promotion.mjs';
import { resolveReleaseChannel } from './resolve-release-channel.mjs';

const request = (overrides = {}) => ({
  channel: 'next',
  specifier: '',
  repository: 'megamono-dev/megamono',
  refName: 'main',
  refType: 'branch',
  hasMegamonoRelease: false,
  hasCreateRelease: false,
  ...overrides,
});

test('resolves the initial next release from main', () => {
  assert.deepEqual(resolveReleaseChannel(request()), {
    channel: 'next',
    specifier: 'prerelease',
    preid: 'next',
    distTag: 'next',
    prerelease: true,
    firstRelease: true,
  });
});

test('allows an exact next version from a release branch', () => {
  assert.equal(
    resolveReleaseChannel(
      request({
        refName: 'release/0.1',
        specifier: '0.1.0-next.0',
        hasMegamonoRelease: true,
        hasCreateRelease: true,
      }),
    ).specifier,
    '0.1.0-next.0',
  );
});

test('rejects next publication from a feature branch', () => {
  assert.throws(
    () => resolveReleaseChannel(request({ refName: 'feature/release-test' })),
    /main or a release\/\* branch/,
  );
});

test('resolves latest only from main with prior release history', () => {
  assert.deepEqual(
    resolveReleaseChannel(
      request({
        channel: 'latest',
        hasMegamonoRelease: true,
        hasCreateRelease: true,
      }),
    ),
    {
      channel: 'latest',
      specifier: 'patch',
      preid: '',
      distTag: 'latest',
      prerelease: false,
      firstRelease: false,
    },
  );
  assert.throws(
    () =>
      resolveReleaseChannel(
        request({
          channel: 'latest',
          refName: 'release/0.1',
          hasMegamonoRelease: true,
          hasCreateRelease: true,
        }),
      ),
    /only publish from main/,
  );
});

test('rejects incompatible channel versions and split release histories', () => {
  assert.throws(
    () => resolveReleaseChannel(request({ specifier: '0.1.0' })),
    /X\.Y\.Z-next\.N/,
  );
  assert.throws(
    () =>
      resolveReleaseChannel(
        request({ hasMegamonoRelease: true, hasCreateRelease: false }),
      ),
    /release histories are inconsistent/,
  );
});

test('requires every stable package to match its published next version', () => {
  assert.doesNotThrow(() =>
    validateNextPromotion([
      {
        name: '@megamono/plugin',
        currentVersion: '0.1.0-next.3',
        publishedVersion: '0.1.0-next.3',
      },
    ]),
  );
  assert.throws(
    () =>
      validateNextPromotion([
        {
          name: '@megamono/plugin',
          currentVersion: '0.1.0-next.3',
          publishedVersion: '0.1.0-next.2',
        },
      ]),
    /Stable promotion preflight failed/,
  );
});
