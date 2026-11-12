import { ok } from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectGraph } from '@nx/devkit';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MEGAMONO_CONFIG, type MegamonoConfig } from './config';
import {
  classifyDependency,
  type BoundaryAllowance,
} from './dependency-policy-contract';
import { validateBoundaryAllowances } from './boundary-policy';
import { analyzeWorkspaceStructure } from './structural-check';

function requiredClassification(
  graph: ProjectGraph,
  kind: 'static' | 'dynamic' | 'implicit' = 'static',
) {
  const result = classifyDependency(
    graph.nodes.source,
    graph.nodes.target,
    kind,
  );
  ok(
    result,
    'The test fixture must have a supported dependency classification.',
  );
  return result;
}
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
export function boundaryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'megamono-boundary-policy-'));
  roots.push(root);
  const graph: ProjectGraph = {
    nodes: {
      source: {
        name: 'source',
        type: 'lib',
        data: {
          root: 'packages/source',
          tags: ['type:ui', 'scope:one', 'platform:node'],
        },
      },
      target: {
        name: 'target',
        type: 'lib',
        data: {
          root: 'packages/target',
          tags: ['type:data', 'scope:two', 'platform:node'],
        },
      },
    },
    dependencies: {
      source: [{ source: 'source', target: 'target', type: 'static' }],
      target: [],
    },
  };
  const decision = 'decision-20261105-explicit-boundary';
  const data = {
    id: decision,
    type: 'decision',
    status: 'accepted',
    visibility: 'internal',
    projects: ['source', 'target'],
    topics: [],
    summary: 'Exact review',
    date: '2026-11-05',
    supersedes: null,
    references: [],
    external_references: [],
  };
  const writeDecision = (changes = {}, file = 'review.md') => {
    mkdirSync(join(root, 'docs/decisions'), { recursive: true });
    writeFileSync(
      join(root, 'docs/decisions', file),
      `---\n${Object.entries({ ...data, ...changes })
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join('\n')}\n---\nReviewed.\n`,
    );
  };
  writeDecision();
  const allowance: BoundaryAllowance = {
    source: 'source',
    target: 'target',
    constraint: 'module-boundaries:type-direction',
    classification: requiredClassification(graph, 'static'),
    rationale: 'Reviewed data dependency',
    decision,
  };
  const config: MegamonoConfig = {
    ...DEFAULT_MEGAMONO_CONFIG,
    version: 2,
    conventions: {
      ...DEFAULT_MEGAMONO_CONFIG.conventions,
      boundaryAllowances: [allowance],
    },
  };
  return { root, graph, config, allowance, writeDecision };
}

describe('exact reviewed boundary allowances', () => {
  it('removes only the selected constraint and retains raw identity/severity', async () => {
    const { root, graph, config, allowance } = boundaryFixture();
    const result = await analyzeWorkspaceStructure(root, graph, config);
    expect(result.allowed).toEqual([
      {
        diagnostic: expect.objectContaining({
          code: 'module-boundaries',
          identity: expect.objectContaining({
            constraint: allowance.constraint,
          }),
        }),
        allowance,
      },
    ]);
    expect(
      result.rawDiagnostics.filter((d) => d.code === 'module-boundaries'),
    ).toHaveLength(2);
    expect(
      result.diagnostics.filter((d) => d.code === 'module-boundaries'),
    ).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({
          constraint: 'module-boundaries:scope-direction',
        }),
      }),
    ]);
  });
  it.each(['dynamic', 'implicit'])(
    'does not extend a static allowance to a %s import',
    (kind) => {
      const { root, graph, config } = boundaryFixture();
      graph.dependencies.source[0].type = kind;
      expect(validateBoundaryAllowances(root, graph, config)).toMatchObject({
        valid: [],
        diagnostics: [
          expect.objectContaining({ code: 'boundary-allowance-invalid' }),
        ],
      });
    },
  );
  it.each(['project', 'tags', 'kind', 'stale'])('rejects %s drift', (drift) => {
    const { root, graph, config } = boundaryFixture();
    if (drift === 'project') delete graph.nodes.target;
    if (drift === 'tags') {
      ok(graph.nodes.target.data.tags);
      graph.nodes.target.data.tags.push('role:service');
    }
    if (drift === 'kind') graph.nodes.target.type = 'app';
    if (drift === 'stale')
      graph.nodes.source.data.tags = [
        'type:feature',
        'scope:one',
        'platform:node',
      ];
    expect(validateBoundaryAllowances(root, graph, config).valid).toEqual([]);
  });
  it.each(['proposed', 'superseded', 'duplicate', 'malformed', 'archived'])(
    'requires independent active accepted decision metadata: %s',
    (state) => {
      const f = boundaryFixture();
      if (state === 'proposed') f.writeDecision({ status: 'proposed' });
      if (state === 'superseded')
        f.writeDecision(
          {
            id: 'decision-20261105-replacement',
            supersedes: f.allowance.decision,
          },
          'replacement.md',
        );
      if (state === 'duplicate') f.writeDecision({}, 'duplicate.md');
      if (state === 'malformed') f.writeDecision({ projects: [] });
      if (state === 'archived') {
        mkdirSync(join(f.root, 'docs/archives/decisions'), { recursive: true });
        writeFileSync(
          join(f.root, 'docs/archives/decisions/review.md'),
          readFileSync(join(f.root, 'docs/decisions/review.md')),
        );
        rmSync(join(f.root, 'docs/decisions/review.md'));
      }
      expect(
        validateBoundaryAllowances(f.root, f.graph, f.config).valid,
      ).toEqual([]);
    },
  );
  it('fails closed for duplicate/raw malformed/v1 policies without partial allowances', () => {
    const f = boundaryFixture();
    for (const config of [
      { ...f.config, version: 1 },
      {
        ...f.config,
        conventions: {
          ...f.config.conventions,
          boundaryAllowances: [f.allowance, f.allowance],
        },
      },
      {
        ...f.config,
        conventions: {
          ...f.config.conventions,
          boundaryAllowances: [
            f.allowance,
            { ...f.allowance, target: 'missing' },
          ],
        },
      },
    ]) {
      const result = validateBoundaryAllowances(
        f.root,
        f.graph,
        config as MegamonoConfig,
      );
      expect(result.valid).toEqual([]);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });
  it('retains platform, tag, and Playstack findings alongside a reviewed type direction', async () => {
    const f = boundaryFixture();
    f.graph.nodes.target.data.tags = ['type:data', 'scope:two', 'platform:web'];
    f.allowance.classification = requiredClassification(f.graph, 'static');
    const result = await analyzeWorkspaceStructure(f.root, f.graph, f.config);
    expect(result.allowed).toHaveLength(1);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'platform-boundary' }),
    );
  });
  it('does not trust a caller accepted-ID set when the record is inactive', async () => {
    const f = boundaryFixture();
    f.writeDecision({ status: 'proposed' });
    const result = await analyzeWorkspaceStructure(
      f.root,
      f.graph,
      f.config,
      new Set([f.allowance.decision]),
    );
    expect(result.allowed).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'boundary-allowance-invalid' }),
    );
  });
  it('never evaluates JavaScript frontmatter engines while authorizing a decision', () => {
    const f = boundaryFixture();
    const marker = join(f.root, 'executed');
    writeFileSync(
      join(f.root, 'docs/decisions/review.md'),
      `---js
(require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), {id:${JSON.stringify(f.allowance.decision)},type:'decision',status:'accepted'})
---
`,
    );
    expect(validateBoundaryAllowances(f.root, f.graph, f.config).valid).toEqual(
      [],
    );
    expect(existsSync(marker)).toBe(false);
  });
  it('does not accept decision metadata through a symlinked decision directory', () => {
    const f = boundaryFixture();
    const copy = readFileSync(join(f.root, 'docs/decisions/review.md'));
    const external = join(f.root, 'elsewhere');
    mkdirSync(external);
    writeFileSync(join(external, 'review.md'), copy);
    rmSync(join(f.root, 'docs/decisions'), { recursive: true });
    symlinkSync(external, join(f.root, 'docs/decisions'), 'junction');
    expect(validateBoundaryAllowances(f.root, f.graph, f.config).valid).toEqual(
      [],
    );
  });
  it.each(['node_modules/foreign', '.yalc/foreign'])(
    'does not authorize an installed graph copy at %s',
    (root) => {
      const f = boundaryFixture();
      f.graph.nodes.target.data.root = root;
      expect(
        validateBoundaryAllowances(f.root, f.graph, f.config),
      ).toMatchObject({
        valid: [],
        diagnostics: [
          expect.objectContaining({ code: 'boundary-allowance-invalid' }),
        ],
      });
    },
  );
});
