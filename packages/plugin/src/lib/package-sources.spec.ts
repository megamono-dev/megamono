import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MEGAMONO_CONFIG } from './config';
import {
  parsePackageRegistries,
  renderPackageRegistrySection,
  validatePackageSources,
} from './package-sources';

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
        ...DEFAULT_MEGAMONO_CONFIG,
        conventions: {
          ...DEFAULT_MEGAMONO_CONFIG.conventions,
          packageManager: 'pnpm' as const,
        },
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
});
