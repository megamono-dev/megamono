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
    [{ node: 'v18.17.0' }, 'Node.js v18.17.0'],
    [{ npm: '8.19.4' }, 'npm 8.19.4'],
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

  it.each([
    ['17.1.2', '5.2.2'],
    ['20.0.1', '5.6.2'],
    ['21.6.11', '5.9.3'],
    ['22.2.3', '5.9.3'],
    ['23.1.1', '6.0.3'],
  ])(
    'accepts the Nx %s and TypeScript %s adoption anchor',
    (nx, typescript) => {
      const tree = supportedTree();
      tree.write(
        'package-lock.json',
        JSON.stringify({
          packages: {
            'node_modules/nx': { version: nx },
            'node_modules/typescript': { version: typescript },
          },
        }),
      );
      expect(() =>
        assertWorkspaceInitPreflight(tree, featureBranch),
      ).not.toThrow();
    },
  );

  it.each([
    ['Nx', '16.10.0', '6.0.3'],
    ['Nx', '24.0.0', '6.0.3'],
    ['TypeScript', '23.1.1', '5.1.6'],
    ['TypeScript', '23.1.1', '7.0.0'],
  ])('refuses %s outside the adoption range', (label, nx, typescript) => {
    const tree = supportedTree();
    tree.write(
      'package-lock.json',
      JSON.stringify({
        packages: {
          'node_modules/nx': { version: nx },
          'node_modules/typescript': { version: typescript },
        },
      }),
    );
    expect(() => assertWorkspaceInitPreflight(tree, featureBranch)).toThrow(
      new RegExp(`${label} .* is unsupported for adoption`),
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
