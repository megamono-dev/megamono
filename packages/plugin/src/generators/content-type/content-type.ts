import type { Tree } from '@nx/devkit';
import { addContentType, findContentCollection } from '../content-collection';
import type { ContentTypeGeneratorSchema } from './schema';

export async function contentTypeGenerator(
  tree: Tree,
  options: ContentTypeGeneratorSchema,
): Promise<void> {
  addContentType(tree, findContentCollection(tree, options.collection), options.name);
}

export default contentTypeGenerator;
