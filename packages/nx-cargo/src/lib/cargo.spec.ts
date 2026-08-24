import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DependencyType, type ProjectConfiguration } from '@nx/devkit';
import {
  collectCargoMetadata,
  dependenciesFromCargoMetadata,
  projectsFromCargoMetadata,
  type CargoMetadata,
  type CargoMetadataPackage,
  type CargoMetadataRecord,
} from './cargo';

function cargoPackage(
  root: string,
  name: string,
  kind: string[],
  dependencies: CargoMetadataPackage['dependencies'] = [],
): CargoMetadataPackage {
  return {
    id: `${name} 0.1.0 (path+file://${root})`,
    name,
    manifest_path: resolve(root, 'Cargo.toml'),
    dependencies,
    targets: [{ kind }],
  };
}

function metadata(
  root: string,
  packages: CargoMetadataPackage[],
): CargoMetadata {
  return {
    packages,
    workspace_members: packages.map((pkg) => pkg.id),
    workspace_root: root,
    target_directory: resolve(root, 'target'),
  };
}

async function cargoFixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'nx-cargo-'));
  const coreRoot = resolve(root, 'packages/core');
  const helperRoot = resolve(root, 'packages/helper');
  const appManifestRoot = resolve(root, 'apps/desktop/src-tauri');
  await Promise.all([
    mkdir(coreRoot, { recursive: true }),
    mkdir(helperRoot, { recursive: true }),
    mkdir(appManifestRoot, { recursive: true }),
  ]);
  await writeFile(resolve(appManifestRoot, 'tauri.conf.json'), '{}');
  const core = cargoPackage(coreRoot, 'core', ['lib']);
  const helper = cargoPackage(helperRoot, 'helper', ['lib']);
  const desktop = cargoPackage(
    appManifestRoot,
    'desktop',
    ['bin'],
    [
      { name: 'core', path: coreRoot, kind: 'normal' },
      { name: 'core', path: coreRoot, kind: 'dev', target: 'cfg(test)' },
      { name: 'helper', path: helperRoot, kind: 'build' },
      { name: 'serde', path: null, kind: 'normal' },
    ],
  );
  const record: CargoMetadataRecord = {
    manifest: 'Cargo.toml',
    metadata: metadata(root, [core, helper, desktop]),
  };
  return { root, core, helper, desktop, record };
}

describe('projectsFromCargoMetadata', () => {
  it('creates one project per package and no virtual workspace project', async () => {
    const { root, record } = await cargoFixture();
    const [[source, result]] = projectsFromCargoMetadata([record], root);
    expect(source).toBe('Cargo.toml');
    expect(Object.keys(result.projects).sort()).toEqual([
      'apps/desktop',
      'packages/core',
      'packages/helper',
    ]);
    expect(result.projects['.']).toBeUndefined();
    expect(result.projects['packages/core']).toMatchObject({
      name: 'core',
      projectType: 'library',
      tags: ['platform:rust', 'scope:shared', 'type:util'],
    });
    expect(result.projects['apps/desktop']).toMatchObject({
      name: 'desktop',
      projectType: 'application',
      tags: [
        'platform:rust',
        'scope:shared',
        'type:app',
        'visibility:internal',
      ],
      metadata: { technologies: ['rust', 'tauri'] },
    });
  });

  it('always scopes commands to one package and supports renamed targets and flags', async () => {
    const { root, record } = await cargoFixture();
    const [[, result]] = projectsFromCargoMetadata([record], root, {
      buildTargetName: 'compile',
      lintTargetName: 'clippy',
      target: 'aarch64-apple-darwin',
      features: ['desktop', 'updates'],
      noDefaultFeatures: true,
      profile: 'release',
      targetDir: 'dist/cargo',
    });
    const desktop = result.projects['apps/desktop'];
    expect(desktop.targets?.['build']).toBeUndefined();
    expect(desktop.targets?.['compile']).toMatchObject({
      cache: true,
      inputs: ['default', '^default'],
      outputs: ['{workspaceRoot}/dist/cargo/desktop'],
    });
    const command = desktop.targets?.['compile'].options?.['command'] as string;
    expect(command).toContain("'--package' 'desktop'");
    expect(command).toContain("'--target' 'aarch64-apple-darwin'");
    expect(command).toContain("'--features' 'desktop,updates'");
    expect(command).toContain("'--no-default-features'");
    expect(command).toContain("'--profile' 'release'");
    expect(desktop.targets?.['tauri'].options?.['command']).toContain(
      "'--package' 'desktop'",
    );
  });

  it('applies a configured scope tag to every inferred project', async () => {
    const { root, record } = await cargoFixture();
    const [[, result]] = projectsFromCargoMetadata([record], root, {
      scope: 'acme-tools',
    });
    expect(result.projects['apps/desktop'].tags).toContain('scope:acme-tools');
    expect(result.projects['packages/core'].tags).toContain('scope:acme-tools');
  });

  it('uses the local pinned npm Tauri CLI when the lifted app provides it', async () => {
    const { root, record } = await cargoFixture();
    await writeFile(
      resolve(root, 'apps/desktop/package.json'),
      JSON.stringify({
        devDependencies: { '@tauri-apps/cli': '2.11.4' },
      }),
    );
    const [[, result]] = projectsFromCargoMetadata([record], root);
    expect(result.projects['apps/desktop'].targets?.['tauri']).toMatchObject({
      outputs: ['{workspaceRoot}/.nx/cargo/desktop'],
      options: {
        cwd: '{workspaceRoot}/apps/desktop',
        command: expect.stringContaining(
          "'npm' 'exec' 'tauri' '--' 'build' '--ci'",
        ),
      },
    });
    expect(
      result.projects['apps/desktop'].targets?.['tauri'].options?.['command'],
    ).toContain("'--target-dir' '../../.nx/cargo/desktop'");
  });
});

describe('dependenciesFromCargoMetadata', () => {
  it('maps normal, development, build, and target-specific paths to deduplicated static edges', async () => {
    const { root, record } = await cargoFixture();
    const [[, result]] = projectsFromCargoMetadata([record], root);
    const projects = Object.fromEntries(
      Object.values(result.projects).map((project) => [project.name, project]),
    ) as Record<string, ProjectConfiguration>;
    expect(dependenciesFromCargoMetadata([record], projects, root)).toEqual([
      {
        source: 'desktop',
        target: 'core',
        sourceFile: 'apps/desktop/src-tauri/Cargo.toml',
        type: DependencyType.static,
      },
      {
        source: 'desktop',
        target: 'helper',
        sourceFile: 'apps/desktop/src-tauri/Cargo.toml',
        type: DependencyType.static,
      },
    ]);
  });
});

describe('collectCargoMetadata', () => {
  it('runs metadata once for a workspace and separately for an excluded nested package', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'nx-cargo-roots-'));
    const memberRoot = resolve(root, 'crates/member');
    const excludedRoot = resolve(root, 'examples/excluded');
    await Promise.all([
      mkdir(memberRoot, { recursive: true }),
      mkdir(excludedRoot, { recursive: true }),
    ]);
    await writeFile(
      resolve(root, 'Cargo.toml'),
      '[workspace]\nmembers=["crates/member"]\n',
    );
    await writeFile(
      resolve(memberRoot, 'Cargo.toml'),
      '[package]\nname="member"\nversion="0.1.0"\n',
    );
    await writeFile(
      resolve(excludedRoot, 'Cargo.toml'),
      '[package]\nname="excluded"\nversion="0.1.0"\n',
    );
    const member = cargoPackage(memberRoot, 'member', ['lib']);
    const excluded = cargoPackage(excludedRoot, 'excluded', ['bin']);
    const calls: string[] = [];
    const collected = await collectCargoMetadata(
      [
        'Cargo.toml',
        'crates/member/Cargo.toml',
        'examples/excluded/Cargo.toml',
      ],
      root,
      async (manifest) => {
        calls.push(manifest);
        return manifest === resolve(root, 'Cargo.toml')
          ? metadata(root, [member])
          : metadata(excludedRoot, [excluded]);
      },
    );
    expect(calls).toEqual([
      resolve(root, 'Cargo.toml'),
      resolve(excludedRoot, 'Cargo.toml'),
    ]);
    expect(collected.records).toHaveLength(2);
    expect(collected.diagnostics).toEqual([]);
  });

  it('keeps valid roots when another manifest is malformed or Cargo is missing', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'nx-cargo-errors-'));
    const goodRoot = resolve(root, 'good');
    const badRoot = resolve(root, 'bad');
    await Promise.all([
      mkdir(goodRoot, { recursive: true }),
      mkdir(badRoot, { recursive: true }),
    ]);
    await writeFile(
      resolve(goodRoot, 'Cargo.toml'),
      '[package]\nname="good"\nversion="0.1.0"\n',
    );
    await writeFile(resolve(badRoot, 'Cargo.toml'), 'not toml');
    const good = cargoPackage(goodRoot, 'good', ['lib']);
    const collected = await collectCargoMetadata(
      ['good/Cargo.toml', 'bad/Cargo.toml'],
      root,
      async (manifest) => {
        if (manifest.includes('/bad/')) {
          const error = new Error('spawn cargo ENOENT');
          (error as NodeJS.ErrnoException).code = 'ENOENT';
          throw error;
        }
        return metadata(goodRoot, [good]);
      },
    );
    expect(collected.records).toHaveLength(1);
    expect(collected.diagnostics).toEqual([
      expect.objectContaining({
        manifest: resolve(badRoot, 'Cargo.toml'),
        message: expect.stringContaining('spawn cargo ENOENT'),
      }),
    ]);
  });
});
