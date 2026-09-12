import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectGraph } from '@nx/devkit';
import { repositoryOwnedGraph } from './repository-graph';
import { checkWorkspaceStructure } from './structural-check';
import { runRepositoryHealth } from './health';
import { DEFAULT_MEGAMONO_CONFIG } from './config';

describe('repository-owned graph', () => {
  it('excludes nested dependency copies, preserving real packages, external edges and the original graph', () => {
    const roots = {
      app: 'apps/app',
      vendor: '.yalc/@megamono/plugin',
      nested: 'apps/app/node_modules/local',
      windows: 'apps\\app\\.yalc\\local',
      real: 'packages/yalc-tools',
    };
    const graph: ProjectGraph = {
      nodes: Object.fromEntries(
        Object.entries(roots).map(([name, root]) => [
          name,
          { name, type: 'lib', data: { root } },
        ]),
      ),
      dependencies: {
        app: [
          { source: 'app', target: 'vendor', type: 'static' },
          { source: 'app', target: 'npm:react', type: 'static' },
          { source: 'app', target: 'real', type: 'static' },
        ],
        vendor: [],
      },
      externalNodes: {
        'npm:react': {
          name: 'npm:react',
          type: 'npm',
          data: { version: '19.0.0', packageName: 'react' },
        },
      },
    };
    const filtered = repositoryOwnedGraph(graph);
    expect(Object.keys(filtered.nodes)).toEqual(['app', 'real']);
    expect(filtered.dependencies.app.map((edge) => edge.target)).toEqual([
      'npm:react',
      'real',
    ]);
    expect(filtered.externalNodes).toEqual(graph.externalNodes);
    expect(Object.keys(graph.nodes)).toHaveLength(5);
    expect(graph.dependencies.app).toHaveLength(3);
  });

  it('does not lint or align third-party copies, but retains consumer hygiene and real orphan findings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repository-graph-'));
    try {
      await mkdir(join(root, '.yalc/plugin'), { recursive: true });
      await mkdir(join(root, 'packages/unused'), { recursive: true });
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          dependencies: {
            tslib: '^2.8.1',
            '@megamono/plugin': 'file:.yalc/plugin',
          },
        }),
      );
      await writeFile(
        join(root, '.yalc/plugin/package.json'),
        JSON.stringify({ dependencies: { tslib: '^2.3.0' } }),
      );
      await writeFile(
        join(root, 'packages/unused/package.json'),
        JSON.stringify({ private: true }),
      );
      const graph: ProjectGraph = {
        nodes: {
          vendor: {
            name: 'vendor',
            type: 'lib',
            data: { root: '.yalc/plugin' },
          },
          unused: {
            name: 'unused',
            type: 'lib',
            data: {
              root: 'packages/unused',
              tags: ['type:util', 'scope:shared'],
            },
          },
        },
        dependencies: { vendor: [], unused: [] },
      };
      const diagnostics = await checkWorkspaceStructure(
        root,
        graph,
        DEFAULT_MEGAMONO_CONFIG,
      );
      expect(diagnostics.some((d) => d.code === 'require-tags')).toBe(false);
      expect(diagnostics.some((d) => d.code === 'megamono-dev-only')).toBe(
        true,
      );
      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph,
        config: DEFAULT_MEGAMONO_CONFIG,
        documents: [],
        checks: ['dependency-alignment', 'orphaned-libraries'],
      });
      expect(
        report.findings.filter((f) => f.check === 'dependency-alignment'),
      ).toEqual([]);
      expect(
        report.findings
          .filter((f) => f.check === 'orphaned-libraries')
          .map((f) => f.fingerprint),
      ).toEqual(['unused']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
