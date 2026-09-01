export {
  createNodes,
  getExtensionDiagnostics,
  projectsFromWxtConfigs,
} from './lib/extension';
export type {
  ExtensionDiagnostic,
  ExtensionPluginOptions,
  WxtConfigRecord,
} from './lib/extension';
export { extensionApplicationGenerator } from './generators/application/application';
export type { ExtensionApplicationSchema } from './generators/application/schema';
