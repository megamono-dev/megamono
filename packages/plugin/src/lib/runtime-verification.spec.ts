import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  externalSpecifiers,
  verifyRuntimeDependencies,
} from './runtime-verification';

describe('runtime dependency verification', () => {
  it('extracts package specifiers while excluding built-ins and local modules', () => {
    expect(
      externalSpecifiers(
        `const fs = require('node:fs'); require('tslib'); import '@scope/runtime/subpath'; import('./local.js');`,
      ),
    ).toEqual(['@scope/runtime', 'tslib']);
  });

  it('reports missing and dev-only dependencies from built output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-runtime-'));
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
