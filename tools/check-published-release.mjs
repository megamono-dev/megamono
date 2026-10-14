import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const registry = 'https://registry.npmjs.org';
const directories = [
  'cli',
  'plugin',
  'nx-apple',
  'nx-cargo',
  'nx-cloudflare',
  'nx-extension',
  'nx-render',
  'nx-laravel',
  'nx-phpnative',
  'create-megamono',
];

function targets(value) {
  if (typeof value === 'string') return [value.replace(/^\.\//, '')];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(targets);
}

export function validatePublishedPackage({
  manifest,
  published,
  distTags,
  channel,
  revision,
  files,
}) {
  const fail = (message) => {
    throw new Error(`${manifest.name}: ${message}`);
  };
  if (
    published?.name !== manifest.name ||
    published?.version !== manifest.version
  )
    fail(`expected published version ${manifest.version}`);
  if (published.gitHead !== revision)
    fail('published gitHead does not match the release commit');
  if (distTags?.[channel] !== manifest.version)
    fail(`${channel} does not point to ${manifest.version}`);
  if (channel === 'next' && distTags?.latest === manifest.version)
    fail('the next prerelease must not be assigned to latest');
  if (files) {
    for (const target of new Set(
      [manifest, published].flatMap((value) => [
        ...targets(value.exports),
        ...targets(value.main),
        ...targets(value.module),
        ...targets(value.types),
        ...targets(value.bin),
        ...targets(value.generators),
        ...targets(value.executors),
      ]),
    )) {
      if (!target.includes('*') && !files.has(target))
        fail(`published tarball is missing ${target}`);
    }
  }
}

async function publishedMetadata(manifest, channel, revision) {
  const deadline = Date.now() + 120_000;
  let failure;
  do {
    try {
      const response = await fetch(
        `${registry}/${encodeURIComponent(manifest.name)}`,
        {
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok)
        throw new Error(
          `${manifest.name}: registry returned ${response.status}`,
        );
      const packument = await response.json();
      const published = packument.versions?.[manifest.version];
      const distTags = packument['dist-tags'];
      validatePublishedPackage({
        manifest,
        published,
        distTags,
        channel,
        revision,
      });
      return { published, distTags };
    } catch (error) {
      failure = error;
    }
    if (Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5_000));
  } while (Date.now() < deadline);
  throw failure;
}

async function main() {
  const channel = process.env.RELEASE_CHANNEL ?? 'next';
  if (!['next', 'latest'].includes(channel))
    throw new Error('RELEASE_CHANNEL must be next or latest.');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const manifests = await Promise.all(
    directories.map(async (directory) =>
      JSON.parse(
        await readFile(
          join(root, 'packages', directory, 'package.json'),
          'utf8',
        ),
      ),
    ),
  );
  // Give registry metadata and dist-tags a bounded propagation window.
  const metadata = await Promise.all(
    manifests.map((manifest) => publishedMetadata(manifest, channel, revision)),
  );
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'megamono-published-release-'),
  );
  const npmConfig = join(temporaryRoot, 'npmrc');
  await writeFile(
    npmConfig,
    `registry=${registry}/\n@megamono:registry=${registry}/\n`,
  );
  const environment = {
    ...process.env,
    npm_config_userconfig: npmConfig,
    npm_config_cache: join(temporaryRoot, 'cache'),
  };
  try {
    for (const [index, manifest] of manifests.entries()) {
      const output = execFileSync(
        'npm',
        [
          'pack',
          `${manifest.name}@${manifest.version}`,
          '--json',
          '--ignore-scripts',
          '--pack-destination',
          temporaryRoot,
          '--registry',
          registry,
        ],
        {
          cwd: temporaryRoot,
          env: environment,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      const report = JSON.parse(output)[0];
      if (
        report?.name !== manifest.name ||
        report?.version !== manifest.version ||
        !Array.isArray(report.files)
      )
        throw new Error(
          `${manifest.name}: npm pack did not return the expected registry artifact`,
        );
      validatePublishedPackage({
        manifest,
        ...metadata[index],
        channel,
        revision,
        files: new Set(report.files.map(({ path }) => path)),
      });
      console.log(
        `Published metadata and tarball exports passed: ${manifest.name}@${manifest.version}`,
      );
    }
    const matrix = (extraEnvironment) =>
      execFileSync(
        'npm',
        [
          'exec',
          'nx',
          '--',
          'run',
          'create-megamono:e2e-selection-matrix-local-registry',
          '--excludeTaskDependencies',
          '--skip-nx-cache',
          '--output-style=stream',
        ],
        {
          cwd: root,
          stdio: 'inherit',
          env: {
            ...environment,
            MEGAMONO_MATRIX_REGISTRY: registry,
            MEGAMONO_MATRIX_CASES: '',
            MEGAMONO_MATRIX_VERIFY: 'config',
            ...extraEnvironment,
          },
        },
      );
    // Every next release is evaluated using the exact packages from public npm.
    // Stable promotion already requires that successful prerelease evaluation.
    if (channel === 'next') {
      execFileSync('npm', ['run', 'release:qualify'], {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...environment,
          MEGAMONO_QUALIFY_PHASE: 'consumers',
          MEGAMONO_MATRIX_REGISTRY: registry,
          MEGAMONO_MATRIX_CASES: '',
          MEGAMONO_MATRIX_VERIFY: 'config',
        },
      });
    } else {
      matrix({ MEGAMONO_MATRIX_CASES: 'api,web-npm' });
    }
    console.log(
      `Published ${channel} verification passed for all ${manifests.length} packages.`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
