import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { assertPlaystackWorkspaceCompatibility } from './playstack-workspace';

describe('Playstack workspace compatibility', () => {
  it.each([
    ['^9.39.0', true],
    ['^10.0.0', true],
    ['>=9 <11', true],
    ['^8.57.0', false],
    ['^11.0.0', false],
    ['>=9', false],
    ['latest', false],
    [undefined, false],
  ])('validates the complete ESLint range %s', (eslint, supported) => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({ engines: { node: '>=24 <25' }, devDependencies: { eslint } }),
    );
    const check = () =>
      assertPlaystackWorkspaceCompatibility(tree, { eslint: true });
    if (supported) expect(check).not.toThrow();
    else expect(check).toThrow('Playstack lint requires ESLint');
  });

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
    ).toThrow('Playstack lint requires ESLint >=9 <11');

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
