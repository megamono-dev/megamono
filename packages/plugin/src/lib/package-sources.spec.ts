import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MEGAMONO_CONFIG } from './config';
import {
  parsePackageRegistries,
  renderPackageRegistrySection,
  validatePackageSources,
} from './package-sources';

const pnpmConfig = {
  ...DEFAULT_MEGAMONO_CONFIG,
  conventions: {
    ...DEFAULT_MEGAMONO_CONFIG.conventions,
    packageManager: 'pnpm' as const,
  },
};

describe('package source contracts', () => {
  it('normalizes HTTPS registry mappings and rejects insecure routes', () => {
    const registries = parsePackageRegistries(
      JSON.stringify({
        '@playstack': 'https://npm.example.test/playstack/',
        '@megamono': 'https://npm.example.test/megamono',
      }),
    );
    expect(registries).toEqual({
      '@megamono': 'https://npm.example.test/megamono',
      '@playstack': 'https://npm.example.test/playstack',
    });
    expect(renderPackageRegistrySection(registries)).toContain(
      '@playstack:registry=https://npm.example.test/playstack',
    );
    expect(() =>
      parsePackageRegistries('{"@megamono":"http://registry.test"}'),
    ).toThrow(/HTTPS/);
  });

  it('accepts frozen registry installs and rejects yalc state in CI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-package-sources-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          dependencies: { '@megamono/plugin': '^1.0.0' },
        }),
      );
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      await writeFile(
        join(root, '.npmrc'),
        '@megamono:registry=https://npm.example.test/megamono\n',
      );
      const config = {
        ...pnpmConfig,
        packageSources: {
          registries: {
            '@megamono': 'https://npm.example.test/megamono',
          },
          forbidLocalInCi: true,
        },
      };
      expect(await validatePackageSources(root, config)).toEqual([]);

      await mkdir(join(root, '.yalc'));
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          dependencies: { '@megamono/plugin': 'file:.yalc/@megamono/plugin' },
        }),
      );
      expect(
        (await validatePackageSources(root, config)).map(({ code }) => code),
      ).toEqual(
        expect.arrayContaining([
          'package-sources-local-state',
          'package-sources-local-dependency',
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds local package sources hidden in manager overrides and catalogs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-package-overrides-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          overrides: { '@playstack/core': 'file:.yalc/@playstack/core' },
          resolutions: { '@playstack/cache': 'link:../playstack/cache' },
          pnpm: {
            overrides: {
              '@postkit/react': 'portal:../postkit/react',
            },
          },
        }),
      );
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      await writeFile(
        join(root, 'pnpm-workspace.yaml'),
        `packages: []
overrides:
  '@postkit/core': file:.yalc/@postkit/core
catalogs:
  local:
    '@playstack/storage': link:../playstack/storage
`,
      );

      const diagnostics = await validatePackageSources(root, pnpmConfig);
      expect(
        diagnostics.map(({ path, message }) => `${path}: ${message}`),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining('package.json: overrides.@playstack/core'),
          expect.stringContaining('package.json: resolutions.@playstack/cache'),
          expect.stringContaining(
            'package.json: pnpm.overrides.@postkit/react',
          ),
          expect.stringContaining(
            'pnpm-workspace.yaml: overrides.@postkit/core',
          ),
          expect.stringContaining(
            'pnpm-workspace.yaml: catalogs.local.@playstack/storage',
          ),
        ]),
      );
      expect(
        diagnostics.every(
          ({ code }) => code === 'package-sources-local-dependency',
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts existing versioned tarballs that remain inside the repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-package-tarballs-'));
    try {
      await mkdir(join(root, 'apps/site'), { recursive: true });
      await mkdir(join(root, 'vendor'), { recursive: true });
      await writeFile(
        join(root, 'vendor/playstack-core-0.1.0-beta.1.tgz'),
        'immutable fixture',
      );
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          dependencies: {
            '@playstack/core': 'file:./vendor/playstack-core-0.1.0-beta.1.tgz',
          },
        }),
      );
      await writeFile(
        join(root, 'apps/site/package.json'),
        JSON.stringify({
          dependencies: {
            '@playstack/core':
              'file:../../vendor/playstack-core-0.1.0-beta.1.tgz',
          },
        }),
      );
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      await writeFile(
        join(root, 'pnpm-workspace.yaml'),
        `packages:
  - apps/*
overrides:
  '@playstack/core': file:./vendor/playstack-core-0.1.0-beta.1.tgz
`,
      );

      expect(await validatePackageSources(root, pnpmConfig)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects local directories, unversioned archives, missing archives, and paths outside the repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-package-files-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          dependencies: {
            directory: 'file:./packages/directory',
            unversioned: 'file:./vendor/package.tgz',
            missing: 'file:./vendor/package-1.0.0.tgz',
            outside: 'file:../package-1.0.0.tgz',
          },
        }),
      );
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

      const messages = (await validatePackageSources(root, pnpmConfig)).map(
        ({ message }) => message,
      );
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Local package directories'),
          expect.stringContaining('exact semantic version'),
          expect.stringContaining('tarball does not exist'),
          expect.stringContaining('resolve inside the workspace'),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when pnpm package-source configuration is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-package-yaml-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      await writeFile(join(root, 'pnpm-workspace.yaml'), 'overrides: [\n');

      expect(await validatePackageSources(root, pnpmConfig)).toContainEqual(
        expect.objectContaining({
          code: 'package-sources-config',
          path: 'pnpm-workspace.yaml',
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
