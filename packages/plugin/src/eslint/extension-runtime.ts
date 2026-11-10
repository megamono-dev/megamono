import {
  readCachedProjectGraph,
  workspaceRoot as nxWorkspaceRoot,
  type ProjectGraph,
} from '@nx/devkit';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkExtensionRuntimeBoundary } from '../lib/extension-runtime';
import type { ProjectMetadata } from './project-metadata';

/** Use the same policy and disk facts as structural checking, including unsaved text. */
export function extensionRuntimeLintContext(
  workspaceRoot: string,
  metadata: ProjectMetadata | undefined,
  filename: string,
  text: string,
  docsRoot?: string,
) {
  if (!metadata?.tags.includes('platform:extension')) return undefined;
  try {
    const manifest = JSON.parse(
      readFileSync(join(metadata.root, 'package.json'), 'utf8'),
    );
    if (manifest.megamono?.extension?.runtimeEntries === undefined)
      return undefined;
  } catch {
    return undefined; /* No valid manifest can authorize a runtime exemption. */
  }
  let graph: ProjectGraph | undefined;
  try {
    if (resolve(workspaceRoot) === resolve(nxWorkspaceRoot))
      graph = readCachedProjectGraph();
  } catch {
    /* Direct ESLint can still verify locally resolved source imports. */
  }
  if (!docsRoot && existsSync(join(workspaceRoot, 'megamono.json'))) {
    try {
      const config = JSON.parse(
        readFileSync(join(workspaceRoot, 'megamono.json'), 'utf8'),
      );
      if (typeof config.docs?.root === 'string') docsRoot = config.docs.root;
    } catch {
      /* Unreadable config cannot invent a different decision authority. */
    }
  }
  return checkExtensionRuntimeBoundary(
    workspaceRoot,
    metadata.root,
    graph,
    docsRoot ?? 'docs',
    { filename, text },
  );
}
