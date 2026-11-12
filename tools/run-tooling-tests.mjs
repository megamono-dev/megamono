import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const magicast = JSON.parse(
  readFileSync(new URL('./magicast-bundle.provenance.json', import.meta.url)),
);
const minimatch = JSON.parse(
  readFileSync(
    new URL('./minimatch-consumers.provenance.json', import.meta.url),
  ),
);
const artifactName = ({ name, version }) =>
  `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;

function verifyArtifact(bytes, artifact) {
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== artifact.tarballIntegrity)
    throw new Error(
      `Unreviewed tarball integrity for ${artifact.name}@${artifact.version}.`,
    );
}

/** Fetch only immutable reviewed archives; never run pack/install lifecycle hooks. */
export async function downloadReviewedArtifact(
  artifact,
  destination,
  fetchImpl = fetch,
) {
  const response = await fetchImpl(artifact.tarball, {
    signal: AbortSignal.timeout(120_000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      `Could not fetch ${artifact.name}@${artifact.version}: HTTP ${response.status}.`,
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyArtifact(bytes, artifact);
  writeFileSync(destination, bytes, { flag: 'wx' });
}

/** Explicit archives also support offline runs without depending on npm's cache. */
export async function prepareToolingTestArtifacts(
  directory,
  env = process.env,
) {
  const magicastArtifact = { ...magicast, name: magicast.package };
  const definitions = [magicastArtifact, ...minimatch.packages];
  const locations = [];
  for (const artifact of definitions) {
    const provided =
      artifact === magicastArtifact
        ? env.MEGAMONO_MAGICAST_TARBALL
        : env.MEGAMONO_MINIMATCH_TARBALL_DIR &&
          join(env.MEGAMONO_MINIMATCH_TARBALL_DIR, artifactName(artifact));
    const location = provided || join(directory, artifactName(artifact));
    if (provided) verifyArtifact(readFileSync(provided), artifact);
    else await downloadReviewedArtifact(artifact, location);
    locations.push(location);
  }
  return {
    MEGAMONO_MAGICAST_TARBALL: resolve(locations[0]),
    MEGAMONO_MINIMATCH_TARBALL_DIR: resolve(
      env.MEGAMONO_MINIMATCH_TARBALL_DIR || directory,
    ),
  };
}

export async function runToolingTests() {
  const directory = mkdtempSync(join(tmpdir(), 'megamono-tooling-artifacts-'));
  try {
    const artifacts = await prepareToolingTestArtifacts(directory);
    const result = spawnSync(
      process.execPath,
      [
        '--test',
        'tools/run-tooling-tests.test.mjs',
        'tools/consumer-npm.test.mjs',
        'tools/magicast-bundle.test.mjs',
        'tools/glob-tooling.test.mjs',
        'tools/minimatch-patch.test.mjs',
        'tools/minimatch-nx-tooling.test.mjs',
        'tools/minimatch-consumer-tooling.test.mjs',
        'tools/deepmerge-tooling-review.test.mjs',
        'tools/tooling-lock.test.mjs',
        'tools/tooling-dependency-inventory.test.mjs',
      ],
      {
        cwd: root,
        env: { ...process.env, ...artifacts },
        stdio: 'inherit',
      },
    );
    if (result.error) throw result.error;
    if (result.signal)
      console.error(`Tooling tests terminated by ${result.signal}.`);
    return result.status ?? 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  process.exitCode = await runToolingTests();
