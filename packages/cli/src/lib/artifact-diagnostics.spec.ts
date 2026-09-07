import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactDiagnosticOptions,
  diagnoseArtifacts,
} from './artifact-diagnostics.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'megamono-artifacts-'));
  roots.push(root);
  const store = join(root, 'store');
  return { root, store, packages: ['@megamono/cli'], path: '' };
}
function artifact(
  path: string,
  content = 'export const value = 1;',
  name = '@megamono/cli',
) {
  mkdirSync(join(path, 'dist'), { recursive: true });
  writeFileSync(
    join(path, 'package.json'),
    JSON.stringify({ name, version: '0.0.1', main: './dist/index.js' }),
  );
  writeFileSync(join(path, 'dist/index.js'), content);
  writeFileSync(
    join(path, 'dist/build-info.json'),
    JSON.stringify({
      revision: 'same-reported-revision',
      buildId: 'same-reported-build',
    }),
  );
}

describe('installed artifact diagnostics', () => {
  it('detects same-version stale installs from bytes even with identical build metadata', () => {
    const options = fixture();
    artifact(
      join(options.root, 'node_modules/@megamono/cli'),
      'export const value = 0;',
    );
    artifact(join(options.root, '.yalc/@megamono/cli'));
    artifact(join(options.store, 'packages/@megamono/cli/0.0.1'));
    const report = diagnoseArtifacts(options);
    expect(report.packages[0].findings).toEqual([
      expect.stringContaining('Same-version artifact drift'),
    ]);
  });
  it('compares source builds and PATH-selected symlinked CLIs without executing them', () => {
    const options = fixture();
    const sourceRoot = join(options.root, 'source');
    artifact(
      join(sourceRoot, 'packages/cli'),
      'throw new Error("must never execute");',
    );
    artifact(join(options.store, 'packages/@megamono/cli/0.0.1'));
    const bin = join(options.root, 'bin');
    mkdirSync(bin);
    chmodSync(join(sourceRoot, 'packages/cli/dist/index.js'), 0o755);
    symlinkSync(
      join(sourceRoot, 'packages/cli/dist/index.js'),
      join(bin, 'megamono'),
    );
    const report = diagnoseArtifacts({ ...options, sourceRoot, path: bin });
    expect(report.packages[0].locations.map(({ kind }) => kind)).toEqual([
      'installed',
      'payload',
      'store',
      'source-build',
      'path-cli',
    ]);
    expect(report.packages[0].findings).toHaveLength(1);
  });
  it('reports a pushed but uninstalled payload and a corrupt artifact without certifying either', () => {
    const options = fixture();
    artifact(join(options.root, '.yalc/@megamono/cli'));
    artifact(join(options.store, 'packages/@megamono/cli/0.0.1'));
    writeFileSync(
      join(options.store, 'packages/@megamono/cli/0.0.1/package.json'),
      '{}',
    );
    const report = diagnoseArtifacts(options);
    expect(report.packages[0].findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Package identity'),
        expect.stringContaining('no installed package'),
      ]),
    );
  });
  it('inventories store packages and ignores generated metadata when runtime bytes match', () => {
    const options = fixture();
    artifact(
      join(options.store, 'packages/@megamono/nx-laravel/0.0.1'),
      undefined,
      '@megamono/nx-laravel',
    );
    artifact(
      join(options.root, 'node_modules/@megamono/nx-laravel'),
      undefined,
      '@megamono/nx-laravel',
    );
    writeFileSync(
      join(
        options.root,
        'node_modules/@megamono/nx-laravel/dist/build-info.json',
      ),
      '{"revision":"different"}',
    );
    const report = diagnoseArtifacts({ ...options, packages: undefined });
    expect(
      report.packages.find(({ name }) => name === '@megamono/nx-laravel')
        ?.findings,
    ).toEqual([]);
  });
  it('validates diagnostic paths/options and rejects package traversal', () => {
    const options = fixture();
    expect(
      artifactDiagnosticOptions(
        [
          '--json',
          '--packages=@megamono/cli',
          '--yalc-store=store',
          '--source-root=source',
        ],
        options.root,
      ),
    ).toMatchObject({
      json: true,
      store: options.store,
      sourceRoot: join(options.root, 'source'),
      packages: ['@megamono/cli'],
    });
    expect(() =>
      diagnoseArtifacts({ ...options, packages: ['../../secret'] }),
    ).toThrow('package names');
    expect(() =>
      artifactDiagnosticOptions(['--yalc-store='], options.root),
    ).toThrow('empty');
  });
});
