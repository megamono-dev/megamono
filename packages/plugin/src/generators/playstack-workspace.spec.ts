import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { assertPlaystackWorkspaceCompatibility } from './playstack-workspace';

describe('Playstack workspace compatibility', () => {
  it('keeps Node 18 adoption available while refusing Playstack packages', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({ engines: { node: '>=18.18 <25' } }),
    );

    expect(() => assertPlaystackWorkspaceCompatibility(tree)).toThrow(
      'Playstack packages require Node >=20',
    );
  });

  it('requires the Playstack lint peer without narrowing core Megamono lint', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({
        engines: { node: '>=20 <25' },
        devDependencies: { eslint: '^8.57.0' },
      }),
    );
    expect(() =>
      assertPlaystackWorkspaceCompatibility(tree, { eslint: true }),
    ).toThrow('Playstack lint requires ESLint ^9.0.0');

    tree.write(
      'package.json',
      JSON.stringify({
        engines: { node: '>=20 <25' },
        devDependencies: { eslint: '^9.39.0' },
      }),
    );
    expect(() =>
      assertPlaystackWorkspaceCompatibility(tree, { eslint: true }),
    ).not.toThrow();
  });
});
