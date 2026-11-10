import { logger, type ExecutorContext } from '@nx/devkit';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listing = vi.hoisted(() => ({ stdout: '[]' }));
vi.mock('node:child_process', async (original) => {
  const execFile = (
    _command: string,
    _args: string[],
    _options: unknown,
    callback: (error: null, result: { stdout: string; stderr: string }) => void,
  ) => callback(null, { stdout: listing.stdout, stderr: '' });
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, default: { ...actual, execFile }, execFile };
});

import audit, {
  affectedFindings,
  productionPackages,
} from './audit-production';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

const tree = [
  {
    name: '@acme/extension',
    dependencies: {
      '@acme/ui': {
        version: 'link:../../libs/ui',
        dependencies: { react: { version: '19.3.1' } },
      },
      zod: {
        version: '4.6.6',
        dependencies: { react: { version: '19.3.1' } },
      },
    },
  },
];

describe('audit-production', () => {
  it('collects registry versions through workspace links only', () => {
    expect(productionPackages(tree)).toEqual(
      new Map([
        ['react', new Set(['19.3.1'])],
        ['zod', new Set(['4.6.6'])],
      ]),
    );
  });

  it('keeps advisories that match an installed version', () => {
    const packages = new Map([['zod', new Set(['4.6.6'])]]);
    expect(
      affectedFindings(packages, {
        zod: [
          { severity: 'high', title: 'fixed', vulnerable_versions: '<4.0.0' },
          {
            severity: 'moderate',
            title: 'open',
            url: 'https://example.test/1',
            vulnerable_versions: '>=4.6.0 <4.6.7',
          },
        ],
      }),
    ).toEqual([
      {
        package: 'zod',
        version: '4.6.6',
        severity: 'moderate',
        title: 'open',
        url: 'https://example.test/1',
      },
    ]);
  });

  it('queries only the project closure and applies the audit level', async () => {
    const root = mkdtempSync(join(tmpdir(), 'megamono-audit-'));
    roots.push(root);
    writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    mkdirSync(join(root, 'apps/extension'), { recursive: true });
    writeFileSync(
      join(root, 'apps/extension/package.json'),
      JSON.stringify({ name: '@acme/extension' }),
    );
    listing.stdout = JSON.stringify(tree);
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        zod: [
          {
            severity: 'moderate',
            title: 'open',
            vulnerable_versions: '<4.6.7',
          },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const context = {
      root,
      projectName: 'acme-extension',
      projectsConfigurations: {
        version: 2,
        projects: { 'acme-extension': { root: 'apps/extension' } },
      },
    } as unknown as ExecutorContext;
    expect(await audit({}, context)).toEqual({ success: false });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      react: ['19.3.1'],
      zod: ['4.6.6'],
    });
    expect(await audit({ auditLevel: 'high' }, context)).toEqual({
      success: true,
    });
  });
});
