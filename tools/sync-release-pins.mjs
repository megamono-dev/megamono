import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const compatibilityFiles = [
  'packages/plugin/compatibility.json',
  'packages/create-megamono/compatibility.json',
];

export async function syncReleasePins(root, check = false) {
  for (const file of compatibilityFiles) {
    const original = await readFile(join(root, file), 'utf8');
    const registry = JSON.parse(original);
    let updated = original;
    for (const [name, pin] of Object.entries(registry.scaffoldPackages)) {
      if (!name.startsWith('@megamono/')) continue;
      const manifest = JSON.parse(
        await readFile(
          join(
            root,
            'packages',
            name.slice('@megamono/'.length),
            'package.json',
          ),
          'utf8',
        ),
      );
      if (manifest.name !== name || typeof manifest.version !== 'string')
        throw new Error(`Invalid release manifest for ${name}`);
      if (pin === manifest.version) continue;
      if (check)
        throw new Error(
          `${file}: ${name} pin ${pin} differs from release ${manifest.version}`,
        );
      // Preserve formatting and the independent compatibility ranges elsewhere.
      updated = updated.replace(
        `"${name}": ${JSON.stringify(pin)}`,
        `"${name}": ${JSON.stringify(manifest.version)}`,
      );
    }
    if (updated !== original) await writeFile(join(root, file), updated);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await syncReleasePins(
    dirname(dirname(fileURLToPath(import.meta.url))),
    process.argv.includes('--check'),
  );
}
