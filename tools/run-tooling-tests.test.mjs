import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { downloadReviewedArtifact } from './run-tooling-tests.mjs';

const bytes = Buffer.from('immutable fixture archive');
const artifact = {
  name: 'fixture',
  version: '1.0.0',
  tarball: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
  tarballIntegrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
};
function destination(t) {
  const directory = mkdtempSync(join(tmpdir(), 'megamono-reviewed-download-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'fixture.tgz');
}

test('cold-cache preparation downloads the exact reviewed URL and verifies bytes', async (t) => {
  const file = destination(t);
  await downloadReviewedArtifact(artifact, file, async (url, options) => {
    assert.equal(url, artifact.tarball);
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    return new Response(bytes);
  });
  assert.deepEqual(readFileSync(file), bytes);
});

test('integrity drift fails before an archive can reach the repair tests', async (t) => {
  const file = destination(t);
  await assert.rejects(
    downloadReviewedArtifact(
      artifact,
      file,
      async () => new Response('changed archive'),
    ),
    /Unreviewed tarball integrity/,
  );
  assert.equal(existsSync(file), false);
});

test('HTTP and network failures remain failures without a cached fallback', async (t) => {
  const file = destination(t);
  await assert.rejects(
    downloadReviewedArtifact(
      artifact,
      file,
      async () => new Response('unavailable', { status: 503 }),
    ),
    /HTTP 503/,
  );
  await assert.rejects(
    downloadReviewedArtifact(artifact, file, async () => {
      throw new Error('offline');
    }),
    /offline/,
  );
  assert.equal(existsSync(file), false);
});

test('existing destination bytes are never silently replaced', async (t) => {
  const file = destination(t);
  writeFileSync(file, 'previous evidence');
  await assert.rejects(
    downloadReviewedArtifact(artifact, file, async () => new Response(bytes)),
    { code: 'EEXIST' },
  );
  assert.equal(readFileSync(file, 'utf8'), 'previous evidence');
});
