#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createToolingLayout, verifyToolingLock } from './tooling-lock.mjs';

const toolDirectory = dirname(fileURLToPath(import.meta.url));
export const provenance = JSON.parse(
  readFileSync(join(toolDirectory, 'magicast-bundle.provenance.json'), 'utf8'),
);

const embeddedStart =
  '//#region node_modules/.pnpm/source-map-js@1.2.1/node_modules/source-map-js/lib/base64.js';
const embeddedEnd = '//#region vendor/recast/lib/util.ts';
const namespaceShim = `var import_source_map = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports) => {
\texports.SourceMapGenerator = require_source_map_generator().SourceMapGenerator;
\texports.SourceMapConsumer = require_source_map_consumer().SourceMapConsumer;
\texports.SourceNode = require_source_node().SourceNode;
})))());
`;
const externalImport =
  '// Megamono: externalized source-map-js; see tools/magicast-bundle.provenance.json.\n' +
  'import * as import_source_map from "source-map-js";\n';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

function planMagicastBundle(layout, packageRoot) {
  const manifestPath = layout.artifact(join(packageRoot, 'package.json'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    manifest.name !== provenance.package ||
    manifest.version !== provenance.version
  ) {
    throw new Error(
      `Expected ${provenance.package}@${provenance.version}; review the patch before upgrading.`,
    );
  }
  verifyToolingLock(layout.lock, manifestPath, {
    name: provenance.package,
    version: provenance.version,
    tarballIntegrity: provenance.tarballIntegrity,
  });
  const require = createRequire(manifestPath);
  const externalManifest = layout.artifact(
    require.resolve(`${provenance.externalPackage}/package.json`),
  );
  const external = JSON.parse(readFileSync(externalManifest, 'utf8'));
  if (
    external.name !== provenance.externalPackage ||
    external.version !== provenance.externalVersion
  ) {
    throw new Error(
      `Expected resolved ${provenance.externalPackage}@${provenance.externalVersion}.`,
    );
  }

  verifyToolingLock(layout.lock, externalManifest, {
    name: provenance.externalPackage,
    version: provenance.externalVersion,
    tarballIntegrity: provenance.externalTarballIntegrity,
  });
  const bundlePath = layout.artifact(join(packageRoot, provenance.bundle));
  if (!inside(packageRoot, bundlePath)) {
    throw new Error(
      'Refusing a bundle outside the installed Magicast package.',
    );
  }
  const source = readFileSync(bundlePath, 'utf8');
  const digest = sha256(source);
  if (digest === provenance.patchedSha256) return undefined;
  if (digest !== provenance.originalSha256) {
    throw new Error(
      `Unrecognized Magicast bundle SHA256 ${digest}; no files changed.`,
    );
  }
  const start = source.indexOf(embeddedStart);
  const end = source.indexOf(embeddedEnd, start);
  if (
    start < 0 ||
    end < 0 ||
    source.indexOf(embeddedStart, start + embeddedStart.length) !== -1 ||
    source.split(namespaceShim).length !== 2 ||
    end - start !== provenance.removedEmbeddedBytes
  ) {
    throw new Error(
      'Unexpected Magicast embedded-module boundaries; no files changed.',
    );
  }
  const patched =
    externalImport +
    source.slice(0, start) +
    source.slice(end).replace(namespaceShim, '');
  if (sha256(patched) !== provenance.patchedSha256) {
    throw new Error(
      'Magicast transformation did not produce the reviewed artifact; no files changed.',
    );
  }
  return { path: bundlePath, source, patched };
}

/** Version-, integrity-, and byte-guarded migration of every physical copy. */
export function patchMagicastBundle(workspaceRoot, { check = false } = {}) {
  const layout = createToolingLayout(workspaceRoot);
  const roots = layout.packageRoots(provenance.package);
  if (!roots.length)
    throw new Error('Missing reviewed Magicast tooling package.');
  const plans = roots
    .map((root) => planMagicastBundle(layout, root))
    .filter(Boolean);
  if (check && plans.length)
    throw new Error(
      'Magicast still contains the embedded source-map-js copy; run the patch script.',
    );
  const staged = [];
  try {
    for (const plan of plans) {
      const temporaryPath = `${plan.path}.megamono-${process.pid}.tmp`;
      const descriptor = openSync(
        temporaryPath,
        'wx',
        lstatSync(plan.path).mode,
      );
      staged.push({ ...plan, temporaryPath });
      try {
        writeFileSync(descriptor, plan.patched);
      } finally {
        closeSync(descriptor);
      }
    }
    for (const plan of staged)
      if (readFileSync(layout.artifact(plan.path), 'utf8') !== plan.source)
        throw new Error(`Tooling artifact changed while staging: ${plan.path}`);
    for (const plan of staged) renameSync(plan.temporaryPath, plan.path);
  } finally {
    for (const plan of staged) rmSync(plan.temporaryPath, { force: true });
  }
  return {
    status: plans.length ? 'patched' : 'verified',
    bundlePath: join(roots[0], provenance.bundle),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--check') || args.length > 1) {
      throw new Error('Usage: node tools/patch-magicast-bundle.mjs [--check]');
    }
    const result = patchMagicastBundle(dirname(toolDirectory), {
      check: args.includes('--check'),
    });
    console.log(
      `Magicast ${provenance.version}: ${result.status} external source-map-js ${provenance.externalVersion}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
