import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  externalSpecifiers,
  analyzeRuntimeImports,
  verifyRuntimeDependencies,
} from './runtime-verification';

describe('runtime dependency verification', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });
  it('ignores Fontstack-style embedded examples, prose, comments and regex literals', () => {
    expect(
      externalSpecifiers(
        [
          'const example = `import { Button } from "@mui/material"; require("expo-font")`;',
          `const text = ${JSON.stringify('import "quoted-package"')};`,
          '// require("comment-only")',
          '/* export * from "comment-export" */',
          'const regex = /require("regex-only")/;',
          'const real = require("tslib");',
        ].join('\n'),
      ),
    ).toEqual(['tslib']);
  });

  it('extracts executable imports, exports, escaped literals and template expressions', () => {
    expect(
      externalSpecifiers(
        [
          'import "side-effect";',
          'export { x } from "@scope/package/path";',
          'export * from "re-export";',
          'import(`literal-dynamic`);',
          'require("escaped\\u002dname");',
          'const example = `text ${require("real-expression")}`;',
        ].join('\n'),
      ),
    ).toEqual([
      '@scope/package',
      'escaped-name',
      'literal-dynamic',
      're-export',
      'real-expression',
      'side-effect',
    ]);
  });

  it('does not mistake shadowed require bindings or object methods for CommonJS', () => {
    expect(
      externalSpecifiers(
        'function f(require) { require("local-argument"); } obj.require("method"); require("actual");',
      ),
    ).toEqual(['actual']);
    expect(
      externalSpecifiers(
        'require("hoisted-local"); function require(x) { return x; }',
      ),
    ).toEqual([]);
    expect(
      externalSpecifiers(
        '{ const require = lookup; require("block-local"); } require("actual");',
      ),
    ).toEqual(['actual']);
  });

  it.each([
    'import(name)',
    'require(prefix + name)',
    'import(`prefix-${name}`)',
    'const broken = ;',
  ])('reports incomplete analysis for %s', (source) => {
    expect(analyzeRuntimeImports(source).issues.length).toBeGreaterThan(0);
    expect(() => externalSpecifiers(source)).toThrow('incomplete');
  });
  it.each([
    'import { createRequire as makeRequire } from "node:module"; const require = makeRequire(import.meta.url);',
    'import * as nodeModule from "node:module"; const require = nodeModule.createRequire(import.meta.url);',
    'const {createRequire} = require("node:module"); const load = createRequire(__filename);',
  ])('recognizes Node createRequire loaders: %s', (prefix) => {
    const loader = prefix.includes('const load') ? 'load' : 'require';
    expect(
      externalSpecifiers(
        `${prefix} ${loader}("runtime-package"); ${loader}.resolve("resolve-package");`,
      ),
    ).toEqual(['resolve-package', 'runtime-package']);
    expect(
      analyzeRuntimeImports(`${prefix} ${loader}(dynamicName);`).issues.length,
    ).toBeGreaterThan(0);
  });
  it('does not treat an application createRequire function as a Node loader', () => {
    expect(
      externalSpecifiers(
        'function createRequire() { return custom; } const require = createRequire(); require("not-node");',
      ),
    ).toEqual([]);
    expect(
      externalSpecifiers('require.resolve("resolution-dependency");'),
    ).toEqual(['resolution-dependency']);
  });

  it('does not return a clean report for unresolved imports or malformed JavaScript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-runtime-incomplete-'));
    roots.push(root);
    await mkdir(join(root, 'dist'));
    await writeFile(
      join(root, 'dist/main.js'),
      'import(name); require("missing");',
    );
    await writeFile(join(root, 'dist/broken.cjs'), 'const value = ;');
    const report = await verifyRuntimeDependencies({
      workspaceRoot: root,
      project: 'api',
      projectRoot: 'apps/api',
      outputPath: 'dist',
    });
    expect(report.externalPackages).toEqual(['missing']);
    expect(
      report.findings.filter(
        (entry) => entry.code === 'runtime-analysis-incomplete',
      ),
    ).toHaveLength(2);
    expect(
      report.findings.some(
        (entry) => entry.code === 'runtime-dependency-missing',
      ),
    ).toBe(true);
  });
  it('extracts package specifiers while excluding built-ins and local modules', () => {
    expect(
      externalSpecifiers(
        `const fs = require('node:fs'); require('tslib'); import '@scope/runtime/subpath'; import('./local.js');`,
      ),
    ).toEqual(['@scope/runtime', 'tslib']);
  });

  it('rejects a zero-file output scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-runtime-empty-'));
    roots.push(root);
    await mkdir(join(root, 'dist'));
    const report = await verifyRuntimeDependencies({
      workspaceRoot: root,
      project: 'api',
      projectRoot: '.',
      outputPath: 'dist',
    });
    expect(report.findings).toEqual([
      expect.objectContaining({ code: 'runtime-analysis-incomplete' }),
    ]);
  });

  it('reports missing and dev-only dependencies from built output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-runtime-'));
    roots.push(root);
    await mkdir(join(root, 'apps/api'), { recursive: true });
    await mkdir(join(root, 'dist/apps/api'), { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { tslib: '^2.8.1' },
        devDependencies: { 'tsconfig-paths': '^4.2.0' },
      }),
    );
    await writeFile(
      join(root, 'dist/apps/api/main.js'),
      `require('tslib'); require('tsconfig-paths/register'); require('missing-runtime');`,
    );

    const report = await verifyRuntimeDependencies({
      workspaceRoot: root,
      project: 'api',
      projectRoot: 'apps/api',
      outputPath: 'dist/apps/api',
    });

    expect(report.externalPackages).toEqual([
      'missing-runtime',
      'tsconfig-paths',
      'tslib',
    ]);
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: 'runtime-dependency-missing',
        package: 'missing-runtime',
      }),
      expect.objectContaining({
        code: 'runtime-dependency-dev-only',
        package: 'tsconfig-paths',
      }),
    ]);
  });
});
