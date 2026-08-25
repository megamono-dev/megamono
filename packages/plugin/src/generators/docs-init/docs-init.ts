import type { GeneratorCallback, Tree } from '@nx/devkit';
import { workspaceInitGenerator } from '../workspace-init/workspace-init';
import type { DocsInitGeneratorSchema } from './schema';

export async function docsInitGenerator(
  tree: Tree,
  options: DocsInitGeneratorSchema,
): Promise<GeneratorCallback> {
  return workspaceInitGenerator(tree, {
    ...options,
    only: 'docs,agents,skills',
  });
}

export default docsInitGenerator;
