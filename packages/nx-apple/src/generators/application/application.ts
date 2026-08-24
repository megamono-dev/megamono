import {
  formatFiles,
  names,
  normalizePath,
  updateJson,
  writeJson,
  type Tree,
} from '@nx/devkit';
import type { AppleApplicationGeneratorSchema } from './schema';

interface NormalizedOptions {
  projectName: string;
  moduleName: string;
  appTypeName: string;
  directory: string;
  displayName: string;
  bundleIdentifier: string;
  deploymentTarget: string;
  scope: string;
  tags: string[];
  skipFormat: boolean;
}

const ids = {
  project: 'A00000000000000000000001',
  mainGroup: 'A00000000000000000000002',
  productsGroup: 'A00000000000000000000003',
  appGroup: 'A00000000000000000000004',
  testsGroup: 'A00000000000000000000005',
  frameworksGroup: 'A00000000000000000000006',
  appProduct: 'A00000000000000000000007',
  testsProduct: 'A00000000000000000000008',
  appSource: 'A00000000000000000000009',
  contentSource: 'A0000000000000000000000A',
  testsSource: 'A0000000000000000000000B',
  xctestFramework: 'A0000000000000000000000C',
  appSourceBuild: 'A00000000000000000000010',
  contentSourceBuild: 'A00000000000000000000011',
  testsSourceBuild: 'A00000000000000000000012',
  xctestFrameworkBuild: 'A00000000000000000000013',
  appTarget: 'A00000000000000000000020',
  testsTarget: 'A00000000000000000000021',
  appSources: 'A00000000000000000000030',
  appFrameworks: 'A00000000000000000000031',
  appResources: 'A00000000000000000000032',
  testsSources: 'A00000000000000000000033',
  testsFrameworks: 'A00000000000000000000034',
  testsResources: 'A00000000000000000000035',
  testProxy: 'A00000000000000000000040',
  testDependency: 'A00000000000000000000041',
  projectDebug: 'A00000000000000000000050',
  projectRelease: 'A00000000000000000000051',
  appDebug: 'A00000000000000000000052',
  appRelease: 'A00000000000000000000053',
  testsDebug: 'A00000000000000000000054',
  testsRelease: 'A00000000000000000000055',
  projectConfigurations: 'A00000000000000000000060',
  appConfigurations: 'A00000000000000000000061',
  testsConfigurations: 'A00000000000000000000062',
} as const;

function normalizeOptions(
  tree: Tree,
  options: AppleApplicationGeneratorSchema,
): NormalizedOptions {
  const projectName = names(options.name?.trim() ?? '').fileName;
  if (!projectName || !/^[a-z0-9][a-z0-9-]*$/.test(projectName))
    throw new Error('Apple application name must contain letters or numbers.');
  const directory = normalizePath(options.directory?.trim() || 'apps/apple')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
  if (
    !directory ||
    directory.startsWith('/') ||
    directory.split('/').some((part) => part === '..')
  )
    throw new Error('Apple application directory must be workspace-relative.');
  if (tree.children(directory).length > 0)
    throw new Error(`Apple application directory is not empty: ${directory}.`);

  const moduleName = names(projectName).className;
  const displayName = options.displayName?.trim() || projectName;
  const scope = options.scope?.trim() || 'shared';
  const bundleIdentifier =
    options.bundleIdentifier?.trim() || `com.${projectName}.app`;
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleIdentifier))
    throw new Error(
      'Apple bundle identifier must use reverse-DNS components containing letters, numbers, or hyphens.',
    );
  let deploymentTarget =
    options.deploymentTarget === undefined
      ? '14.0'
      : String(options.deploymentTarget).trim();
  if (/^\d+$/.test(deploymentTarget)) deploymentTarget += '.0';
  if (!/^\d+(?:\.\d+){1,2}$/.test(deploymentTarget))
    throw new Error('Apple deployment target must be a dotted version.');
  const tags = [
    ...new Set(
      (
        options.tags ||
        `platform:apple,scope:${scope},type:app,visibility:internal`
      )
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ].sort();
  return {
    projectName,
    moduleName,
    appTypeName: `${moduleName}App`,
    directory,
    displayName,
    bundleIdentifier,
    deploymentTarget,
    scope,
    tags,
    skipFormat: options.skipFormat ?? false,
  };
}

function pbxString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function renderProject(options: NormalizedOptions): string {
  const {
    projectName,
    moduleName,
    displayName,
    bundleIdentifier,
    deploymentTarget,
  } = options;
  const testsName = `${projectName}Tests`;
  return `// !$*UTF8*$!
{
\tarchiveVersion = 1;
\tclasses = {};
\tobjectVersion = 77;
\tobjects = {

/* Begin PBXBuildFile section */
\t\t${ids.appSourceBuild} /* ${options.appTypeName}.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${ids.appSource} /* ${options.appTypeName}.swift */; };
\t\t${ids.contentSourceBuild} /* ContentView.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${ids.contentSource} /* ContentView.swift */; };
\t\t${ids.testsSourceBuild} /* ${moduleName}Tests.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${ids.testsSource} /* ${moduleName}Tests.swift */; };
\t\t${ids.xctestFrameworkBuild} /* XCTest.framework in Frameworks */ = {isa = PBXBuildFile; fileRef = ${ids.xctestFramework} /* XCTest.framework */; };
/* End PBXBuildFile section */

/* Begin PBXContainerItemProxy section */
\t\t${ids.testProxy} /* PBXContainerItemProxy */ = {
\t\t\tisa = PBXContainerItemProxy;
\t\t\tcontainerPortal = ${ids.project} /* Project object */;
\t\t\tproxyType = 1;
\t\t\tremoteGlobalIDString = ${ids.appTarget};
\t\t\tremoteInfo = ${pbxString(projectName)};
\t\t};
/* End PBXContainerItemProxy section */

/* Begin PBXFileReference section */
\t\t${ids.appProduct} /* ${projectName}.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ${pbxString(`${projectName}.app`)}; sourceTree = BUILT_PRODUCTS_DIR; };
\t\t${ids.testsProduct} /* ${testsName}.xctest */ = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = ${pbxString(`${testsName}.xctest`)}; sourceTree = BUILT_PRODUCTS_DIR; };
\t\t${ids.appSource} /* ${options.appTypeName}.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${options.appTypeName}.swift; sourceTree = "<group>"; };
\t\t${ids.contentSource} /* ContentView.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ContentView.swift; sourceTree = "<group>"; };
\t\t${ids.testsSource} /* ${moduleName}Tests.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ${moduleName}Tests.swift; sourceTree = "<group>"; };
\t\t${ids.xctestFramework} /* XCTest.framework */ = {isa = PBXFileReference; lastKnownFileType = wrapper.framework; name = XCTest.framework; path = System/Library/Frameworks/XCTest.framework; sourceTree = SDKROOT; };
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
\t\t${ids.appFrameworks} /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
\t\t${ids.testsFrameworks} /* Frameworks */ = {
\t\t\tisa = PBXFrameworksBuildPhase;
\t\t\tbuildActionMask = 2147483647;
\t\t\tfiles = (${ids.xctestFrameworkBuild} /* XCTest.framework in Frameworks */,);
\t\t\trunOnlyForDeploymentPostprocessing = 0;
\t\t};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
\t\t${ids.mainGroup} = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (${ids.appGroup} /* App */, ${ids.testsGroup} /* Tests */, ${ids.frameworksGroup} /* Frameworks */, ${ids.productsGroup} /* Products */,);
\t\t\tsourceTree = "<group>";
\t\t};
\t\t${ids.productsGroup} /* Products */ = {isa = PBXGroup; children = (${ids.appProduct} /* ${projectName}.app */, ${ids.testsProduct} /* ${testsName}.xctest */,); name = Products; sourceTree = "<group>"; };
\t\t${ids.appGroup} /* App */ = {isa = PBXGroup; children = (${ids.appSource} /* ${options.appTypeName}.swift */, ${ids.contentSource} /* ContentView.swift */,); path = App; sourceTree = "<group>"; };
\t\t${ids.testsGroup} /* Tests */ = {isa = PBXGroup; children = (${ids.testsSource} /* ${moduleName}Tests.swift */,); path = Tests; sourceTree = "<group>"; };
\t\t${ids.frameworksGroup} /* Frameworks */ = {isa = PBXGroup; children = (${ids.xctestFramework} /* XCTest.framework */,); name = Frameworks; sourceTree = "<group>"; };
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
\t\t${ids.appTarget} /* ${projectName} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${ids.appConfigurations} /* Build configuration list for PBXNativeTarget "${projectName}" */;
\t\t\tbuildPhases = (${ids.appSources} /* Sources */, ${ids.appFrameworks} /* Frameworks */, ${ids.appResources} /* Resources */,);
\t\t\tbuildRules = ();
\t\t\tdependencies = ();
\t\t\tname = ${pbxString(projectName)};
\t\t\tproductName = ${pbxString(projectName)};
\t\t\tproductReference = ${ids.appProduct} /* ${projectName}.app */;
\t\t\tproductType = "com.apple.product-type.application";
\t\t};
\t\t${ids.testsTarget} /* ${testsName} */ = {
\t\t\tisa = PBXNativeTarget;
\t\t\tbuildConfigurationList = ${ids.testsConfigurations} /* Build configuration list for PBXNativeTarget "${testsName}" */;
\t\t\tbuildPhases = (${ids.testsSources} /* Sources */, ${ids.testsFrameworks} /* Frameworks */, ${ids.testsResources} /* Resources */,);
\t\t\tbuildRules = ();
\t\t\tdependencies = (${ids.testDependency} /* PBXTargetDependency */,);
\t\t\tname = ${pbxString(testsName)};
\t\t\tproductName = ${pbxString(testsName)};
\t\t\tproductReference = ${ids.testsProduct} /* ${testsName}.xctest */;
\t\t\tproductType = "com.apple.product-type.bundle.unit-test";
\t\t};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
\t\t${ids.project} /* Project object */ = {
\t\t\tisa = PBXProject;
\t\t\tattributes = {BuildIndependentTargetsInParallel = 1; LastSwiftUpdateCheck = 2660; LastUpgradeCheck = 2660; TargetAttributes = {${ids.appTarget} = {CreatedOnToolsVersion = 26.0; }; ${ids.testsTarget} = {CreatedOnToolsVersion = 26.0; TestTargetID = ${ids.appTarget}; }; }; };
\t\t\tbuildConfigurationList = ${ids.projectConfigurations} /* Build configuration list for PBXProject "${projectName}" */;
\t\t\tcompatibilityVersion = "Xcode 16.0";
\t\t\tdevelopmentRegion = en;
\t\t\thasScannedForEncodings = 0;
\t\t\tknownRegions = (en, Base,);
\t\t\tmainGroup = ${ids.mainGroup};
\t\t\tproductRefGroup = ${ids.productsGroup} /* Products */;
\t\t\tprojectDirPath = "";
\t\t\tprojectRoot = "";
\t\t\ttargets = (${ids.appTarget} /* ${projectName} */, ${ids.testsTarget} /* ${testsName} */,);
\t\t};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
\t\t${ids.appResources} /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
\t\t${ids.testsResources} /* Resources */ = {isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
\t\t${ids.appSources} /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (${ids.appSourceBuild} /* ${options.appTypeName}.swift in Sources */, ${ids.contentSourceBuild} /* ContentView.swift in Sources */,); runOnlyForDeploymentPostprocessing = 0; };
\t\t${ids.testsSources} /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (${ids.testsSourceBuild} /* ${moduleName}Tests.swift in Sources */,); runOnlyForDeploymentPostprocessing = 0; };
/* End PBXSourcesBuildPhase section */

/* Begin PBXTargetDependency section */
\t\t${ids.testDependency} /* PBXTargetDependency */ = {isa = PBXTargetDependency; target = ${ids.appTarget} /* ${projectName} */; targetProxy = ${ids.testProxy} /* PBXContainerItemProxy */; };
/* End PBXTargetDependency section */

/* Begin XCBuildConfiguration section */
\t\t${ids.projectDebug} /* Debug */ = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; DEBUG_INFORMATION_FORMAT = dwarf; ENABLE_TESTABILITY = YES; GCC_C_LANGUAGE_STANDARD = gnu17; GCC_OPTIMIZATION_LEVEL = 0; ONLY_ACTIVE_ARCH = YES; SDKROOT = macosx; SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)"; SWIFT_OPTIMIZATION_LEVEL = "-Onone"; }; name = Debug; };
\t\t${ids.projectRelease} /* Release */ = {isa = XCBuildConfiguration; buildSettings = {ALWAYS_SEARCH_USER_PATHS = NO; CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym"; GCC_C_LANGUAGE_STANDARD = gnu17; SDKROOT = macosx; SWIFT_COMPILATION_MODE = wholemodule; SWIFT_OPTIMIZATION_LEVEL = "-O"; }; name = Release; };
\t\t${ids.appDebug} /* Debug */ = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_STYLE = Automatic; COMBINE_HIDPI_IMAGES = YES; CURRENT_PROJECT_VERSION = 1; ENABLE_HARDENED_RUNTIME = YES; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_CFBundleDisplayName = ${pbxString(displayName)}; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/../Frameworks"; MACOSX_DEPLOYMENT_TARGET = ${deploymentTarget}; MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier}; PRODUCT_MODULE_NAME = ${moduleName}; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_EMIT_LOC_STRINGS = YES; SWIFT_VERSION = 6.0; }; name = Debug; };
\t\t${ids.appRelease} /* Release */ = {isa = XCBuildConfiguration; buildSettings = {CODE_SIGN_STYLE = Automatic; COMBINE_HIDPI_IMAGES = YES; CURRENT_PROJECT_VERSION = 1; ENABLE_HARDENED_RUNTIME = YES; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_CFBundleDisplayName = ${pbxString(displayName)}; LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/../Frameworks"; MACOSX_DEPLOYMENT_TARGET = ${deploymentTarget}; MARKETING_VERSION = 1.0; PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier}; PRODUCT_MODULE_NAME = ${moduleName}; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_EMIT_LOC_STRINGS = YES; SWIFT_VERSION = 6.0; }; name = Release; };
\t\t${ids.testsDebug} /* Debug */ = {isa = XCBuildConfiguration; buildSettings = {BUNDLE_LOADER = "$(TEST_HOST)"; CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = YES; MACOSX_DEPLOYMENT_TARGET = ${deploymentTarget}; PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier}.tests; PRODUCT_MODULE_NAME = ${moduleName}Tests; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_VERSION = 6.0; TEST_HOST = "$(BUILT_PRODUCTS_DIR)/${projectName}.app/Contents/MacOS/${projectName}"; }; name = Debug; };
\t\t${ids.testsRelease} /* Release */ = {isa = XCBuildConfiguration; buildSettings = {BUNDLE_LOADER = "$(TEST_HOST)"; CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = YES; MACOSX_DEPLOYMENT_TARGET = ${deploymentTarget}; PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier}.tests; PRODUCT_MODULE_NAME = ${moduleName}Tests; PRODUCT_NAME = "$(TARGET_NAME)"; SWIFT_VERSION = 6.0; TEST_HOST = "$(BUILT_PRODUCTS_DIR)/${projectName}.app/Contents/MacOS/${projectName}"; }; name = Release; };
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
\t\t${ids.projectConfigurations} /* Build configuration list for PBXProject "${projectName}" */ = {isa = XCConfigurationList; buildConfigurations = (${ids.projectDebug} /* Debug */, ${ids.projectRelease} /* Release */,); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
\t\t${ids.appConfigurations} /* Build configuration list for PBXNativeTarget "${projectName}" */ = {isa = XCConfigurationList; buildConfigurations = (${ids.appDebug} /* Debug */, ${ids.appRelease} /* Release */,); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
\t\t${ids.testsConfigurations} /* Build configuration list for PBXNativeTarget "${testsName}" */ = {isa = XCConfigurationList; buildConfigurations = (${ids.testsDebug} /* Debug */, ${ids.testsRelease} /* Release */,); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
/* End XCConfigurationList section */
\t};
\trootObject = ${ids.project} /* Project object */;
}
`;
}

function renderScheme(options: NormalizedOptions): string {
  const projectName = options.projectName;
  const testsName = `${projectName}Tests`;
  const container = `container:${projectName}.xcodeproj`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2660" version="1.7">
   <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
            <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ids.appTarget}" BuildableName="${projectName}.app" BlueprintName="${projectName}" ReferencedContainer="${container}"></BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES">
      <Testables>
         <TestableReference skipped="NO" parallelizable="YES">
            <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ids.testsTarget}" BuildableName="${testsName}.xctest" BlueprintName="${testsName}" ReferencedContainer="${container}"></BuildableReference>
         </TestableReference>
      </Testables>
      <MacroExpansion>
         <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ids.appTarget}" BuildableName="${projectName}.app" BlueprintName="${projectName}" ReferencedContainer="${container}"></BuildableReference>
      </MacroExpansion>
   </TestAction>
   <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES">
      <BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ids.appTarget}" BuildableName="${projectName}.app" BlueprintName="${projectName}" ReferencedContainer="${container}"></BuildableReference></BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES">
      <BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ids.appTarget}" BuildableName="${projectName}.app" BlueprintName="${projectName}" ReferencedContainer="${container}"></BuildableReference></BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction buildConfiguration="Debug"></AnalyzeAction>
   <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"></ArchiveAction>
</Scheme>
`;
}

function registerPlugin(tree: Tree, scope: string): void {
  updateJson(tree, 'nx.json', (nxJson: Record<string, unknown>) => {
    const plugins = Array.isArray(nxJson.plugins) ? [...nxJson.plugins] : [];
    const index = plugins.findIndex(
      (entry) =>
        entry === '@megamono/nx-apple' ||
        (typeof entry === 'object' &&
          entry !== null &&
          (entry as { plugin?: unknown }).plugin === '@megamono/nx-apple'),
    );
    const plugin = { plugin: '@megamono/nx-apple', options: { scope } };
    if (index === -1) plugins.push(plugin);
    else plugins[index] = plugin;
    return { ...nxJson, plugins };
  });
}

export async function appleApplicationGenerator(
  tree: Tree,
  schema: AppleApplicationGeneratorSchema,
): Promise<void> {
  if (!tree.exists('nx.json'))
    throw new Error('nx.json is required before generating an Apple app.');
  const options = normalizeOptions(tree, schema);
  const projectRoot = options.directory;
  tree.write(
    `${projectRoot}/${options.projectName}.xcodeproj/project.pbxproj`,
    renderProject(options),
  );
  tree.write(
    `${projectRoot}/${options.projectName}.xcodeproj/xcshareddata/xcschemes/${options.projectName}.xcscheme`,
    renderScheme(options),
  );
  tree.write(
    `${projectRoot}/App/${options.appTypeName}.swift`,
    `import SwiftUI\n\n@main\nstruct ${options.appTypeName}: App {\n    var body: some Scene {\n        WindowGroup {\n            ContentView()\n        }\n    }\n}\n`,
  );
  tree.write(
    `${projectRoot}/App/ContentView.swift`,
    `import SwiftUI\n\nenum AppFeature {\n    static let title = ${JSON.stringify(options.displayName)}\n}\n\nstruct ContentView: View {\n    var body: some View {\n        VStack(spacing: 12) {\n            Image(systemName: "shippingbox")\n                .font(.system(size: 48))\n            Text(AppFeature.title)\n                .font(.title)\n        }\n        .padding(32)\n        .frame(minWidth: 420, minHeight: 280)\n    }\n}\n`,
  );
  tree.write(
    `${projectRoot}/Tests/${options.moduleName}Tests.swift`,
    `import XCTest\n@testable import ${options.moduleName}\n\nfinal class ${options.moduleName}Tests: XCTestCase {\n    func testApplicationTitleIsConfigured() {\n        XCTAssertFalse(AppFeature.title.isEmpty)\n    }\n}\n`,
  );
  writeJson(tree, `${projectRoot}/project.json`, {
    name: options.projectName,
    projectType: 'application',
    sourceRoot: `${projectRoot}/App`,
    tags: options.tags,
  });
  registerPlugin(tree, options.scope);
  if (!options.skipFormat) await formatFiles(tree);
}

export default appleApplicationGenerator;
