import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { logger, type ProjectGraph, type Tree } from '@nx/devkit';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEGAMONO_CONFIG } from '../../lib/config';
import {
  classifyDependency,
  type DependencyFindingIdentity,
} from '../../lib/dependency-policy-contract';
import { adoptionPolicyGenerator } from './adoption-policy';

const revision = 'a'.repeat(40);
const gitState = {
  platform: 'linux' as const,
  node: 'v24.22.1',
  revision,
  git: {
    available: true,
    clean: true,
    branch: 'feature/policy',
    defaultBranch: 'main',
  },
};
const eslint =
  "import megamonoConfig from './megamono.json' with {type:'json'};\nimport megamonoPlugin from '@megamono/plugin/eslint';\nexport default [megamonoPlugin.createConfig(megamonoConfig), consumerConfig];\n";
function graph(kind = 'implicit'): ProjectGraph {
  return {
    nodes: {
      source: {
        name: 'source',
        type: 'lib',
        data: { root: 'libs/source', tags: ['scope:shared', 'type:util'] },
      },
      target: {
        name: 'target',
        type: 'lib',
        data: { root: 'libs/target', tags: ['scope:shared', 'type:ui'] },
      },
    },
    dependencies: {
      source: [{ source: 'source', target: 'target', type: kind }],
      target: [],
    },
  };
}
function identity(value = graph()): DependencyFindingIdentity {
  const classification = classifyDependency(
    value.nodes.source,
    value.nodes.target,
    value.dependencies.source[0].type,
  );
  if (!classification) throw new Error('Expected fixture classification');
  return {
    rule: 'module-boundaries',
    constraint: 'module-boundaries:type-direction',
    source: 'source',
    target: 'target',
    classification,
  };
}
const baseline = (value = identity()) => ({
  identityVersion: 1,
  rules: ['module-boundaries'],
  entries: [
    {
      identity: value,
      reason: 'Temporary layering migration',
      reviewReference: 'review:27',
      revision,
    },
  ],
});
function seed(tree: Tree, severity: 'warning' | 'error' = 'warning') {
  tree.write(
    'megamono.json',
    JSON.stringify(
      {
        ...DEFAULT_MEGAMONO_CONFIG,
        conventions: {
          ...DEFAULT_MEGAMONO_CONFIG.conventions,
          rules: { 'module-boundaries': { severity } },
        },
        adoption: {
          ...DEFAULT_MEGAMONO_CONFIG.adoption,
          modules: ['lint'],
          ratchets: [
            {
              rule: 'module-boundaries',
              initialCount: 1,
              targetSeverity: 'error',
            },
          ],
        },
        ports: { site: 4201 },
      },
      null,
      2,
    ),
  );
  tree.write('eslint.config.mjs', eslint);
}
function policy(tree: Tree, value: unknown) {
  tree.write('.megamono/reviewed-policy.json', JSON.stringify(value));
}
const dependencies = (value = graph()) => ({
  graph: value,
  gitState,
  revisionIsAncestor: () => true,
});

describe('reviewed adoption policy workflow', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace();
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  const report = () =>
    JSON.parse(String(vi.mocked(logger.info).mock.calls.at(-1)?.[0]));

  it('reports identities by default without enrolling or modifying any file', async () => {
    seed(tree);
    const before = tree.listChanges();
    await adoptionPolicyGenerator(tree, {}, dependencies());
    expect(tree.listChanges()).toEqual(before);
    expect(report().discoveryOnly).toBe(true);
    expect(report().candidateIdentities).toHaveLength(1);
    expect(report().candidateIdentities[0]).toMatchObject({
      identity: identity(),
      baselineEligible: true,
    });
    expect(JSON.parse(tree.read('megamono.json', 'utf8') ?? '').version).toBe(
      1,
    );
  });
  it('keeps error identities visible and ineligible for baselines', async () => {
    seed(tree, 'error');
    await adoptionPolicyGenerator(tree, {}, dependencies());
    expect(report().candidateIdentities[0].baselineEligible).toBe(false);
    expect(
      report().errors.some(
        (entry: { severity: string }) => entry.severity === 'error',
      ),
    ).toBe(true);
  });
  it('requires a reviewed file and explicit legacy-count replacement', async () => {
    seed(tree);
    await expect(
      adoptionPolicyGenerator(tree, { apply: true }, dependencies()),
    ).rejects.toThrow('policyFile');
    policy(tree, { schemaVersion: 1, warningBaseline: baseline() });
    const before = tree.listChanges();
    await expect(
      adoptionPolicyGenerator(
        tree,
        { apply: true, policyFile: '.megamono/reviewed-policy.json' },
        dependencies(),
      ),
    ).rejects.toThrow('replaceLegacyRatchets');
    expect(tree.listChanges()).toEqual(before);
  });
  it('validates a dry run while preserving every file, including report output', async () => {
    seed(tree);
    policy(tree, {
      schemaVersion: 1,
      replaceLegacyRatchets: true,
      warningBaseline: baseline(),
    });
    const before = tree.listChanges();
    await adoptionPolicyGenerator(
      tree,
      {
        apply: true,
        dryRun: true,
        policyFile: '.megamono/reviewed-policy.json',
        report: '.megamono/policy-report.json',
      },
      dependencies(),
    );
    expect(report().ready).toBe(true);
    expect(tree.listChanges()).toEqual(before);
  });
  it('applies only reviewed v2 policy fields and canonical source activation', async () => {
    seed(tree);
    policy(tree, {
      schemaVersion: 1,
      replaceLegacyRatchets: true,
      warningBaseline: baseline(),
    });
    const original = JSON.parse(tree.read('megamono.json', 'utf8') ?? '');
    await adoptionPolicyGenerator(
      tree,
      { apply: true, policyFile: '.megamono/reviewed-policy.json' },
      dependencies(),
    );
    const applied = JSON.parse(tree.read('megamono.json', 'utf8') ?? '');
    expect(applied.version).toBe(2);
    expect(applied.adoption.warningBaseline).toEqual(baseline());
    expect(applied.adoption.ratchets).toEqual([]);
    expect(applied.conventions.rules).toEqual(original.conventions.rules);
    expect(applied.ports).toEqual(original.ports);
    expect(applied.packageSources).toEqual(original.packageSources);
    const source = tree.read('eslint.config.mjs', 'utf8');
    expect(source).toContain('withBoundaryAllowances(megamonoConfig, [');
    expect(source).toContain('consumerConfig');
    await adoptionPolicyGenerator(
      tree,
      { apply: true, policyFile: '.megamono/reviewed-policy.json' },
      dependencies(),
    );
    expect(tree.read('eslint.config.mjs', 'utf8')).toBe(source);
  });
  it('opts policy module-boundaries into v2 without silently adopting lint modules', async () => {
    seed(tree);
    const config = JSON.parse(tree.read('megamono.json', 'utf8') ?? '');
    config.adoption.modules = [];
    tree.write('megamono.json', JSON.stringify(config));
    policy(tree, {
      schemaVersion: 1,
      replaceLegacyRatchets: true,
      warningBaseline: baseline(),
    });
    await adoptionPolicyGenerator(
      tree,
      { apply: true, policyFile: '.megamono/reviewed-policy.json' },
      dependencies(),
    );
    expect(
      JSON.parse(tree.read('megamono.json', 'utf8') ?? '').adoption.modules,
    ).toEqual([]);
    expect(report().baselined).toHaveLength(1);
  });
  it.each([
    [
      'empty reviewed set',
      () => ({
        schemaVersion: 1,
        replaceLegacyRatchets: true,
        warningBaseline: {
          identityVersion: 1,
          rules: ['module-boundaries'],
          entries: [],
        },
      }),
      graph(),
    ],
    [
      'changed dependency kind',
      () => ({
        schemaVersion: 1,
        replaceLegacyRatchets: true,
        warningBaseline: baseline(identity(graph('implicit'))),
      }),
      graph('static'),
    ],
  ])(
    'refuses %s without partial configuration or report writes',
    async (_name, makePolicy, value) => {
      seed(tree);
      policy(tree, makePolicy());
      const before = tree.listChanges();
      await expect(
        adoptionPolicyGenerator(
          tree,
          {
            apply: true,
            policyFile: '.megamono/reviewed-policy.json',
            report: '.megamono/report.json',
          },
          dependencies(value),
        ),
      ).rejects.toThrow('Cannot validate');
      expect(tree.listChanges()).toEqual(before);
    },
  );
  it('does not consume an error with a reviewed warning entry', async () => {
    seed(tree, 'error');
    policy(tree, {
      schemaVersion: 1,
      replaceLegacyRatchets: true,
      warningBaseline: baseline(),
    });
    const before = tree.listChanges();
    await expect(
      adoptionPolicyGenerator(
        tree,
        { apply: true, policyFile: '.megamono/reviewed-policy.json' },
        dependencies(),
      ),
    ).rejects.toThrow('Cannot validate');
    expect(tree.listChanges()).toEqual(before);
  });
  it('rejects unresolved review revisions and unsupported source activation before writes', async () => {
    seed(tree);
    policy(tree, {
      schemaVersion: 1,
      replaceLegacyRatchets: true,
      warningBaseline: baseline(),
    });
    const before = tree.listChanges();
    await expect(
      adoptionPolicyGenerator(
        tree,
        { apply: true, policyFile: '.megamono/reviewed-policy.json' },
        { ...dependencies(), revisionIsAncestor: () => false },
      ),
    ).rejects.toThrow('Cannot validate');
    expect(tree.listChanges()).toEqual(before);
    tree.write('eslint.config.mjs', 'export default factory();');
    const unsupported = tree.listChanges();
    await expect(
      adoptionPolicyGenerator(
        tree,
        { apply: true, policyFile: '.megamono/reviewed-policy.json' },
        dependencies(),
      ),
    ).rejects.toThrow('Cannot validate');
    expect(tree.listChanges()).toEqual(unsupported);
  });
  it('keeps graph errors outside supported identity categories blocking', async () => {
    seed(tree);
    const value = graph();
    value.nodes.source.data.tags = [
      'scope:shared',
      'type:util',
      'platform:web',
    ];
    value.nodes.target.data.tags = ['scope:shared', 'type:ui', 'platform:node'];
    policy(tree, {
      schemaVersion: 1,
      replaceLegacyRatchets: true,
      warningBaseline: baseline(identity(value)),
    });
    const before = tree.listChanges();
    await expect(
      adoptionPolicyGenerator(
        tree,
        { apply: true, policyFile: '.megamono/reviewed-policy.json' },
        dependencies(value),
      ),
    ).rejects.toThrow('Cannot validate');
    expect(tree.listChanges()).toEqual(before);
  });
  it('requires normal mutation Git preflight and leaves policy unchanged on dirty roots', async () => {
    seed(tree);
    policy(tree, {
      schemaVersion: 1,
      replaceLegacyRatchets: true,
      warningBaseline: baseline(),
    });
    const before = tree.listChanges();
    await expect(
      adoptionPolicyGenerator(
        tree,
        { apply: true, policyFile: '.megamono/reviewed-policy.json' },
        {
          ...dependencies(),
          gitState: { ...gitState, git: { ...gitState.git, clean: false } },
        },
      ),
    ).rejects.toThrow('clean working tree');
    expect(tree.listChanges()).toEqual(before);
  });
  it('writes only an explicitly requested own report and never overwrites control files', async () => {
    seed(tree);
    await adoptionPolicyGenerator(
      tree,
      { report: '.megamono/policy-report.json' },
      dependencies(),
    );
    expect(
      JSON.parse(tree.read('.megamono/policy-report.json', 'utf8') ?? '').kind,
    ).toBe('megamono-adoption-policy-report');
    const before = tree.listChanges();
    await expect(
      adoptionPolicyGenerator(tree, { report: 'package.json' }, dependencies()),
    ).rejects.toThrow('cannot overwrite');
    expect(tree.listChanges()).toEqual(before);
  });
  it('preserves omitted v2 policies, and does not invent entries on rerun', async () => {
    seed(tree);
    policy(tree, {
      schemaVersion: 1,
      replaceLegacyRatchets: true,
      warningBaseline: baseline(),
    });
    await adoptionPolicyGenerator(
      tree,
      { apply: true, policyFile: '.megamono/reviewed-policy.json' },
      dependencies(),
    );
    const before = tree.read('megamono.json', 'utf8');
    policy(tree, { schemaVersion: 1 });
    await adoptionPolicyGenerator(
      tree,
      { apply: true, policyFile: '.megamono/reviewed-policy.json' },
      dependencies(),
    );
    expect(tree.read('megamono.json', 'utf8')).toBe(before);
  });
  it('refuses malformed or unrelated policy keys rather than changing severities', async () => {
    seed(tree);
    policy(tree, {
      schemaVersion: 1,
      conventions: { rules: { 'module-boundaries': { severity: 'warning' } } },
    });
    const before = tree.listChanges();
    await expect(
      adoptionPolicyGenerator(
        tree,
        { apply: true, policyFile: '.megamono/reviewed-policy.json' },
        dependencies(),
      ),
    ).rejects.toThrow();
    expect(tree.listChanges()).toEqual(before);
  });
  it('requires independent accepted decision authority for an exact allowance', async () => {
    seed(tree, 'error');
    const allowance = {
      source: 'source',
      target: 'target',
      constraint: 'module-boundaries:type-direction',
      classification: identity().classification,
      rationale: 'Accepted composition boundary',
      decision: 'decision-20261105-composition',
    };
    policy(tree, {
      schemaVersion: 1,
      replaceLegacyRatchets: true,
      boundaryAllowances: [allowance],
    });
    const before = tree.listChanges();
    await expect(
      adoptionPolicyGenerator(
        tree,
        { apply: true, policyFile: '.megamono/reviewed-policy.json' },
        dependencies(),
      ),
    ).rejects.toThrow('Cannot validate');
    expect(tree.listChanges()).toEqual(before);
    const root = mkdtempSync(join(tmpdir(), 'megamono-policy-authority-'));
    try {
      mkdirSync(join(root, 'docs/decisions'), { recursive: true });
      writeFileSync(
        join(root, 'docs/decisions/20261105-composition.md'),
        '---\nid: decision-20261105-composition\ntype: decision\nstatus: accepted\nvisibility: internal\nprojects: [megamono]\ntopics: [architecture]\nsummary: Reviewed composition boundary\ndate: 2026-11-05\nsupersedes: null\nreferences: []\nexternal_references: []\n---\n\n# Composition\n',
      );
      const physicalTree = new Proxy(tree, {
        get(target, key) {
          if (key === 'root') return root;
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await adoptionPolicyGenerator(
        physicalTree,
        { apply: true, policyFile: '.megamono/reviewed-policy.json' },
        dependencies(),
      );
      expect(
        JSON.parse(tree.read('megamono.json', 'utf8') ?? '').conventions
          .boundaryAllowances,
      ).toEqual([allowance]);
      expect(report().allowed).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
