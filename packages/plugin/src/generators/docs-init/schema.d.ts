import type { WorkspaceInitGeneratorSchema } from '../workspace-init/schema';

export type DocsInitGeneratorSchema = Omit<
  WorkspaceInitGeneratorSchema,
  'only' | 'defaultPlatform'
>;
