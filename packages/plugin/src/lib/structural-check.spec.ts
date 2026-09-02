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

  it('can retain core package checks without enforcing unadopted project conventions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-check-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      const untagged: ProjectGraph = {
        nodes: {
          app: {
            name: 'app',
            type: 'app',
            data: { root: 'apps/app', tags: [] },
          },
        },
        dependencies: { app: [] },
      };
      expect(
        await checkWorkspaceStructure(
          root,
          untagged,
          DEFAULT_MEGAMONO_CONFIG,
          new Set(),
          new Set(['megamono-dev-only', 'playstack-direction']),
        ),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('covers every allowed and forbidden type dependency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-check-'));
    const allowed: Readonly<Record<string, readonly string[]>> = {
      app: ['app', 'feature', 'ui', 'data', 'util'],
      feature: ['ui', 'data', 'util'],
      ui: ['util'],
      data: ['util'],
      util: ['util'],
    };
    const types = Object.keys(allowed);
    try {
      await writeFile(join(root, 'package.json'), '{}');
      for (const sourceType of types) {
        for (const targetType of types) {
          const sourceIsApp = sourceType === 'app';
          const targetIsApp = targetType === 'app';
          const matrix: ProjectGraph = {
            nodes: {
              source: {
                name: 'source',
                type: sourceIsApp ? 'app' : 'lib',
                data: {
                  root: 'source',
                  tags: [
                    `type:${sourceType}`,
                    'scope:product',
                    ...(sourceIsApp ? ['visibility:internal'] : []),
                    'platform:web',
                  ],
                },
              },
              target: {
                name: 'target',
                type: targetIsApp ? 'app' : 'lib',
                data: {
                  root: 'target',
                  tags: [
                    `type:${targetType}`,
                    'scope:product',
                    ...(targetIsApp ? ['visibility:internal'] : []),
                    'platform:web',
                  ],
                },
              },
            },
            dependencies: {
              source: [{ source: 'source', target: 'target', type: 'static' }],
              target: [],
            },
          };
          const diagnostics = await checkWorkspaceStructure(
            root,
            matrix,
            DEFAULT_MEGAMONO_CONFIG,
          );
          expect(
            diagnostics.some(
              (diagnostic) => diagnostic.code === 'module-boundaries',
            ),
            `${sourceType} -> ${targetType}`,
          ).toBe(!allowed[sourceType].includes(targetType));
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enforces the complete scope and platform direction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-check-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      const cases = [
        ['scope:product', 'scope:product', 'platform:web', 'platform:web', false],
        ['scope:product', 'scope:shared', 'platform:web', undefined, false],
        ['scope:product', 'scope:other', 'platform:web', 'platform:web', true],
        ['scope:shared', 'scope:product', 'platform:web', 'platform:web', true],
        ['scope:product', 'scope:product', 'platform:web', 'platform:node', true],
        ['scope:product', 'scope:product', undefined, 'platform:web', true],
      ] as const;
      for (const [sourceScope, targetScope, sourcePlatform, targetPlatform, invalid] of cases) {
        const matrix: ProjectGraph = {
          nodes: {
            source: {
              name: 'source',
              type: 'lib',
              data: {
                root: 'source',
                tags: ['type:util', sourceScope, ...(sourcePlatform ? [sourcePlatform] : [])],
              },
            },
            target: {
              name: 'target',
              type: 'lib',
              data: {
                root: 'target',
                tags: ['type:util', targetScope, ...(targetPlatform ? [targetPlatform] : [])],
              },
            },
          },
          dependencies: {
            source: [{ source: 'source', target: 'target', type: 'static' }],
            target: [],
          },
        };
        const diagnostics = await checkWorkspaceStructure(
          root,
          matrix,
          DEFAULT_MEGAMONO_CONFIG,
        );
        expect(
          diagnostics.some((diagnostic) =>
            ['module-boundaries', 'platform-boundary'].includes(diagnostic.code),
          ),
          `${sourceScope}/${sourcePlatform ?? 'neutral'} -> ${targetScope}/${targetPlatform ?? 'neutral'}`,
        ).toBe(invalid);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires one well-formed platform-neutral theme token capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-check-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      const matrix = graph();
      matrix.nodes['shared-util'].data.tags = [
        'type:util',
        'scope:shared',
        'capability:theme-tokens',
      ];
      expect(
        await checkWorkspaceStructure(root, matrix, DEFAULT_MEGAMONO_CONFIG),
      ).toEqual([]);

      matrix.nodes['other-feature'].data.tags = [
        'type:feature',
        'scope:Other Product',
        'platform:web',
        'capability:theme-tokens',
        'capability:unknown',
      ];
      const diagnostics = await checkWorkspaceStructure(
        root,
        matrix,
        DEFAULT_MEGAMONO_CONFIG,
      );
      expect(
        diagnostics.filter((diagnostic) => diagnostic.code === 'require-tags'),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining('Invalid scope') }),
          expect.objectContaining({ message: expect.stringContaining('Unknown capability') }),
          expect.objectContaining({ message: expect.stringContaining('platform-neutral type:util') }),
          expect.objectContaining({ message: expect.stringContaining('must be unique') }),
        ]),
      );
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
