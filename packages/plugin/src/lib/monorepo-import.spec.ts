import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planMonorepoImport, type MonorepoSelection } from './monorepo-import';

describe('reviewed monorepo project planning', () => {
  let workspaceRoot: string;
  const configuration = {
    projectType: 'library' as const,
    targets: {
      build: {
        executor: 'nx:run-commands',
        options: { command: 'node build.cjs' },
      },
    },
  };
  const selection: MonorepoSelection = {
    projects: {
      'packages/sdk': { action: 'reuse', project: 'sdk' },
      'packages/email': { action: 'import', name: 'email', configuration },
    },
  };
  const source: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'source',
      private: true,
      workspaces: ['packages/*'],
      scripts: { build: 'nx run-many -t build' },
    }),
    'nx.json': '{}',
    'tsconfig.json': JSON.stringify({
      references: [
        { path: './packages/sdk/tsconfig.json' },
        { path: './packages/email/tsconfig.json' },
      ],
    }),
    'packages/sdk/package.json': JSON.stringify({
      name: '@fixture/sdk',
      version: '1.0.0',
    }),
    'packages/sdk/tsconfig.json': '{}',
    'packages/sdk/src/index.ts': 'export const version = 1;',
    'packages/email/package.json': JSON.stringify({
      name: '@fixture/email',
      version: '1.0.0',
      dependencies: { '@fixture/sdk': 'workspace:^1.0.0' },
    }),
    'packages/email/tsconfig.json': JSON.stringify({
      references: [{ path: '../sdk/tsconfig.json' }],
    }),
    'packages/email/src/index.ts': "export { version } from '@fixture/sdk';",
  };
  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'megamono-multi-plan-'));
    await mkdir(join(workspaceRoot, 'libs/sdk'), { recursive: true });
    await writeFile(
      join(workspaceRoot, 'libs/sdk/package.json'),
      JSON.stringify({ name: '@fixture/sdk', version: '1.1.0' }),
    );
    await writeFile(join(workspaceRoot, 'libs/sdk/tsconfig.json'), '{}');
  });
  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });
  const plan = (files = source, options = selection) =>
    planMonorepoImport({
      workspaceRoot,
      destination: 'libs/imported',
      name: 'imported',
      selection: options,
      files: Object.keys(files),
      read: async (path) => files[path],
      targetProjects: [
        { name: 'sdk', packageName: '@fixture/sdk', root: 'libs/sdk' },
      ],
    });

  it('preserves nested project paths, maps a duplicate SDK to the host and rewrites TypeScript references', async () => {
    const result = await plan();
    expect(result.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'sdk',
          action: 'reuse',
          destination: 'libs/sdk',
        }),
        expect.objectContaining({
          name: 'email',
          destination: 'libs/imported/packages/email',
        }),
      ]),
    );
    expect(result.edges).toEqual([
      { fromProject: 'email', project: 'sdk', packageName: '@fixture/sdk' },
    ]);
    const reference = result.rewrites.find(
      ({ source }) => source === 'packages/email/tsconfig.json',
    );
    expect(JSON.parse(reference?.content ?? '{}').references).toEqual([
      { path: '../../../sdk/tsconfig.json' },
    ]);
    expect(
      JSON.parse(
        result.rewrites.find(
          ({ source }) => source === 'packages/email/package.json',
        )?.content ?? '{}',
      ).dependencies['@fixture/sdk'],
    ).toBe('^1.0.0');
    expect(
      JSON.parse(
        result.rewrites.find(({ source }) => source === 'package.json')
          ?.content ?? '{}',
      ).scripts,
    ).toBeUndefined();
    expect(await plan()).toEqual(result);
  });

  it('renames a duplicate package identity and its actual module references', async () => {
    const result = await plan(source, {
      projects: {
        ...selection.projects,
        'packages/sdk': {
          action: 'import',
          name: 'imported-sdk',
          packageName: '@fixture/imported-sdk',
          configuration,
        },
      },
    });
    expect(
      result.rewrites.find(
        ({ source }) => source === 'packages/email/src/index.ts',
      )?.content,
    ).toContain('@fixture/imported-sdk');
    expect(
      JSON.parse(
        result.rewrites.find(
          ({ source }) => source === 'packages/email/package.json',
        )?.content ?? '{}',
      ).dependencies,
    ).toEqual({ '@fixture/imported-sdk': '^1.0.0' });
  });

  it('renames type imports, import-equals, literal dynamic imports and resolution calls without changing ordinary strings', async () => {
    const file = 'packages/email/src/types.ts';
    const input = [
      "type Sdk = import('@fixture/sdk').Sdk;",
      "import sdk = require('@fixture/sdk');",
      "const location = require.resolve('@fixture/sdk/subpath');",
      'const load = () => import(`@fixture/sdk`);',
      "const description = '@fixture/sdk';",
    ].join('\n');
    const result = await plan(
      { ...source, [file]: input },
      {
        projects: {
          ...selection.projects,
          'packages/sdk': {
            action: 'import',
            name: 'imported-sdk',
            packageName: '@fixture/imported-sdk',
            configuration,
          },
        },
      },
    );
    const content = result.rewrites.find((r) => r.source === file)?.content;
    expect(content?.match(/@fixture\/imported-sdk/g)).toHaveLength(4);
    expect(content).toContain("const description = '@fixture/sdk'");
    await expect(
      plan({ ...source, [file]: "type Sdk = import('../../sdk/src').Sdk;" }),
    ).rejects.toThrow('relative path');
  });

  it('rejects incomplete maps, occupied identities and missing build verification', async () => {
    await expect(plan(source, { projects: {} })).rejects.toThrow('Missing:');
    await expect(
      plan(source, {
        projects: {
          ...selection.projects,
          'packages/sdk': {
            action: 'import',
            name: 'imported-sdk',
            configuration,
          },
        },
      }),
    ).rejects.toThrow('collision');
    await expect(
      plan(source, {
        projects: {
          ...selection.projects,
          'packages/email': {
            action: 'import',
            name: 'email',
            configuration: { ...configuration, targets: {} },
          },
        },
      }),
    ).rejects.toThrow('build target');
  });

  it('rejects incompatible reused versions and relative imports into the discarded duplicate', async () => {
    await expect(
      plan({
        ...source,
        'packages/email/package.json': JSON.stringify({
          name: '@fixture/email',
          version: '1.0.0',
          dependencies: { '@fixture/sdk': '^2.0.0' },
        }),
      }),
    ).rejects.toThrow('does not satisfy');
    await expect(
      plan({
        ...source,
        'packages/email/src/index.ts':
          "export { version } from '../../sdk/src';",
      }),
    ).rejects.toThrow('relative path');
  });

  it('leaves non-workspace package fixtures unchanged and retains explicit verification', async () => {
    const fixture = 'packages/email/fixtures/package.json';
    expect(
      (
        await plan({ ...source, [fixture]: '{"name":"test-fixture"}' })
      ).rewrites.some((r) => r.source === fixture),
    ).toBe(false);
    await expect(
      plan({
        ...source,
        'packages/email/project.json': JSON.stringify({
          targets: { test: {} },
        }),
      }),
    ).rejects.toThrow('Retain the existing test');
    await expect(
      plan(source, {
        projects: {
          ...selection.projects,
          'packages/email': {
            action: 'import',
            name: 'email',
            configuration: { ...configuration, targets: { build: {} } },
          },
        },
      }),
    ).rejects.toThrow('explicit executor or command');
  });

  it('refuses duplicate source identities and rename destinations already declared by a consumer', async () => {
    await expect(
      plan({
        ...source,
        'packages/email/package.json':
          '{"name":"@fixture/duplicate","version":"1.0.0"}',
        'packages/sdk/package.json':
          '{"name":"@fixture/duplicate","version":"1.0.0"}',
      }),
    ).rejects.toThrow('Duplicate source');
    await expect(
      plan(
        {
          ...source,
          'packages/email/package.json': JSON.stringify({
            name: '@fixture/email',
            dependencies: {
              '@fixture/sdk': '^1.0.0',
              '@fixture/imported-sdk': '^1.0.0',
            },
          }),
        },
        {
          projects: {
            ...selection.projects,
            'packages/sdk': {
              action: 'import',
              name: 'imported-sdk',
              packageName: '@fixture/imported-sdk',
              configuration,
            },
          },
        },
      ),
    ).rejects.toThrow('already exists');
  });
});
