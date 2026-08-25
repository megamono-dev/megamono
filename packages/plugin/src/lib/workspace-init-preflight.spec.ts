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

  it('refuses non-npm lockfiles and incompatible workspace dependencies', () => {
    const nonNpm = supportedTree();
    nonNpm.write('pnpm-lock.yaml', 'lockfileVersion: 9');
    expect(() => assertWorkspaceInitPreflight(nonNpm, featureBranch)).toThrow(
      /requires npm/,
    );

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
    ).toThrow(/declares yarn@4.9.0/);

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
