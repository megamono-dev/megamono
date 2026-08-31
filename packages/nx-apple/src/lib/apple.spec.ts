import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DependencyType, type ProjectConfiguration } from '@nx/devkit';
import {
  collectAppleManifests,
  createNodes,
  dependenciesFromAppleManifests,
  parsePbxLocalPackagePaths,
  parseWorkspaceProjectPaths,
  projectsFromAppleManifests,
  type AppleManifestRecord,
  type SwiftPackageDumpRunner,
} from './apple';

describe('Apple createNodes compatibility', () => {
  it('adapts the Nx 18/19 single-file createNodes contract', async () => {
    const workspaceRoot = await mkdtemp(resolve(tmpdir(), 'nx-apple-v1-node-'));
    const singleFileCallback = createNodes[1] as unknown as (
      configFile: string,
      options: Record<string, never>,
      context: { workspaceRoot: string },
    ) => Promise<{ projects: Record<string, ProjectConfiguration> }>;

    const result = await singleFileCallback(
      'missing/Package.swift',
      {},
      {
        workspaceRoot,
      },
    );

    expect(Array.isArray(result)).toBe(false);
    expect(result.projects.missing).toMatchObject({
      name: 'missing',
      root: 'missing',
      projectType: 'library',
    });
  });

  it('ignores an Xcode project internal workspace under the single-file contract', async () => {
    const workspaceRoot = await mkdtemp(
      resolve(tmpdir(), 'nx-apple-v1-internal-workspace-'),
    );
    const manifest =
      'apps/Quickzones/Quickzones.xcodeproj/project.xcworkspace/contents.xcworkspacedata';
    await mkdir(resolve(workspaceRoot, manifest, '..'), { recursive: true });
    await writeFile(
      resolve(workspaceRoot, manifest),
      '<Workspace version="1.0" />',
    );
    const singleFileCallback = createNodes[1] as unknown as (
      configFile: string,
      options: Record<string, never>,
      context: { workspaceRoot: string },
    ) => Promise<{ projects: Record<string, ProjectConfiguration> }>;

    await expect(
      singleFileCallback(manifest, {}, { workspaceRoot }),
    ).resolves.toEqual({ projects: {} });
  });
});

describe('Apple manifest parsers', () => {
  it('parses quoted and unquoted local Swift package references', () => {
    const source = `
/* Begin XCLocalSwiftPackageReference section */
  A = { isa = XCLocalSwiftPackageReference; relativePath = ../SynthKit; };
  B = { isa = XCLocalSwiftPackageReference; relativePath = "../Shared Packages/Core"; };
/* End XCLocalSwiftPackageReference section */
`;
    expect(parsePbxLocalPackagePaths(source)).toEqual([
      '../Shared Packages/Core',
      '../SynthKit',
    ]);
  });

  it('parses only Xcode project references from workspace XML', () => {
    expect(
      parseWorkspaceProjectPaths(`
<Workspace version="1.0">
  <FileRef location="group:Apps/Synth.xcodeproj" />
  <FileRef location="container:Apps/Lens.xcodeproj" />
  <FileRef location="group:README.md" />
</Workspace>
`),
    ).toEqual(['Apps/Lens.xcodeproj', 'Apps/Synth.xcodeproj']);
  });
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'nx-apple-'));
  await Promise.all([
    mkdir(resolve(root, 'Apps/Portfolio.xcworkspace'), { recursive: true }),
    mkdir(resolve(root, 'Apps/Portfolio.xcworkspace/xcshareddata/xcschemes'), {
      recursive: true,
    }),
    mkdir(resolve(root, 'Apps/Portfolio.xcodeproj'), { recursive: true }),
    mkdir(
      resolve(root, 'Apps/Portfolio.xcodeproj/project.xcworkspace'),
      { recursive: true },
    ),
    mkdir(resolve(root, 'Apps/Synth/Synth.xcodeproj'), { recursive: true }),
    mkdir(resolve(root, 'Packages/Core'), { recursive: true }),
  ]);
  await writeFile(resolve(root, 'Apps/Package.swift'), '// aggregate package');
  await writeFile(
    resolve(root, 'Apps/Portfolio.xcworkspace/contents.xcworkspacedata'),
    '<Workspace><FileRef location="group:Synth/Synth.xcodeproj" /></Workspace>',
  );
  await writeFile(
    resolve(
      root,
      'Apps/Portfolio.xcworkspace/xcshareddata/xcschemes/Portfolio.xcscheme',
    ),
    '<Scheme />',
  );
  await writeFile(
    resolve(root, 'Apps/Portfolio.xcodeproj/project.pbxproj'),
    'isa = PBXProject;',
  );
  await writeFile(
    resolve(
      root,
      'Apps/Portfolio.xcodeproj/project.xcworkspace/contents.xcworkspacedata',
    ),
    '<Workspace version="1.0" />',
  );
  await writeFile(
    resolve(root, 'Apps/Synth/Synth.xcodeproj/project.pbxproj'),
    `isa = PBXProject;
/* Begin XCLocalSwiftPackageReference section */
  A = { isa = XCLocalSwiftPackageReference; relativePath = ../../Packages/Core; };
/* End XCLocalSwiftPackageReference section */`,
  );
  await writeFile(resolve(root, 'Packages/Core/Package.swift'), '// core');
  const runner: SwiftPackageDumpRunner = async (packageRoot) => ({
    name: packageRoot.endsWith('/Apps') ? 'AppsPackage' : 'Core',
    dependencies: [],
    targets: [
      {
        name: packageRoot.endsWith('/Apps') ? 'Apps' : 'Core',
        type: packageRoot.endsWith('/Apps') ? 'executable' : 'regular',
      },
    ],
  });
  return { root, runner };
}

describe('collectAppleManifests', () => {
  it('applies workspace then project then package precedence per directory', async () => {
    const { root, runner } = await fixture();
    const collected = await collectAppleManifests(
      [
        'Apps/Package.swift',
        'Apps/Portfolio.xcodeproj/project.pbxproj',
        'Apps/Portfolio.xcodeproj/project.xcworkspace/contents.xcworkspacedata',
        'Apps/Portfolio.xcworkspace/contents.xcworkspacedata',
        'Apps/Synth/Synth.xcodeproj/project.pbxproj',
        'Packages/Core/Package.swift',
      ],
      root,
      runner,
    );
    expect(
      collected.records
        .filter(({ selected }) => selected)
        .map(({ kind, root: projectRoot }) => [projectRoot, kind]),
    ).toEqual([
      ['Apps', 'workspace'],
      ['Apps/Synth', 'project'],
      ['Packages/Core', 'package'],
    ]);
    expect(collected.diagnostics).toEqual([]);
    expect(collected.records.map(({ name }) => name)).not.toContain('project');
    expect(
      collected.records.find(({ kind }) => kind === 'workspace')?.schemes,
    ).toEqual(['Portfolio']);
  });

  it('retains a package node and diagnostic when Swift is unavailable', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'nx-apple-missing-swift-'));
    await writeFile(resolve(root, 'Package.swift'), '// package');
    const collected = await collectAppleManifests(
      ['Package.swift'],
      root,
      async () => {
        throw new Error('spawn swift ENOENT');
      },
    );
    expect(collected.records[0]).toMatchObject({
      root: '.',
      kind: 'package',
      selected: true,
    });
    expect(collected.diagnostics[0].message).toContain('spawn swift ENOENT');
  });
});

describe('projects and dependencies', () => {
  it('omits ambiguous Xcode targets without a scheme and emits them when configured', () => {
    const record: AppleManifestRecord = {
      manifest: 'apps/Synth/Synth.xcodeproj/project.pbxproj',
      root: 'apps/Synth',
      kind: 'project',
      name: 'Synth',
      localPaths: [],
      application: true,
      schemes: ['Synth', 'Synth Debug'],
      swiftLint: true,
      selected: true,
    };
    const [[, withoutScheme]] = projectsFromAppleManifests(
      [record],
      '/workspace',
    );
    expect(
      Object.keys(withoutScheme.projects['apps/Synth'].targets ?? {}),
    ).toEqual(['lint']);
    const [[, configured]] = projectsFromAppleManifests(
      [record],
      '/workspace',
      {
        scheme: 'Synth',
        destination: 'platform=iOS Simulator,name=iPhone 17',
        fastlaneLane: 'beta',
        fastlanePlatform: 'ios',
      },
    );
    expect(
      Object.keys(configured.projects['apps/Synth'].targets ?? {}).sort(),
    ).toEqual(['archive', 'build', 'deploy', 'lint', 'test']);
    expect(
      configured.projects['apps/Synth'].targets?.build.options?.command,
    ).toContain("'-scheme' 'Synth'");
    expect(configured.projects['apps/Synth'].targets?.deploy).toMatchObject({
      cache: false,
      dependsOn: ['archive'],
    });
  });

  it('maps multiple shared schemes to explicit named Nx targets', () => {
    const record: AppleManifestRecord = {
      manifest: 'apps/Quickzones/Quickzones.xcodeproj/project.pbxproj',
      root: 'apps/Quickzones',
      kind: 'project',
      name: 'Quickzones',
      localPaths: [],
      application: true,
      schemes: [
        'Quickzones',
        'Quickzones Mac App Store',
        'Quickzones Mac Direct',
        'Quickzones Performance',
      ],
      swiftLint: false,
      selected: true,
    };
    const [[, result]] = projectsFromAppleManifests([record], '/workspace', {
      targets: {
        'archive-app-store': {
          action: 'archive',
          scheme: 'Quickzones Mac App Store',
          configuration: 'Release',
        },
        'build-direct': {
          action: 'build',
          scheme: 'Quickzones Mac Direct',
        },
        'test-ios': {
          action: 'test',
          scheme: 'Quickzones',
          destination: 'platform=iOS Simulator,name=iPhone 17',
        },
        performance: {
          action: 'test',
          scheme: 'Quickzones Performance',
        },
      },
    });
    const project = result.projects['apps/Quickzones'];
    expect(Object.keys(project.targets ?? {}).sort()).toEqual([
      'archive-app-store',
      'build-direct',
      'performance',
      'test-ios',
    ]);
    expect(project.targets?.['archive-app-store'].options?.command).toContain(
      "'-scheme' 'Quickzones Mac App Store'",
    );
    expect(project.targets?.['archive-app-store'].options?.command).toContain(
      "'-configuration' 'Release'",
    );
    expect(project.targets?.['test-ios'].options?.command).toContain(
      "'-destination' 'platform=iOS Simulator,name=iPhone 17'",
    );
    expect(project.metadata?.['megamono:preflight']).toMatchObject({
      diagnostics: [],
    });
  });

  it('reports invalid named scheme mappings without emitting partial targets', () => {
    const record: AppleManifestRecord = {
      manifest: 'apps/Synth/Synth.xcodeproj/project.pbxproj',
      root: 'apps/Synth',
      kind: 'project',
      name: 'Synth',
      localPaths: [],
      application: true,
      schemes: ['Synth Debug', 'Synth Release'],
      swiftLint: false,
      selected: true,
    };
    const [[, result]] = projectsFromAppleManifests([record], '/workspace', {
      targets: {
        release: { action: 'archive', scheme: 'Missing' },
        'deploy-beta': { action: 'deploy', scheme: 'Synth Release' },
      },
    });
    const project = result.projects['apps/Synth'];
    expect(project.targets).toEqual({});
    expect(
      project.metadata?.['megamono:preflight'].diagnostics.map(
        ({ code }: { code: string }) => code,
      ),
    ).toEqual(['apple-target', 'apple-target']);
  });

  it('creates static workspace and local-package edges with source manifests', async () => {
    const { root, runner } = await fixture();
    const { records } = await collectAppleManifests(
      [
        'Apps/Portfolio.xcworkspace/contents.xcworkspacedata',
        'Apps/Synth/Synth.xcodeproj/project.pbxproj',
        'Packages/Core/Package.swift',
      ],
      root,
      runner,
    );
    const projects = Object.fromEntries(
      projectsFromAppleManifests(records, root).flatMap(([, result]) =>
        Object.values(result.projects).map((project) => [
          project.name,
          project,
        ]),
      ),
    ) as Record<string, ProjectConfiguration>;
    expect(dependenciesFromAppleManifests(records, projects, root)).toEqual([
      {
        source: 'Portfolio',
        target: 'Synth',
        sourceFile: 'Apps/Portfolio.xcworkspace/contents.xcworkspacedata',
        type: DependencyType.static,
      },
      {
        source: 'Synth',
        target: 'Core',
        sourceFile: 'Apps/Synth/Synth.xcodeproj/project.pbxproj',
        type: DependencyType.static,
      },
    ]);
  });

  it('creates package-scoped Swift build and test targets', () => {
    const record: AppleManifestRecord = {
      manifest: 'Packages/Core/Package.swift',
      root: 'Packages/Core',
      kind: 'package',
      name: 'Core',
      localPaths: [],
      application: false,
      schemes: [],
      swiftLint: true,
      selected: true,
    };
    const [[, result]] = projectsFromAppleManifests([record], '/workspace', {
      scope: 'portfolio',
      derivedDataPath: 'dist/apple',
    });
    expect(result.projects['Packages/Core']).toMatchObject({
      projectType: 'library',
      tags: ['platform:apple', 'scope:portfolio', 'type:util'],
    });
    expect(result.projects['Packages/Core'].targets?.build).toMatchObject({
      cache: true,
      outputs: ['{workspaceRoot}/dist/apple/Core'],
    });
    expect(
      result.projects['Packages/Core'].targets?.build.options?.command,
    ).toContain("'--package-path' 'Packages/Core'");
    expect(result.projects['Packages/Core'].targets?.test.dependsOn).toEqual([
      'build',
    ]);
    expect(result.projects['Packages/Core'].targets?.lint).toBeDefined();
    expect(
      result.projects['Packages/Core'].metadata?.['megamono:preflight'],
    ).toEqual({
      diagnostics: [],
      requiredTools: [
        {
          executable: 'swift',
          reason: 'Swift package build and test targets',
        },
        {
          executable: 'swiftlint',
          reason: 'the project has a SwiftLint configuration',
        },
      ],
    });
  });

  it('infers a sole shared scheme and omits SwiftLint without configuration', () => {
    const record: AppleManifestRecord = {
      manifest: 'apps/Synth/Synth.xcodeproj/project.pbxproj',
      root: 'apps/Synth',
      kind: 'project',
      name: 'Synth',
      localPaths: [],
      application: true,
      schemes: ['Synth'],
      swiftLint: false,
      selected: true,
    };
    const [[, result]] = projectsFromAppleManifests([record], '/workspace');
    const targets = result.projects['apps/Synth'].targets ?? {};
    expect(targets.build.options?.command).toContain("'-scheme' 'Synth'");
    expect(targets.test.options?.command).toContain(
      "'-destination' 'platform=macOS'",
    );
    expect(targets.test.dependsOn).toEqual(['build']);
    expect(targets.test).toBeDefined();
    expect(targets.archive).toBeDefined();
    expect(targets.lint).toBeUndefined();
    expect(
      result.projects['apps/Synth'].metadata?.['megamono:preflight'],
    ).toMatchObject({
      diagnostics: [],
      requiredTools: [
        {
          executable: 'xcodebuild',
          reason: 'Xcode build, test, and archive targets',
        },
      ],
    });
  });

  it('publishes ambiguous schemes as project preflight diagnostics', () => {
    const record: AppleManifestRecord = {
      manifest: 'apps/Synth/Synth.xcodeproj/project.pbxproj',
      root: 'apps/Synth',
      kind: 'project',
      name: 'Synth',
      localPaths: [],
      application: true,
      schemes: ['Synth Debug', 'Synth Release'],
      swiftLint: false,
      selected: true,
    };
    const [[, result]] = projectsFromAppleManifests([record], '/workspace');
    expect(
      result.projects['apps/Synth'].metadata?.['megamono:preflight'],
    ).toMatchObject({
      diagnostics: [
        {
          severity: 'error',
          code: 'apple-scheme',
          path: 'apps/Synth/Synth.xcodeproj/project.pbxproj',
        },
      ],
    });
  });
});
