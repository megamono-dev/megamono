import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  checkNextPagesBoundary,
  nextPagesDirectory,
  type NextPagesBoundary,
} from '../lib/next-pages-boundary';
import type { ProjectMetadata } from './project-metadata';

const cache = new Map<
  string,
  { fingerprint: string; analysis: NextPagesBoundary | undefined }
>();

function fingerprint(
  workspaceRoot: string,
  root: string,
  analysis?: NextPagesBoundary,
): string {
  const inputs = new Set<string>(
    [
      ...(analysis?.browserFiles ?? []),
      ...(analysis?.serverFiles ?? []),
    ].filter(existsSync),
  );
  const walk = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (
        entry.isDirectory() &&
        !['node_modules', '.next', 'dist', '.git'].includes(entry.name)
      )
        walk(path);
      else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(path)) inputs.add(path);
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'pages'));
  for (const directory of new Set([root, workspaceRoot])) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /^(?:next\.config\.|tsconfig.*\.json$|package\.json$|(?:middleware|proxy|instrumentation(?:-client)?)\.[jt]s$)/.test(
          entry.name,
        )
      )
        inputs.add(join(directory, entry.name));
    }
  }
  return [...inputs]
    .sort()
    .map((path) => {
      const stat = statSync(path);
      return `${path}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    })
    .join('\n');
}

export function nextPagesLintContext(
  workspaceRoot: string,
  metadata: ProjectMetadata | undefined,
  filename: string,
):
  | {
      readonly analysis: NextPagesBoundary;
      readonly page: boolean;
      readonly serverOnly: boolean;
    }
  | undefined {
  if (!metadata?.tags.includes('platform:web')) return undefined;
  const pages = nextPagesDirectory(metadata.root);
  if (!pages) return undefined;
  let cached = cache.get(metadata.root);
  const stamp = fingerprint(workspaceRoot, metadata.root, cached?.analysis);
  if (!cached || cached.fingerprint !== stamp) {
    cached = {
      fingerprint: stamp,
      analysis: checkNextPagesBoundary(workspaceRoot, metadata.root, {
        nodes: {
          next: {
            name: 'next',
            type: 'app',
            data: {
              root: relative(workspaceRoot, metadata.root),
              tags: [...metadata.tags],
            },
          },
        },
        dependencies: { next: [] },
      }),
    };
    cached.fingerprint = fingerprint(
      workspaceRoot,
      metadata.root,
      cached.analysis,
    );
    cache.set(metadata.root, cached);
  }
  if (!cached.analysis) return undefined;
  const path = resolve(filename);
  const pagePath = relative(pages, path).replaceAll('\\', '/');
  return {
    analysis: cached.analysis,
    page:
      !pagePath.startsWith('..') && !/^(?:api\/|_document\.)/.test(pagePath),
    serverOnly:
      ((cached.analysis.serverFiles.has(path) ||
        (!pagePath.startsWith('..') &&
          /^(?:api\/|_document\.)/.test(pagePath))) &&
        !cached.analysis.browserFiles.has(path)) ||
      /^next\.config\.[cm]?[jt]s$/.test(relative(metadata.root, path)),
  };
}

export function clearNextPagesLintCache(): void {
  cache.clear();
}
