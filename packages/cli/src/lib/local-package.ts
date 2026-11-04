import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

/** Resolve installed metadata without loading package code or ambient NODE_PATH packages. */
export function localPackageManifest(root: string, name: string): string {
  const localSearches = new Set<string>();
  let directory = resolve(root);
  while (true) {
    localSearches.add(join(directory, 'node_modules'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const resolver = createRequire(join(resolve(root), 'package.json'));
  for (const search of resolver.resolve.paths(name) ?? []) {
    if (!localSearches.has(resolve(search))) continue;
    const manifest = join(search, name, 'package.json');
    if (existsSync(manifest)) return realpathSync(manifest);
  }
  const error = new Error(
    `No workspace-local ${name} package resolves from ${root}.`,
  ) as NodeJS.ErrnoException;
  error.code = 'MODULE_NOT_FOUND';
  throw error;
}
