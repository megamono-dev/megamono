import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { collectIntegrationProvenance } from './integration-provenance';

describe('installed integration artifact provenance', () => {
  const fixture = () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'node_modules/@playstack/auth/package.json',
      JSON.stringify({
        name: '@playstack/auth',
        version: '1.0.0',
        dependencies: { '@playstack/core': '^1' },
      }),
    );
    tree.write(
      'node_modules/@playstack/auth/dist/index.js',
      'exports.auth = 1;',
    );
    tree.write(
      'node_modules/@playstack/core/package.json',
      '{"name":"@playstack/core","version":"1.0.0"}',
    );
    tree.write(
      'node_modules/@playstack/core/dist/index.js',
      'exports.core = 1;',
    );
    return tree;
  };
  it('binds actual runtime bytes across the internal closure, not just versions or build metadata', () => {
    const tree = fixture();
    const first = collectIntegrationProvenance(tree, ['@playstack/auth']);
    expect(first.packages.map((p) => p.name)).toEqual([
      '@playstack/auth',
      '@playstack/core',
    ]);
    expect(collectIntegrationProvenance(tree, ['@playstack/auth'])).toEqual(
      first,
    );
    tree.write(
      'node_modules/@playstack/core/dist/index.js',
      'exports.core = 2;',
    );
    expect(
      collectIntegrationProvenance(tree, ['@playstack/auth']).fingerprint,
    ).not.toBe(first.fingerprint);
  });
  it('detects a pushed payload whose installed runtime is still stale', () => {
    const tree = fixture();
    tree.write(
      '.yalc/@playstack/core/package.json',
      '{"name":"@playstack/core","version":"1.0.0"}',
    );
    tree.write('.yalc/@playstack/core/dist/index.js', 'exports.core = 2;');
    expect(
      collectIntegrationProvenance(tree, ['@playstack/auth']).findings,
    ).toEqual([
      expect.objectContaining({
        code: 'stale-installed-artifact',
        package: '@playstack/core',
        severity: 'error',
      }),
    ]);
  });
  it('reports absent and incompatible peers without installing dependencies', () => {
    const tree = fixture();
    tree.write(
      'node_modules/@playstack/auth/package.json',
      JSON.stringify({
        name: '@playstack/auth',
        version: '1.0.0',
        peerDependencies: { bullmq: '^6', redis: '^5' },
      }),
    );
    tree.write(
      'node_modules/bullmq/package.json',
      '{"name":"bullmq","version":"5.67.0"}',
    );
    expect(
      collectIntegrationProvenance(tree, ['@playstack/auth']).findings.map(
        (f) => f.code,
      ),
    ).toEqual(['peer-incompatible', 'peer-unavailable']);
    tree.delete('node_modules/@playstack/core/package.json');
    expect(() =>
      collectIntegrationProvenance(tree, ['@playstack/core']),
    ).toThrow('not installed');
  });
});
