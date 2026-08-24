import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DependencyType, type ProjectConfiguration } from '@nx/devkit';
import {
  collectAppleManifests,
  dependenciesFromAppleManifests,
  parsePbxLocalPackagePaths,
  parseWorkspaceProjectPaths,
  projectsFromAppleManifests,
  type AppleManifestRecord,
  type SwiftPackageDumpRunner,
} from './apple';

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
