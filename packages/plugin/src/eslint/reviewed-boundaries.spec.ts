import { ok } from 'node:assert/strict';
import type { ProjectGraph } from '@nx/devkit';
import nxPlugin from '@nx/eslint-plugin';
import { Linter, type ESLint, type Rule } from 'eslint';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEGAMONO_CONFIG, type MegamonoConfig } from '../lib/config';
import {
  classifyDependency,
  type BoundaryAllowance,
} from '../lib/dependency-policy-contract';
import {
  createReviewedBoundaryRule,
  withBoundaryAllowances,
} from './reviewed-boundaries';

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
const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(kind: 'static' | 'dynamic' = 'static') {
  const root = mkdtempSync(join(tmpdir(), 'megamono-reviewed-eslint-'));
  roots.push(root);
  const graph: ProjectGraph = {
    nodes: {
      source: {
        name: 'source',
        type: 'lib',
        data: {
          root: 'packages/source',
          tags: ['type:ui', 'scope:one', 'platform:node'],
          targets: { build: { executor: '@nx/js:tsc' } },
        },
      },
      target: {
        name: 'target',
        type: 'lib',
        data: {
          root: 'packages/target',
          tags: ['type:data', 'scope:two', 'platform:node'],
          targets: { build: { executor: '@nx/js:tsc' } },
        },
      },
    },
    dependencies: {
      source: [{ source: 'source', target: 'target', type: kind }],
      target: [],
    },
  };
  for (const name of ['source', 'target']) {
    mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify({
        name: `@fixture/${name}`,
        version: '1.0.0',
        main: 'src/index.js',
      }),
    );
    writeFileSync(
      join(root, 'packages', name, 'src/index.js'),
      'export const value=1;',
    );
  }
  mkdirSync(join(root, 'docs/decisions'), { recursive: true });
  const decision = 'decision-20261105-reviewed-import';
  const data = {
    id: decision,
    type: 'decision',
    status: 'accepted',
    visibility: 'internal',
    projects: ['source', 'target'],
    topics: [],
    summary: 'Explicit import',
    date: '2026-11-05',
    supersedes: null,
    references: [],
    external_references: [],
  };
  writeFileSync(
    join(root, 'docs/decisions/review.md'),
    `---\n${Object.entries(data)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n')}\n---\nReviewed.`,
  );
  const allowances: BoundaryAllowance[] = (
    [
      'module-boundaries:type-direction',
      'module-boundaries:scope-direction',
    ] as const
  ).map((constraint) => ({
    source: 'source',
    target: 'target',
    constraint,
    classification: requiredClassification(graph, kind),
    rationale: 'Explicit reviewed import',
    decision,
  }));
  const config: MegamonoConfig = {
    ...DEFAULT_MEGAMONO_CONFIG,
    version: 2,
    conventions: {
      ...DEFAULT_MEGAMONO_CONFIG.conventions,
      boundaryAllowances: allowances,
    },
  };
  writeFileSync(join(root, 'megamono.json'), JSON.stringify(config));
  writeFileSync(join(root, 'nx.json'), '{}');
  writeFileSync(
    join(root, 'tsconfig.base.json'),
    JSON.stringify({
      compilerOptions: {
        paths: { '@fixture/target': ['packages/target/src/index.js'] },
        moduleResolution: 'bundler',
        module: 'ESNext',
      },
    }),
  );
  // Exercise the actual installed Nx rule against an isolated cached graph.
  vi.stubGlobal('projectGraph', graph);
  vi.stubGlobal(
    'projectRootMappings',
    new Map([
      ['packages/source', 'source'],
      ['packages/target', 'target'],
    ]),
  );
  vi.stubGlobal('projectFileMap', { source: [], target: [] });
  vi.stubGlobal('workspaceLayout', { appsDir: 'apps', libsDir: 'packages' });
  vi.stubGlobal('projectPath', root);
  vi.stubGlobal('targetProjectLocator', {
    findProjectFromImport: (specifier: string) =>
      specifier === '@fixture/target' ? 'target' : undefined,
  });
  process.argv = [process.execPath, '/node_modules/eslint/bin/eslint.js'];
  const delegate = nxPlugin.rules[
    'enforce-module-boundaries'
  ] as unknown as Rule.RuleModule;
  const options = {
    enforceBuildableLibDependency: true,
    depConstraints: [
      { sourceTag: 'type:ui', onlyDependOnLibsWithTags: ['type:util'] },
      {
        sourceTag: 'scope:one',
        onlyDependOnLibsWithTags: ['scope:one', 'scope:shared'],
      },
    ],
  };
  const lint = (code: string, overrides: Record<string, unknown> = {}) =>
    new Linter({ cwd: root }).verify(
      code,
      [
        {
          files: ['**/*.js'],
          plugins: {
            reviewed: {
              rules: {
                boundaries: createReviewedBoundaryRule(
                  delegate,
                  config,
                  () => graph,
                ),
              },
            },
          },
          rules: {
            'reviewed/boundaries': ['error', { ...options, ...overrides }],
          },
        },
      ],
      { filename: join(root, 'packages/source/src/index.js') },
    );
  return { root, graph, config, allowances, delegate, options, lint };
}

describe('reviewed source boundaries with real Nx delegation', () => {
  it.each(['static', 'dynamic'] as const)(
    'allows only a matching reviewed %s alias import',
    (kind) => {
      const f = fixture(kind);
      expect(
        f.lint(
          kind === 'static'
            ? "import {value} from '@fixture/target';"
            : "const value=import('@fixture/target');",
        ),
      ).toEqual([]);
    },
  );
  it('does not extend a static decision to a dynamic import', () => {
    const f = fixture();
    expect(f.lint("const value=import('@fixture/target');")).toContainEqual(
      expect.objectContaining({ messageId: 'direction' }),
    );
  });
  it('keeps cross-project relative-import safety even for a matching allowance', () => {
    const f = fixture();
    expect(
      f.lint("import {value} from '../../target/src/index.js';"),
    ).toContainEqual(
      expect.objectContaining({
        messageId: 'noRelativeOrAbsoluteImportsAcrossLibraries',
      }),
    );
  });
  it('keeps same-edge platform constraints after an allowed type/scope constraint', () => {
    const f = fixture();
    f.graph.nodes.target.data.tags = ['type:data', 'scope:two', 'platform:web'];
    for (const a of f.allowances)
      a.classification = requiredClassification(f.graph, 'static');
    const messages = f.lint("import {value} from '@fixture/target';", {
      depConstraints: [
        ...f.options.depConstraints,
        {
          sourceTag: 'platform:node',
          onlyDependOnLibsWithTags: ['platform:node'],
        },
      ],
    });
    expect(messages).toContainEqual(
      expect.objectContaining({
        messageId: 'onlyTagsConstraintViolation',
        message: expect.stringContaining('platform:node'),
      }),
    );
  });
  it('keeps custom stricter scope policies rather than broadening their tags', () => {
    const f = fixture();
    const messages = f.lint("import {value} from '@fixture/target';", {
      depConstraints: [
        f.options.depConstraints[0],
        { sourceTag: 'scope:one', onlyDependOnLibsWithTags: ['scope:one'] },
      ],
    });
    expect(messages).toContainEqual(
      expect.objectContaining({
        messageId: 'onlyTagsConstraintViolation',
        message: expect.stringContaining('scope:one'),
      }),
    );
  });
  it('preserves a same-constraint negative-tag restriction after expanding only the canonical positive tags', () => {
    const f = fixture();
    const messages = f.lint("import {value} from '@fixture/target';", {
      depConstraints: [
        {
          ...f.options.depConstraints[0],
          notDependOnLibsWithTags: ['type:data'],
        },
        f.options.depConstraints[1],
      ],
    });
    expect(messages).toContainEqual(
      expect.objectContaining({ messageId: 'notTagsConstraintViolation' }),
    );
  });
  it('keeps buildable-library checks and original Nx options', () => {
    const f = fixture();
    f.graph.nodes.target.data.targets = {};
    expect(f.lint("import {value} from '@fixture/target';")).toContainEqual(
      expect.objectContaining({ messageId: 'noImportOfNonBuildableLibraries' }),
    );
  });
  it('fails closed for stale graph classifications and invalid decision metadata', () => {
    const f = fixture();
    writeFileSync(
      join(f.root, 'docs/decisions/review.md'),
      '---js\nthrow new Error("must not execute")\n---\n',
    );
    const messages = f.lint("import {value} from '@fixture/target';");
    expect(messages).toContainEqual(
      expect.objectContaining({ messageId: 'reviewedPolicy' }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ messageId: 'direction' }),
    );
  });
  it('transfers exact options from existing Nx flat configs without mutating plugins or entries', () => {
    const f = fixture();
    const entries = [
      {
        // @nx/eslint-plugin types its legacy configs' ecmaVersion as number.
        plugins: { '@nx': nxPlugin as unknown as ESLint.Plugin },
        rules: {
          '@nx/enforce-module-boundaries': ['warn', f.options] as [
            'warn',
            typeof f.options,
          ],
          'no-debugger': 'error' as const,
        },
      },
    ];
    const result = withBoundaryAllowances(f.config, entries);
    expect(result[1].rules?.['megamono-reviewed/module-boundaries']).toEqual([
      'warn',
      f.options,
    ]);
    expect(result[1].rules?.['no-debugger']).toBe('error');
    expect(entries[0].rules['@nx/enforce-module-boundaries']).toEqual([
      'warn',
      f.options,
    ]);
    expect(nxPlugin.rules['enforce-module-boundaries']).toBe(f.delegate);
    expect(result[0].rules?.['@nx/enforce-module-boundaries']).toBe('off');
  });
  it('leaves v1 config and optional dependency loading unchanged', () => {
    const entries = [{ rules: { 'no-debugger': 'error' as const } }];
    expect(withBoundaryAllowances(DEFAULT_MEGAMONO_CONFIG, entries)).toEqual(
      entries,
    );
  });
});
