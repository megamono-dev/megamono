import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  assessWorkspaceInitHostReadiness,
  assertWorkspaceMutationGitPreflight,
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
  yarn: '4.9.4',
  bun: '1.1.26',
  git: {
    available: true,
    clean: true,
    branch: 'feat/adopt-megamono',
    defaultBranch: 'main',
  },
};

describe('workspace init preflight', () => {
  it('reports active host drift with exact activation guidance', () => {
    const tree = supportedTree();
    tree.delete('package-lock.json');
    tree.write('pnpm-lock.yaml', 'lockfileVersion: 9');
    tree.write(
      'package.json',
      JSON.stringify({
        packageManager: 'pnpm@11.24.0',
        engines: { node: '>=22 <23' },
        devDependencies: { nx: '22.2.3', typescript: '5.9.3' },
      }),
    );
    const readiness = assessWorkspaceInitHostReadiness(tree, {
      ...featureBranch,
      node: 'v26.5.0',
      pnpm: '6.35.1',
    });

    expect(readiness).toMatchObject({
      selectedPackageManager: 'pnpm',
      ready: false,
      active: { node: 'v26.5.0', pnpm: '6.35.1' },
    });
    expect(readiness.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Node.js v26.5.0'),
        expect.stringContaining('pnpm 6.35.1'),
        expect.stringContaining('repository declaration pnpm@11.24.0'),
      ]),
    );
    expect(readiness.activation).toContain(
      'Run `corepack enable`, then `corepack prepare pnpm@11.24.0 --activate`.',
    );
  });

  it('shares operation-specific Git mutation safety', () => {
    expect(() =>
      assertWorkspaceMutationGitPreflight(
        { ...featureBranch, git: { ...featureBranch.git, clean: false } },
        'Application addition',
      ),
    ).toThrow('Application addition requires a clean working tree.');
    expect(() =>
      assertWorkspaceMutationGitPreflight(
        { ...featureBranch, git: { ...featureBranch.git, branch: 'main' } },
        'Database addition',
      ),
    ).toThrow('Database addition must not run on the default branch main.');
  });

  it('accepts the supported baseline on a clean feature branch', () => {
    expect(() =>
      assertWorkspaceInitPreflight(supportedTree(), featureBranch),
    ).not.toThrow();
  });

  it('does not reject core adoption based on the host operating system', () => {
    expect(() =>
      assertWorkspaceInitPreflight(supportedTree(), {
        ...featureBranch,
        platform: 'win32',
      }),
    ).not.toThrow();
  });

  it.each([
    [{ git: { ...featureBranch.git, clean: false } }, 'clean working tree'],
    [{ git: { ...featureBranch.git, branch: 'main' } }, 'default branch main'],
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

  it('refuses an active manager that differs from the committed declaration', () => {
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
      assertWorkspaceInitPreflight(pnpm, {
        ...featureBranch,
        pnpm: '10.30.0',
      }),
    ).toThrow(/Active pnpm 10\.30\.0.*pnpm@11\.24\.0/);
  });

  it('refuses conflicting and mismatched package-manager ownership', () => {
    const conflicting = supportedTree();
    conflicting.write('pnpm-lock.yaml', 'lockfileVersion: 9');
    expect(() =>
      assertWorkspaceInitPreflight(conflicting, featureBranch),
    ).toThrow(/Conflicting/);

    expect(() =>
      assertWorkspaceInitPreflight(supportedTree(), featureBranch, {
        packageManager: 'pnpm',
      }),
    ).toThrow(/Requested pnpm.*workspace owns npm/);

    const pnpmWithNpmDeclaration = supportedTree();
    pnpmWithNpmDeclaration.delete('package-lock.json');
    pnpmWithNpmDeclaration.write('pnpm-lock.yaml', 'lockfileVersion: 9');
    expect(() =>
      assertWorkspaceInitPreflight(pnpmWithNpmDeclaration, featureBranch),
    ).toThrow(/declares npm@11.5.2.*belongs to pnpm/);
  });

  it.each([
    ['yarn', 'yarn@4.9.4', 'yarn.lock'],
    ['bun', 'bun@1.1.26', 'bun.lock'],
  ] as const)(
    'accepts an existing %s workspace',
    (manager, declaration, lockfile) => {
      const yarn = supportedTree();
      yarn.delete('package-lock.json');
      yarn.write(lockfile, '');
      yarn.write(
        'package.json',
        JSON.stringify({
          packageManager: declaration,
          devDependencies: { nx: '23.1.1', typescript: '6.0.3' },
        }),
      );
      expect(() =>
        assertWorkspaceInitPreflight(yarn, featureBranch, {
          packageManager: manager,
        }),
      ).not.toThrow();
    },
  );

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
