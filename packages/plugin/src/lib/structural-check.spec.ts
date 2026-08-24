import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectGraph } from '@nx/devkit';
import { DEFAULT_MEGAMONO_CONFIG } from './config';
import { checkWorkspaceStructure } from './structural-check';

function graph(
  featureTarget = 'shared-util',
  featurePlatform = 'node',
): ProjectGraph {
  return {
    nodes: {
      feature: {
        name: 'feature',
        type: 'lib',
        data: {
          root: 'packages/feature',
          tags: [
            'type:feature',
            'scope:product',
            `platform:${featurePlatform}`,
          ],
        },
      },
      'shared-util': {
        name: 'shared-util',
        type: 'lib',
        data: {
          root: 'packages/shared-util',
          tags: ['type:util', 'scope:shared', 'platform:node'],
        },
      },
      'other-feature': {
        name: 'other-feature',
        type: 'lib',
        data: {
          root: 'packages/other-feature',
          tags: ['type:feature', 'scope:other', 'platform:web'],
        },
      },
    },
    dependencies: {
      feature: [{ source: 'feature', target: featureTarget, type: 'static' }],
      'shared-util': [],
      'other-feature': [],
    },
  };
}

describe('workspace structural checks', () => {
  it('accepts the allowed type, scope, and platform direction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-check-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      const diagnostics = await checkWorkspaceStructure(
        root,
        graph(),
        DEFAULT_MEGAMONO_CONFIG,
      );
      expect(diagnostics).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects cross-scope, feature-to-feature, and cross-platform edges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-check-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      const diagnostics = await checkWorkspaceStructure(
        root,
        graph('other-feature', 'node'),
        DEFAULT_MEGAMONO_CONFIG,
      );
      expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
        expect.arrayContaining(['module-boundaries', 'platform-boundary']),
      );
      expect(
        diagnostics.filter(
          (diagnostic) => diagnostic.code === 'module-boundaries',
        ),
      ).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires disabled structural rules to resolve accepted decisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-check-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      const config = {
        ...DEFAULT_MEGAMONO_CONFIG,
        conventions: {
          ...DEFAULT_MEGAMONO_CONFIG.conventions,
          rules: {
            'module-boundaries': {
              severity: 'off' as const,
              decision: 'decision-20260823-disable-boundaries',
            },
          },
        },
      };
      const diagnostics = await checkWorkspaceStructure(root, graph(), config);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ code: 'rule-override-decision' }),
      );
      expect(
        await checkWorkspaceStructure(
          root,
          graph(),
          config,
          new Set(['decision-20260823-disable-boundaries']),
        ),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies accepted rule overrides and Nest feature naming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-check-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      const projectRoot = join(root, 'packages/feature');
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        join(projectRoot, 'package.json'),
        JSON.stringify({ name: '@product/feature-auth' }),
      );
      const config = {
        ...DEFAULT_MEGAMONO_CONFIG,
        conventions: {
          ...DEFAULT_MEGAMONO_CONFIG.conventions,
          rules: {
            'naming-convention': {
              severity: 'warning' as const,
            },
          },
        },
      };
      const diagnostics = await checkWorkspaceStructure(root, graph(), config);
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'naming-convention',
          severity: 'warning',
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
