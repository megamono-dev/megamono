import type { Tree } from '@nx/devkit';

/** Manifest evidence only; dependencies alone do not make a project a plugin. */
export function extensionEvidence(
  tree: Tree,
  root: string,
): {
  framework: 'wxt' | 'browser-extension' | 'figma';
  path: string;
}[] {
  const result: ReturnType<typeof extensionEvidence> = [];
  for (const name of [
    'wxt.config.ts',
    'wxt.config.js',
    'wxt.config.mjs',
    'wxt.config.mts',
  ]) {
    const path = `${root}/${name}`;
    if (tree.exists(path)) result.push({ framework: 'wxt', path });
  }
  let configured: unknown;
  try {
    configured = JSON.parse(tree.read(`${root}/package.json`, 'utf8') ?? '{}')
      ?.megamono?.extension?.manifests;
  } catch {
    /* Invalid package metadata is not positive evidence. */
  }
  const safeConfigured = Array.isArray(configured)
    ? configured.filter(
        (name): name is string =>
          typeof name === 'string' &&
          name.endsWith('.json') &&
          !name.includes('\\') &&
          !name
            .split('/')
            .some((part) =>
              [
                '',
                '.',
                '..',
                'node_modules',
                '.yalc',
                'dist',
                'build',
                '.output',
                'generated',
                '.git',
              ].includes(part),
            ),
      )
    : [];
  for (const name of new Set([
    ...['', 'public/', 'src/'].flatMap((prefix) =>
      ['manifest.json', 'manifest.chrome.json', 'manifest.firefox.json'].map(
        (name) => `${prefix}${name}`,
      ),
    ),
    ...safeConfigured,
  ])) {
    const path = `${root}/${name}`;
    try {
      const manifest = JSON.parse(tree.read(path, 'utf8') ?? '{}');
      if (!manifest || typeof manifest !== 'object') continue;
      if (
        [2, 3].includes(manifest.manifest_version) &&
        typeof manifest.name === 'string'
      ) {
        result.push({ framework: 'browser-extension', path });
      } else if (
        typeof manifest.main === 'string' &&
        typeof manifest.api === 'string' &&
        Array.isArray(manifest.editorType) &&
        manifest.editorType.includes('figma')
      ) {
        result.push({ framework: 'figma', path });
      }
    } catch {
      // Unrelated or malformed JSON isn't positive platform evidence.
    }
  }
  return result;
}
