import type { Tree } from '@nx/devkit';
import { createContentCollection } from '../content-collection';
import type { ContentLibGeneratorSchema } from './schema';

export async function contentLibGenerator(
  tree: Tree,
  options: ContentLibGeneratorSchema,
): Promise<void> {
  createContentCollection(tree, options.name);
}

export default contentLibGenerator;
