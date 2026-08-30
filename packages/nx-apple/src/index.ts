export {
  collectAppleManifests,
  createDependencies,
  createNodes,
  createNodesV2,
  dependenciesFromAppleManifests,
  getAppleDiagnostics,
  parsePbxLocalPackagePaths,
  parseWorkspaceProjectPaths,
  projectsFromAppleManifests,
} from './lib/apple';
export type {
  AppleDiagnostic,
  AppleManifestRecord,
  AppleNamedTargetOptions,
  ApplePluginOptions,
  ApplePreflightDiagnostic,
  AppleRequiredTool,
  SwiftPackageDump,
  SwiftPackageDumpRunner,
} from './lib/apple';
export { appleApplicationGenerator } from './generators/application/application';
export type { AppleApplicationGeneratorSchema } from './generators/application/schema';
