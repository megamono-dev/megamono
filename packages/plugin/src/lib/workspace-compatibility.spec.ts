import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  nxWorkspaceCapabilities,
  parseVersionNumber,
} from './workspace-compatibility';

describe('workspace compatibility', () => {
  it('parses exact and ranged dependency versions', () => {
    expect(parseVersionNumber('19.5.0')).toEqual({
      major: 19,
      minor: 5,
      patch: 0,
    });
    expect(parseVersionNumber('>=18.3 <20')).toEqual({
      major: 18,
      minor: 3,
      patch: 0,
    });
  });

  it.each([
    ['19.4.4', false],
    ['19.5.0', true],
    ['20.0.0', true],
  ])('gates target parallelism for Nx %s', (version, targetParallelism) => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({ devDependencies: { nx: version } }),
    );

    expect(nxWorkspaceCapabilities(tree).targetParallelism).toBe(
      targetParallelism,
    );
  });
});
