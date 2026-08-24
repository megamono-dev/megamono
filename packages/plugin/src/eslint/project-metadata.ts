import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface ProjectMetadata {
  readonly root: string;
  readonly tags: readonly string[];
}

interface ProjectMarker {
  readonly tags?: readonly string[];
  readonly nx?: { readonly tags?: readonly string[] };
}

const cache = new Map<string, ProjectMetadata | null>();

function readMarker(path: string): ProjectMarker | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProjectMarker;
  } catch {
    return undefined;
  }
}

export function findProjectMetadata(
  filePath: string,
  workspaceRoot: string,
): ProjectMetadata | undefined {
  let directory = dirname(resolve(filePath));
  const root = resolve(workspaceRoot);
  const visited: string[] = [];
  while (directory === root || directory.startsWith(`${root}/`)) {
    const cached = cache.get(directory);
    if (cached !== undefined) {
      for (const path of visited) cache.set(path, cached);
      return cached ?? undefined;
    }
    visited.push(directory);
    const project = readMarker(resolve(directory, 'project.json'));
    const manifest = readMarker(resolve(directory, 'package.json'));
    const tags = project?.tags ?? manifest?.nx?.tags;
    if (tags) {
      const metadata = { root: directory, tags };
      for (const path of visited) cache.set(path, metadata);
      return metadata;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  for (const path of visited) cache.set(path, null);
  return undefined;
}

export function projectPlatform(
  metadata: ProjectMetadata | undefined,
): string | undefined {
  return metadata?.tags
    .find((tag) => tag.startsWith('platform:'))
    ?.slice('platform:'.length);
}

export function clearProjectMetadataCache(): void {
  cache.clear();
}
