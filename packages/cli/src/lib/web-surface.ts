import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Positive project-local evidence only. Never import configuration or infer
 * every project from root-workspace dependencies/command text. */
export async function webSurfaceEvidence(
  workspaceRoot: string,
  projectRoot: string,
  targets: unknown,
): Promise<readonly string[]> {
  const evidence: string[] = [];
  if (targets && typeof targets === 'object' && !Array.isArray(targets)) {
    for (const [name, target] of Object.entries(targets)) {
      if (
        target &&
        typeof target === 'object' &&
        'executor' in target &&
        typeof target.executor === 'string' &&
        ['@nx/next:build', '@nx/next:server'].includes(target.executor)
      ) {
        evidence.push(`Nx target ${name}: ${target.executor}`);
      }
    }
  }
  const entries = await readdir(join(workspaceRoot, projectRoot), {
    withFileTypes: true,
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  );
  for (const config of [
    'next.config.js',
    'next.config.mjs',
    'next.config.ts',
  ]) {
    if (files.has(config)) evidence.push(`${projectRoot}/${config}`);
  }
  const vite = [...files].find((name) =>
    /^vite\.config\.[cm]?[jt]s$/.test(name),
  );
  let nonBrowser = entries.some(
    (entry) =>
      entry.name === 'src-tauri' ||
      /^(?:wxt|electron\.vite)\.config\.[cm]?[jt]s$/.test(entry.name) ||
      /^manifest\.(?:chrome|firefox|edge|safari)\.json$/.test(entry.name),
  );
  if (vite && files.has('manifest.json')) {
    try {
      const manifest: unknown = JSON.parse(
        await readFile(
          join(workspaceRoot, projectRoot, 'manifest.json'),
          'utf8',
        ),
      );
      nonBrowser ||= Boolean(
        manifest &&
        typeof manifest === 'object' &&
        'manifest_version' in manifest,
      );
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // An unparseable manifest cannot establish a browser application.
      nonBrowser = true;
    }
  }
  if (vite && files.has('index.html') && !nonBrowser)
    evidence.push(`${projectRoot}/${vite} + index.html`);
  return evidence.sort();
}
