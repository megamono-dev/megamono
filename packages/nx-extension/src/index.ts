export {
  createNodes,
  createNodesV2,
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
export { verifyExtensionToolchain } from './lib/toolchain';
