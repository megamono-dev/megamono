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
  ApplePluginOptions,
  ApplePreflightDiagnostic,
  AppleRequiredTool,
  SwiftPackageDump,
  SwiftPackageDumpRunner,
} from './lib/apple';
