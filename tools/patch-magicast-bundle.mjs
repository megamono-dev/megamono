#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function installedFile(nodeModules, path) {
  const file = realpathSync(path);
  if (!inside(nodeModules, file) || lstatSync(path).isSymbolicLink()) {
    throw new Error(
      `Refusing an external or symlinked tooling artifact: ${path}`,
    );
  }
  return file;
}

/** Version- and byte-guarded externalization; no package resolution or network mutation. */
export function patchMagicastBundle(workspaceRoot, { check = false } = {}) {
  const root = realpathSync(workspaceRoot);
  const nodeModules = realpathSync(join(root, 'node_modules'));
  if (!inside(root, nodeModules)) {
    throw new Error('Refusing node_modules outside the selected workspace.');
  }
  const packageRoot = installedFile(nodeModules, join(nodeModules, 'magicast'));
  const manifestPath = installedFile(
    nodeModules,
    join(packageRoot, 'package.json'),
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    manifest.name !== provenance.package ||
    manifest.version !== provenance.version
  ) {
    throw new Error(
      `Expected ${provenance.package}@${provenance.version}; review the patch before upgrading.`,
    );
  }
  const require = createRequire(manifestPath);
  const externalManifest = installedFile(
    nodeModules,
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

  const bundlePath = installedFile(
    nodeModules,
    join(packageRoot, provenance.bundle),
  );
  if (!inside(packageRoot, bundlePath)) {
    throw new Error(
      'Refusing a bundle outside the installed Magicast package.',
    );
  }
  const source = readFileSync(bundlePath, 'utf8');
  const digest = sha256(source);
  if (digest === provenance.patchedSha256)
    return { status: 'verified', bundlePath };
  if (digest !== provenance.originalSha256) {
    throw new Error(
      `Unrecognized Magicast bundle SHA256 ${digest}; no files changed.`,
    );
  }
  if (check) {
    throw new Error(
      'Magicast still contains the embedded source-map-js copy; run the patch script.',
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
  const temporaryPath = `${bundlePath}.megamono-${process.pid}.tmp`;
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(temporaryPath, 'wx', lstatSync(bundlePath).mode);
    created = true;
    writeFileSync(descriptor, patched);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, bundlePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) rmSync(temporaryPath, { force: true });
  }
  return { status: 'patched', bundlePath };
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
