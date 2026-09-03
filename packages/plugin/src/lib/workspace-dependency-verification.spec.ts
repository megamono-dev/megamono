import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyWorkspaceDependencies } from './workspace-dependency-verification';

describe('workspace dependency verification', () => {
  it('finds pnpm, workspace membership, executable, and preload portability gaps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-pnpm-audit-'));
    await mkdir(join(root, 'apps/api'), { recursive: true });
    await mkdir(join(root, 'libs/tooling'), { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@11.24.0',
        engines: { node: '>=22 <25', pnpm: '>=11 <12' },
        devDependencies: { nx: '23.1.1' },
      }),
    );
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    await writeFile(
      join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'apps/*'\n",
    );
    await writeFile(
      join(root, 'apps/api/package.json'),
      JSON.stringify({
        scripts: {
          start: 'node -r tsconfig-paths/register dist/main.js',
          verify: 'vitest --run',
        },
      }),
    );
    await writeFile(
      join(root, 'libs/tooling/package.json'),
      JSON.stringify({ devDependencies: { 'tsconfig-paths': '^4.2.0' } }),
    );

    const report = await verifyWorkspaceDependencies({
      workspaceRoot: root,
      activeNode: '26.0.0',
      activePnpm: '10.0.0',
    });

    expect(report.findings.map(({ code }) => code)).toEqual([
      'script-dependency-missing',
      'script-dependency-sibling-only',
      'workspace-package-omitted',
      'active-node-mismatch',
      'active-pnpm-mismatch',
    ]);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dependency: 'tsconfig-paths',
          manifest: 'apps/api/package.json',
        }),
        expect.objectContaining({
          dependency: 'vitest',
          manifest: 'apps/api/package.json',
        }),
      ]),
    );
  });
});
