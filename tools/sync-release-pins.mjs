import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const compatibilityFiles = [
  'packages/plugin/compatibility.json',
  'packages/create-megamono/compatibility.json',
];

export async function syncReleasePins(root, check = false) {
  const canonicalFile = compatibilityFiles[0];
  const originals = await Promise.all(
    compatibilityFiles.map((file) => readFile(join(root, file), 'utf8')),
  );
  const registry = JSON.parse(originals[0]);
  let updated = originals[0];
  for (const [name, pin] of Object.entries(registry.scaffoldPackages)) {
    if (!name.startsWith('@megamono/')) continue;
    const manifest = JSON.parse(
      await readFile(
        join(root, 'packages', name.slice('@megamono/'.length), 'package.json'),
        'utf8',
      ),
    );
    if (manifest.name !== name || typeof manifest.version !== 'string')
      throw new Error(`Invalid release manifest for ${name}`);
    if (pin === manifest.version) continue;
    if (check)
      throw new Error(
        `${canonicalFile}: ${name} pin ${pin} differs from release ${manifest.version}`,
      );
    // Preserve formatting and the independent compatibility ranges elsewhere.
    updated = updated.replace(
      `"${name}": ${JSON.stringify(pin)}`,
      `"${name}": ${JSON.stringify(manifest.version)}`,
    );
  }
  // The bootstrap package ships the complete plugin-owned registry, including
  // SDK metadata. Updating only version pins would leave new sections behind.
  for (const [index, file] of compatibilityFiles.entries()) {
    if (originals[index] === updated) continue;
    if (check)
      throw new Error(
        `${file}: compatibility registry differs from canonical ${canonicalFile}; run node tools/sync-release-pins.mjs`,
      );
    await writeFile(join(root, file), updated);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await syncReleasePins(
    dirname(dirname(fileURLToPath(import.meta.url))),
    process.argv.includes('--check'),
  );
}
