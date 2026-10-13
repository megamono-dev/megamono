import { readFile } from 'node:fs/promises';

// Packed fixtures must follow the artifacts being qualified, including prereleases.
export async function packageVersion(name) {
  if (!/^(@megamono\/[a-z-]+|create-megamono)$/.test(name))
    throw new Error(`Unexpected release package: ${name}`);
  const directory = name.replace('@megamono/', '');
  const manifest = JSON.parse(
    await readFile(
      new URL(`../packages/${directory}/package.json`, import.meta.url),
      'utf8',
    ),
  );
  if (manifest.name !== name || typeof manifest.version !== 'string')
    throw new Error(`Invalid release package manifest: ${name}`);
  return manifest.version;
}
