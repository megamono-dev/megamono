import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MEGAMONO_CONFIG,
  getTopicVocabulary,
  megamonoConfigSchema,
  readMegamonoConfig,
} from './config';

describe('Megamono configuration', () => {
  it('parses the default configuration and exposes built-in topics', () => {
    const config = megamonoConfigSchema.parse(DEFAULT_MEGAMONO_CONFIG);
    expect(config.version).toBe(1);
    expect(config.services.requirements).toEqual({});
    expect(getTopicVocabulary(config)).toContain('architecture');
  });

  it('accepts pinned service requirements and rejects unknown service keys', () => {
    expect(
      megamonoConfigSchema.parse({
        ...DEFAULT_MEGAMONO_CONFIG,
        services: { runner: 'none', requirements: { postgres: '17' } },
      }).services.requirements,
    ).toEqual({ postgres: '17' });
    expect(
      megamonoConfigSchema.safeParse({
        ...DEFAULT_MEGAMONO_CONFIG,
        services: { runner: 'none', requirements: { mysql: '9' } },
      }).success,
    ).toBe(false);
  });

  it('rejects built-in topic duplicates and disabled rules without decisions', () => {
    const result = megamonoConfigSchema.safeParse({
      ...DEFAULT_MEGAMONO_CONFIG,
      topics: { extend: ['architecture'] },
      conventions: {
        ...DEFAULT_MEGAMONO_CONFIG.conventions,
        rules: { 'module-boundaries': { severity: 'off' } },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('duplicates the built-in vocabulary'),
          expect.stringContaining('must reference an accepted decision'),
        ]),
      );
    }
  });

  it('allows warning-only rules to be disabled without a decision', () => {
    expect(
      megamonoConfigSchema.parse({
        ...DEFAULT_MEGAMONO_CONFIG,
        conventions: {
          ...DEFAULT_MEGAMONO_CONFIG.conventions,
          rules: { 'no-bare-jsx-strings': { severity: 'off' } },
        },
      }).conventions.rules,
    ).toEqual({ 'no-bare-jsx-strings': { severity: 'off' } });
  });

  it('loads a workspace-relative configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-config-'));
    try {
      await mkdir(join(root, 'config'));
      await writeFile(
        join(root, 'config', 'megamono.json'),
        JSON.stringify(DEFAULT_MEGAMONO_CONFIG),
      );
      const config = await readMegamonoConfig(root, 'config/megamono.json');
      expect(config.conventions.packageManager).toBe('npm');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unknown versions with an actionable migration instruction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-config-version-'));
    try {
      await writeFile(
        join(root, 'megamono.json'),
        JSON.stringify({ ...DEFAULT_MEGAMONO_CONFIG, version: 2 }),
      );
      await expect(readMegamonoConfig(root)).rejects.toThrow(
        /Unsupported Megamono configuration version 2.*supports version 1.*documented configuration migration/s,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects documentation roots that escape the workspace', () => {
    expect(
      megamonoConfigSchema.safeParse({
        ...DEFAULT_MEGAMONO_CONFIG,
        docs: { ...DEFAULT_MEGAMONO_CONFIG.docs, root: '../docs' },
      }).success,
    ).toBe(false);
  });

  it('rejects wildcard health suppression fingerprints', () => {
    expect(
      megamonoConfigSchema.safeParse({
        ...DEFAULT_MEGAMONO_CONFIG,
        health: {
          ...DEFAULT_MEGAMONO_CONFIG.health,
          suppressions: [
            {
              check: 'dependency-alignment',
              fingerprint: 'react:*',
              decision: 'decision-20260823-react-split',
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
