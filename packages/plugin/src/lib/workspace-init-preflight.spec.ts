import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  assertWorkspaceInitPreflight,
  type WorkspaceInitHostState,
} from './workspace-init-preflight';

function supportedTree() {
  const tree = createTreeWithEmptyWorkspace();
  tree.write(
    'package.json',
    JSON.stringify({
      packageManager: 'npm@11.5.2',
      devDependencies: { nx: '23.1.1', typescript: '6.0.3' },
    }),
  );
  tree.write(
    'package-lock.json',
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/nx': { version: '23.1.1' },
        'node_modules/typescript': { version: '6.0.3' },
      },
    }),
  );
  return tree;
}

const featureBranch: WorkspaceInitHostState = {
  platform: 'darwin',
  node: 'v24.7.0',
  npm: '11.5.2',
  pnpm: '11.24.0',
  git: {
    available: true,
    clean: true,
    branch: 'feat/adopt-megamono',
    defaultBranch: 'main',
  },
};

describe('workspace init preflight', () => {
  it('accepts the supported baseline on a clean feature branch', () => {
    expect(() =>
      assertWorkspaceInitPreflight(supportedTree(), featureBranch),
    ).not.toThrow();
  });

  it.each([
    [{ git: { ...featureBranch.git, clean: false } }, 'clean working tree'],
    [{ git: { ...featureBranch.git, branch: 'main' } }, 'default branch main'],
    [{ platform: 'win32' }, 'Operating system win32'],
    [{ node: 'v22.18.0' }, 'Node.js v22.18.0'],
    [{ npm: '10.9.0' }, 'npm 10.9.0'],
  ] satisfies readonly [Partial<WorkspaceInitHostState>, string][])(
    'refuses unsupported host state %#',
    (override, message) => {
      expect(() =>
        assertWorkspaceInitPreflight(supportedTree(), {
          ...featureBranch,
          ...override,
        }),
      ).toThrowError(
        expect.objectContaining({
          diagnosticCode: 'workspace-init-preflight',
          exitCode: 3,
          message: expect.stringContaining(message),
        }),
      );
    },
  );

  it('accepts a supported pnpm workspace', () => {
    const pnpm = supportedTree();
    pnpm.delete('package-lock.json');
    pnpm.write('pnpm-lock.yaml', 'lockfileVersion: 9');
    pnpm.write(
      'package.json',
      JSON.stringify({
        packageManager: 'pnpm@11.24.0',
        devDependencies: { nx: '23.1.1', typescript: '6.0.3' },
      }),
    );
    expect(() =>
      assertWorkspaceInitPreflight(pnpm, featureBranch, {
        packageManager: 'pnpm',
      }),
    ).not.toThrow();
  });

  it('refuses unsupported, conflicting, and mismatched package managers', () => {
    const conflicting = supportedTree();
    conflicting.write('pnpm-lock.yaml', 'lockfileVersion: 9');
    expect(() =>
      assertWorkspaceInitPreflight(conflicting, featureBranch),
    ).toThrow(/Conflicting/);

    const declaredYarn = supportedTree();
    const manifest = JSON.parse(
      declaredYarn.read('package.json', 'utf8') ?? '{}',
    );
    declaredYarn.write(
      'package.json',
      JSON.stringify({ ...manifest, packageManager: 'yarn@4.9.0' }),
    );
    expect(() =>
      assertWorkspaceInitPreflight(declaredYarn, featureBranch),
    ).toThrow(/unsupported package manager yarn@4.9.0/);

    expect(() =>
      assertWorkspaceInitPreflight(supportedTree(), featureBranch, {
        packageManager: 'pnpm',
      }),
    ).toThrow(/Requested pnpm.*npm lockfile/);

    const pnpmWithNpmDeclaration = supportedTree();
    pnpmWithNpmDeclaration.delete('package-lock.json');
    pnpmWithNpmDeclaration.write('pnpm-lock.yaml', 'lockfileVersion: 9');
    expect(() =>
      assertWorkspaceInitPreflight(pnpmWithNpmDeclaration, featureBranch),
    ).toThrow(/declares npm@11.5.2.*pnpm lockfile/);

    const yarn = supportedTree();
    yarn.delete('package-lock.json');
    yarn.write('yarn.lock', '');
    expect(() => assertWorkspaceInitPreflight(yarn, featureBranch)).toThrow(
      /Unsupported package-manager lockfile yarn.lock/,
    );
  });

  it('refuses incompatible workspace dependencies', () => {
    const oldNx = supportedTree();
    oldNx.write(
      'package-lock.json',
      JSON.stringify({
        packages: {
          'node_modules/nx': { version: '22.0.0' },
          'node_modules/typescript': { version: '6.0.3' },
        },
      }),
    );
    expect(() => assertWorkspaceInitPreflight(oldNx, featureBranch)).toThrow(
      /Nx 22.0.0 is unsupported/,
    );
  });

  it('allows create-megamono bootstrap to bypass only Git trust checks', () => {
    expect(() =>
      assertWorkspaceInitPreflight(
        supportedTree(),
        {
          ...featureBranch,
          git: { available: false, clean: false },
        },
        { bootstrap: true },
      ),
    ).not.toThrow();
  });
});
