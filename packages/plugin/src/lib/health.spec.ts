import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectGraph } from '@nx/devkit';
import { DEFAULT_MEGAMONO_CONFIG, type MegamonoConfig } from './config';
import type { RepositoryDocument } from './docs';
import {
  collectHealthGitState,
  HealthConfigurationError,
  runRepositoryHealth,
  serializeHealthReport,
} from './health';
import { hashArtifactBytes, renderArtifactRegistry } from './managed-artifacts';

const executeFile = promisify(execFile);

function projectGraph(): ProjectGraph {
  return {
    nodes: {
      app: {
        name: 'app',
        type: 'app',
        data: { root: 'apps/app', tags: ['type:app'] },
      },
      util: {
        name: 'util',
        type: 'lib',
        data: { root: 'packages/util', tags: ['type:util'] },
      },
    },
    dependencies: { app: [], util: [] },
  };
}

function document(
  root: string,
  values: Partial<RepositoryDocument['data']> &
    Pick<RepositoryDocument['data'], 'id' | 'type' | 'status'>,
): RepositoryDocument {
  return {
    absolutePath: join(root, `${values.id}.md`),
    relativePath: `${values.type}s/${values.id}.md`,
    archived: false,
    content: '',
    data: {
      visibility: 'internal',
      projects: ['app'],
      topics: [],
      summary: values.id,
      date: '2026-01-01',
      supersedes: null,
      references: [],
      external_references: [],
      ...values,
    },
  };
}

describe('repository health', () => {
  it('distinguishes zero findings from disabled and unselected check families', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-coverage-'));
    try {
      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph: { nodes: {}, dependencies: {} },
        config: {
          ...DEFAULT_MEGAMONO_CONFIG,
          health: {
            ...DEFAULT_MEGAMONO_CONFIG.health,
            checks: { 'dependency-alignment': false },
          },
        },
        documents: [],
        checks: ['dependency-alignment', 'orphaned-libraries'],
      });
      expect(report.findings).toEqual([]);
      expect(report.coverage['dependency-alignment']).toEqual({
        status: 'skipped',
        reason: 'disabled',
      });
      expect(report.coverage['spec-drift']).toEqual({
        status: 'skipped',
        reason: 'not-selected',
      });
      expect(report.coverage['orphaned-libraries']).toEqual({
        status: 'completed',
      });
      expect(report.readiness).toBe('not-assessed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('recognizes resolved workspace shorthand without hiding missing or conflicting locators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-workspace-ranges-'));
    try {
      await mkdir(join(root, 'apps/app'), { recursive: true });
      await mkdir(join(root, 'packages/util'), { recursive: true });
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { '@acme/util': 'workspace:*' } }),
      );
      await writeFile(
        join(root, 'packages/util/package.json'),
        JSON.stringify({ name: '@acme/util', version: '0.5.0' }),
      );
      const check = () =>
        runRepositoryHealth({
          workspaceRoot: root,
          graph: projectGraph(),
          config: DEFAULT_MEGAMONO_CONFIG,
          documents: [],
          checks: ['dependency-alignment'],
        });
      for (const range of ['workspace:^', 'workspace:~']) {
        await writeFile(
          join(root, 'apps/app/package.json'),
          JSON.stringify({ dependencies: { '@acme/util': range } }),
        );
        expect((await check()).findings).toEqual([]);
      }
      for (const range of ['workspace:^1.0.0', '^1.0.0', 'workspace:other@*']) {
        await writeFile(
          join(root, 'apps/app/package.json'),
          JSON.stringify({ dependencies: { '@acme/util': range } }),
        );
        expect((await check()).findings).toHaveLength(1);
      }
      await writeFile(
        join(root, 'apps/app/package.json'),
        JSON.stringify({ dependencies: { '@acme/util': 'workspace:^' } }),
      );
      for (const manifest of [
        {},
        { name: '@acme/util' },
        { name: '@acme/util', version: 'invalid' },
      ]) {
        await writeFile(
          join(root, 'packages/util/package.json'),
          JSON.stringify(manifest),
        );
        expect((await check()).findings).toHaveLength(1);
      }
      await writeFile(
        join(root, 'packages/util/package.json'),
        JSON.stringify({ name: '@acme/util', version: '0.5.0' }),
      );
      await writeFile(
        join(root, 'apps/app/package.json'),
        JSON.stringify({
          name: '@acme/util',
          version: '0.5.0',
          dependencies: { '@acme/util': 'workspace:^' },
        }),
      );
      expect((await check()).findings).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('emits stable findings for all five checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-'));
    try {
      await mkdir(join(root, 'apps/app'), { recursive: true });
      await mkdir(join(root, 'packages/util'), { recursive: true });
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      );
      await writeFile(
        join(root, 'apps/app/package.json'),
        JSON.stringify({
          dependencies: { react: '^18.0.0', '@sentry/node': '9.0.0' },
        }),
      );
      await writeFile(join(root, 'packages/util/package.json'), '{}');
      await writeFile(
        join(root, 'apps/app/.megamono-integration.json'),
        JSON.stringify({
          integration: 'sentry',
          sdk: '@sentry/node',
          sdkRange: '8.0.0',
          templateRevision: 1,
        }),
      );
      await writeFile(join(root, 'nx.json'), JSON.stringify({ plugins: [] }));
      const plan = document(root, {
        id: 'plan-app-20260101-old',
        type: 'plan',
        status: 'backlog',
      });
      await writeFile(plan.absolutePath, 'old');
      await utimes(
        plan.absolutePath,
        new Date('2026-01-01'),
        new Date('2026-01-01'),
      );
      const documents = [
        document(root, {
          id: 'spec-app-0001',
          type: 'spec',
          status: 'accepted',
          projects: ['missing'],
        }),
        plan,
      ];

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph: projectGraph(),
        config: DEFAULT_MEGAMONO_CONFIG,
        documents,
        now: new Date('2026-08-23T00:00:00.000Z'),
      });
      expect(new Set(report.findings.map(({ check }) => check))).toEqual(
        new Set([
          'dependency-alignment',
          'spec-drift',
          'stale-plans',
          'orphaned-libraries',
          'integration-template-drift',
        ]),
      );
      expect(serializeHealthReport(report)).toBe(
        serializeHealthReport(
          await runRepositoryHealth({
            workspaceRoot: root,
            graph: projectGraph(),
            config: DEFAULT_MEGAMONO_CONFIG,
            documents,
            now: new Date('2026-08-23T00:00:00.000Z'),
          }),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('suppresses exact findings with an active, correctly-topic decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      );
      await mkdir(join(root, 'apps/app'), { recursive: true });
      await mkdir(join(root, 'packages/util'), { recursive: true });
      await writeFile(
        join(root, 'apps/app/package.json'),
        JSON.stringify({ dependencies: { react: '^18.0.0' } }),
      );
      await writeFile(join(root, 'packages/util/package.json'), '{}');
      await writeFile(join(root, 'nx.json'), '{}');
      const decision = document(root, {
        id: 'decision-20260823-react-split',
        type: 'decision',
        status: 'accepted',
        topics: ['dependencies'],
      });
      const config: MegamonoConfig = {
        ...DEFAULT_MEGAMONO_CONFIG,
        health: {
          ...DEFAULT_MEGAMONO_CONFIG.health,
          suppressions: [
            {
              check: 'dependency-alignment',
              fingerprint: 'react:app:root',
              decision: decision.data.id,
            },
          ],
        },
      };
      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph: projectGraph(),
        config,
        documents: [decision],
        checks: ['dependency-alignment'],
        now: new Date('2026-08-23T00:00:00.000Z'),
      });
      expect(report.findings).toEqual([]);
      expect(report.intentional).toContainEqual(
        expect.objectContaining({ matched: true, decision: decision.data.id }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps temporary structural adoption ratchets visible in spec drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-ratchet-'));
    try {
      const config: MegamonoConfig = {
        ...DEFAULT_MEGAMONO_CONFIG,
        conventions: {
          ...DEFAULT_MEGAMONO_CONFIG.conventions,
          rules: { 'module-boundaries': { severity: 'warning' } },
        },
        adoption: {
          ...DEFAULT_MEGAMONO_CONFIG.adoption,
          ratchets: [
            {
              rule: 'module-boundaries',
              initialCount: 12,
              targetSeverity: 'error',
            },
          ],
        },
      };

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph: projectGraph(),
        config,
        documents: [],
        checks: ['spec-drift'],
      });

      expect(report.findings).toContainEqual(
        expect.objectContaining({
          fingerprint: 'adoption-ratchet:module-boundaries',
          state: 'adoption-ratchet',
          evidence: expect.arrayContaining(['initial violations: 12']),
        }),
      );
      const promoted = await runRepositoryHealth({
        workspaceRoot: root,
        graph: projectGraph(),
        config: {
          ...config,
          conventions: {
            ...config.conventions,
            rules: { 'module-boundaries': { severity: 'error' } },
          },
        },
        documents: [],
        checks: ['spec-drift'],
      });
      expect(
        promoted.findings.some(({ fingerprint }) =>
          fingerprint.startsWith('adoption-ratchet:'),
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not report compatible peer support ranges as dependency drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { nx: '23.1.1' } }),
      );
      await mkdir(join(root, 'apps/app'), { recursive: true });
      await mkdir(join(root, 'packages/util'), { recursive: true });
      await writeFile(
        join(root, 'apps/app/package.json'),
        JSON.stringify({ peerDependencies: { nx: '>=23.1 <24' } }),
      );
      await writeFile(join(root, 'packages/util/package.json'), '{}');
      await writeFile(join(root, 'nx.json'), '{}');

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph: projectGraph(),
        config: DEFAULT_MEGAMONO_CONFIG,
        documents: [],
        checks: ['dependency-alignment'],
        now: new Date('2026-08-23T00:00:00.000Z'),
      });

      expect(report.findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('evaluates Expo, SwiftPM, and Cargo constraints deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-'));
    const projects = {
      'cargo-a': 'packages/cargo-a',
      'cargo-b': 'packages/cargo-b',
      'swift-a': 'packages/swift-a',
      'swift-b': 'packages/swift-b',
      'expo-a': 'apps/expo-a',
      'expo-b': 'apps/expo-b',
    } as const;
    try {
      await writeFile(join(root, 'package.json'), '{}');
      await writeFile(join(root, 'nx.json'), '{}');
      for (const projectRoot of Object.values(projects)) {
        await mkdir(join(root, projectRoot), { recursive: true });
        await writeFile(join(root, projectRoot, 'package.json'), '{}');
      }
      await writeFile(
        join(root, projects['cargo-a'], 'Cargo.toml'),
        '[dependencies]\nserde = "1.0"\n',
      );
      await writeFile(
        join(root, projects['cargo-b'], 'Cargo.toml'),
        '[dependencies]\nserde = { version = "1.0.200", features = ["derive"] }\n',
      );
      await writeFile(
        join(root, projects['swift-a'], 'Package.swift'),
        '.package(url: "https://github.com/apple/swift-log.git", from: "1.5.0"),\n',
      );
      await writeFile(
        join(root, projects['swift-b'], 'Package.swift'),
        '.package(url: "https://github.com/apple/swift-log.git", exact: "1.6.0"),\n',
      );
      await writeFile(
        join(root, projects['expo-a'], 'app.json'),
        JSON.stringify({ expo: { sdkVersion: '53.0.0' } }),
      );
      await writeFile(
        join(root, projects['expo-b'], 'app.json'),
        JSON.stringify({ expo: { sdkVersion: '54.0.0' } }),
      );
      const graph: ProjectGraph = {
        nodes: Object.fromEntries(
          Object.entries(projects).map(([name, projectRoot]) => [
            name,
            { name, type: 'app', data: { root: projectRoot, tags: [] } },
          ]),
        ),
        dependencies: Object.fromEntries(
          Object.keys(projects).map((name) => [name, []]),
        ),
      };

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph,
        config: DEFAULT_MEGAMONO_CONFIG,
        documents: [],
        checks: ['dependency-alignment'],
        now: new Date('2026-08-23T00:00:00.000Z'),
      });

      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fingerprint: 'cargo:serde:cargo-a:cargo-b',
            state: 'alignable',
            confidence: 'complete',
          }),
          expect.objectContaining({
            fingerprint: 'swiftpm:swift-log:swift-a:swift-b',
            state: 'alignable',
            confidence: 'complete',
          }),
          expect.objectContaining({
            fingerprint: 'expo:sdk:expo-a:expo-b',
            state: 'constrained',
            confidence: 'complete',
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lowers orphan confidence and omits deletion advice for a partial graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      await mkdir(join(root, 'packages/util'), { recursive: true });
      await writeFile(join(root, 'packages/util/package.json'), '{}');
      await writeFile(join(root, 'nx.json'), JSON.stringify({ plugins: [] }));
      const config: MegamonoConfig = {
        ...DEFAULT_MEGAMONO_CONFIG,
        platforms: ['apple'],
      };

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph: projectGraph(),
        config,
        documents: [],
        checks: ['orphaned-libraries'],
        now: new Date('2026-08-23T00:00:00.000Z'),
      });

      expect(report.findings).toContainEqual(
        expect.objectContaining({
          fingerprint: 'util',
          confidence: 'reduced',
        }),
      );
      expect(report.findings[0]).not.toHaveProperty('recommendation');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not classify externally consumed packages as orphaned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      await mkdir(join(root, 'packages/util'), { recursive: true });
      await writeFile(
        join(root, 'packages/util/package.json'),
        JSON.stringify({
          name: '@fixture/util',
          publishConfig: { access: 'public' },
        }),
      );
      await writeFile(join(root, 'nx.json'), '{}');

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph: projectGraph(),
        config: DEFAULT_MEGAMONO_CONFIG,
        documents: [],
        checks: ['orphaned-libraries'],
      });

      expect(report.findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing allowed and present forbidden architecture edges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-'));
    try {
      const graph: ProjectGraph = {
        nodes: {
          ...projectGraph().nodes,
          api: {
            name: 'api',
            type: 'app',
            data: { root: 'apps/api', tags: ['type:app'] },
          },
        },
        dependencies: {
          app: [{ source: 'app', target: 'util', type: 'static' }],
          util: [{ source: 'util', target: 'app', type: 'implicit' }],
          api: [],
        },
      };
      const architecture = document(root, {
        id: 'spec-app-0001',
        type: 'spec',
        status: 'accepted',
        projects: ['app', 'util', 'api'],
        topics: ['architecture'],
        architecture: {
          allowed_dependencies: [
            { from: 'app', to: 'util' },
            { from: 'app', to: 'api' },
          ],
          forbidden_dependencies: [{ from: 'util', to: 'app' }],
        },
      });

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph,
        config: DEFAULT_MEGAMONO_CONFIG,
        documents: [architecture],
        checks: ['spec-drift'],
      });

      expect(report.findings).toEqual([
        expect.objectContaining({
          fingerprint: 'forbidden-architecture-edge:spec-app-0001:util:app',
          state: 'forbidden-architecture-edge',
          evidence: expect.arrayContaining(['edge types: implicit']),
        }),
        expect.objectContaining({
          fingerprint: 'missing-architecture-edge:spec-app-0001:app:api',
          state: 'missing-architecture-edge',
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('expands explicit product aliases into documented Nx projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-'));
    try {
      const specification = document(root, {
        id: 'spec-quickzones-0001',
        type: 'spec',
        status: 'accepted',
        projects: ['quickzones'],
      });
      const graph: ProjectGraph = {
        nodes: {
          'quickzones-int-api': {
            name: 'quickzones-int-api',
            type: 'app',
            data: { root: 'apps/api', tags: ['type:app'] },
          },
          'quickzones-int-site': {
            name: 'quickzones-int-site',
            type: 'app',
            data: { root: 'apps/site', tags: ['type:app'] },
          },
        },
        dependencies: {
          'quickzones-int-api': [],
          'quickzones-int-site': [],
        },
      };
      const config: MegamonoConfig = {
        ...DEFAULT_MEGAMONO_CONFIG,
        health: {
          ...DEFAULT_MEGAMONO_CONFIG.health,
          projectAliases: {
            quickzones: ['quickzones-int-api', 'quickzones-int-site'],
          },
        },
      };

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph,
        config,
        documents: [specification],
        checks: ['spec-drift'],
      });

      expect(report.findings).not.toContainEqual(
        expect.objectContaining({ state: 'missing-project' }),
      );
      expect(report.findings).not.toContainEqual(
        expect.objectContaining({ state: 'undocumented-project' }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports missing managed skills while excluding ejected skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-'));
    try {
      await mkdir(join(root, '.agents/skills/structure-review'), {
        recursive: true,
      });
      await writeFile(
        join(root, '.agents/skills/structure-review/SKILL.md'),
        '---\nname: structure-review\ndescription: Repository-owned.\n---\n',
      );

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph: { nodes: {}, dependencies: {} },
        config: DEFAULT_MEGAMONO_CONFIG,
        documents: [],
        checks: ['spec-drift'],
      });

      expect(report.findings).toContainEqual(
        expect.objectContaining({
          fingerprint: 'managed-skill:missing:plan-sync',
          state: 'managed-skill-missing',
        }),
      );
      expect(report.findings).not.toContainEqual(
        expect.objectContaining({
          fingerprint: expect.stringContaining('structure-review'),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports general managed artifact drift with stable fingerprints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-artifact-'));
    try {
      await mkdir(join(root, '.megamono'), { recursive: true });
      await mkdir(join(root, '.github', 'workflows'), { recursive: true });
      await writeFile(
        join(root, '.github', 'workflows', 'megamono-ci.yml'),
        'repository edit\n',
      );
      await writeFile(
        join(root, '.megamono', 'artifacts.json'),
        renderArtifactRegistry({
          schemaVersion: 1,
          artifacts: [
            {
              id: 'ci.affected',
              module: 'ci',
              mode: 'managed',
              target: '.github/workflows/megamono-ci.yml',
              sourceVersion: '1.0.0',
              templateHash: hashArtifactBytes('managed template\n'),
              installedHash: hashArtifactBytes('managed template\n'),
              state: 'managed',
              ejectable: true,
            },
          ],
        }),
      );

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph: { nodes: {}, dependencies: {} },
        config: DEFAULT_MEGAMONO_CONFIG,
        documents: [],
        checks: ['spec-drift'],
      });

      expect(report.findings).toContainEqual(
        expect.objectContaining({
          fingerprint: 'managed-artifact:modified:ci.affected',
          state: 'managed-artifact-modified',
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('flags git-stale, merged, deleted, and superseded plans', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      await writeFile(join(root, 'nx.json'), '{}');
      const oldPlan = document(root, {
        id: 'plan-app-20260101-old-auth',
        type: 'plan',
        status: 'in-progress',
        date: '2026-01-01',
        branch: 'feature/old-auth',
        projects: ['app'],
        topics: ['auth'],
      });
      const replacement = document(root, {
        id: 'plan-app-20260701-new-auth',
        type: 'plan',
        status: 'backlog',
        date: '2026-07-01',
        projects: ['app'],
        topics: ['auth'],
      });
      const missingBranch = document(root, {
        id: 'plan-app-20260801-missing-branch',
        type: 'plan',
        status: 'in-progress',
        date: '2026-08-01',
        branch: 'feature/deleted',
        projects: ['app'],
        topics: ['testing'],
      });
      for (const plan of [oldPlan, replacement, missingBranch]) {
        await writeFile(plan.absolutePath, plan.data.id);
      }

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph: projectGraph(),
        config: DEFAULT_MEGAMONO_CONFIG,
        documents: [oldPlan, replacement, missingBranch],
        checks: ['stale-plans'],
        gitState: {
          available: true,
          branches: {
            'feature/old-auth': 'merged',
            'feature/deleted': 'missing',
          },
          lastChanged: {
            [oldPlan.data.id]: '2026-01-01T00:00:00.000Z',
            [replacement.data.id]: '2026-08-20T00:00:00.000Z',
            [missingBranch.data.id]: '2026-08-20T00:00:00.000Z',
          },
        },
        now: new Date('2026-08-23T00:00:00.000Z'),
      });

      expect(report.findings.map(({ fingerprint }) => fingerprint)).toEqual(
        expect.arrayContaining([
          `unchanged:${oldPlan.data.id}`,
          `branch-merged:${oldPlan.data.id}:feature/old-auth`,
          `branch-missing:${missingBranch.data.id}:feature/deleted`,
          `superseded:${oldPlan.data.id}:${replacement.data.id}`,
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('collects plan timestamps and merged branches from local git history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-git-'));
    try {
      const plan = document(root, {
        id: 'plan-app-20260801-git-state',
        type: 'plan',
        status: 'in-progress',
        branch: 'feature/completed',
      });
      await writeFile(plan.absolutePath, 'tracked plan');
      const git = (args: readonly string[]) =>
        executeFile('git', [...args], { cwd: root });
      await git(['init', '-b', 'main']);
      await git(['config', 'user.email', 'fixture@example.com']);
      await git(['config', 'user.name', 'Megamono Fixture']);
      await git(['add', '.']);
      await git(['commit', '-m', 'Add plan']);
      await git(['branch', plan.data.branch as string]);

      const state = await collectHealthGitState(root, [plan]);

      expect(state.available).toBe(true);
      expect(state.branches[plan.data.branch as string]).toBe('merged');
      expect(state.lastChanged[plan.data.id]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects suppressions backed by the wrong decision topic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      await writeFile(join(root, 'nx.json'), '{}');
      const decision = document(root, {
        id: 'decision-20260823-wrong-topic',
        type: 'decision',
        status: 'accepted',
        topics: ['docs'],
      });
      const config: MegamonoConfig = {
        ...DEFAULT_MEGAMONO_CONFIG,
        health: {
          ...DEFAULT_MEGAMONO_CONFIG.health,
          suppressions: [
            {
              check: 'dependency-alignment',
              fingerprint: 'react:app:root',
              decision: decision.data.id,
            },
          ],
        },
      };
      await expect(
        runRepositoryHealth({
          workspaceRoot: root,
          graph: { nodes: {}, dependencies: {} },
          config,
          documents: [decision],
          checks: [],
          now: new Date('2026-08-23T00:00:00.000Z'),
        }),
      ).rejects.toBeInstanceOf(HealthConfigurationError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects expired and superseded-decision suppressions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      await writeFile(join(root, 'nx.json'), '{}');
      const decision = document(root, {
        id: 'decision-20260823-react-split',
        type: 'decision',
        status: 'accepted',
        topics: ['dependencies'],
      });
      const suppression = {
        check: 'dependency-alignment' as const,
        fingerprint: 'react:app:root',
        decision: decision.data.id,
      };
      const expired: MegamonoConfig = {
        ...DEFAULT_MEGAMONO_CONFIG,
        health: {
          ...DEFAULT_MEGAMONO_CONFIG.health,
          suppressions: [{ ...suppression, expires_at: '2026-01-01' }],
        },
      };
      await expect(
        runRepositoryHealth({
          workspaceRoot: root,
          graph: { nodes: {}, dependencies: {} },
          config: expired,
          documents: [decision],
          checks: [],
          now: new Date('2026-08-23T00:00:00.000Z'),
        }),
      ).rejects.toThrow('expired');

      const replacement = document(root, {
        id: 'decision-20260823-react-unified',
        type: 'decision',
        status: 'accepted',
        topics: ['dependencies'],
        supersedes: decision.data.id,
      });
      const superseded: MegamonoConfig = {
        ...DEFAULT_MEGAMONO_CONFIG,
        health: {
          ...DEFAULT_MEGAMONO_CONFIG.health,
          suppressions: [suppression],
        },
      };
      await expect(
        runRepositoryHealth({
          workspaceRoot: root,
          graph: { nodes: {}, dependencies: {} },
          config: superseded,
          documents: [decision, replacement],
          checks: [],
          now: new Date('2026-08-23T00:00:00.000Z'),
        }),
      ).rejects.toThrow('superseded');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports deterministic Cloudflare compatibility and graph drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-cloudflare-'));
    try {
      await Promise.all([
        mkdir(join(root, 'apps/old'), { recursive: true }),
        mkdir(join(root, 'apps/new'), { recursive: true }),
        mkdir(join(root, 'node_modules/wrangler'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(root, 'apps/old/package.json'),
          JSON.stringify({
            devDependencies: { '@cloudflare/vitest-plugin': '1.0.0' },
          }),
        ),
        writeFile(join(root, 'apps/new/package.json'), '{}'),
        writeFile(
          join(root, 'node_modules/wrangler/package.json'),
          JSON.stringify({ version: '5.0.0' }),
        ),
      ]);
      const metadata = (configPath: string, compatibilityDate: string) => ({
        schemaVersion: 1 as const,
        inferenceStatus: 'ready' as const,
        configPath,
        workerName: 'duplicate-worker',
        compatibilityDate,
        compatibilityFlags: [],
        unresolvedWorkers: [],
        topLevelBindingFamilies: [],
        unknownBindingFamilies: [],
        environments: [],
      });
      const oldMetadata = {
        ...metadata('apps/old/wrangler.jsonc', '2026-08-01'),
        unresolvedWorkers: [
          { kind: 'service', worker: 'missing-api', binding: 'API' },
        ],
        unknownBindingFamilies: ['future_resources'],
        environments: [{ name: 'production', bindingFamilies: ['services'] }],
      };
      const graph: ProjectGraph = {
        nodes: {
          old: {
            name: 'old',
            type: 'app',
            data: {
              root: 'apps/old',
              metadata: { 'megamono:cloudflare': oldMetadata },
            },
          },
          new: {
            name: 'new',
            type: 'app',
            data: {
              root: 'apps/new',
              metadata: {
                'megamono:cloudflare': metadata(
                  'apps/new/wrangler.jsonc',
                  '2026-08-24',
                ),
              },
            },
          },
        },
        dependencies: { old: [], new: [] },
      };

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph,
        config: DEFAULT_MEGAMONO_CONFIG,
        documents: [],
        checks: ['dependency-alignment', 'spec-drift'],
      });
      const fingerprints = report.findings.map(
        ({ fingerprint }) => fingerprint,
      );
      expect(fingerprints).toEqual(
        expect.arrayContaining([
          'cloudflare:wrangler-range:.:5.0.0',
          'cloudflare:duplicate-worker:duplicate-worker',
          'cloudflare:unresolved-worker:old:service:missing-api',
          'cloudflare:compatibility-date:old',
          'cloudflare:node-compat:old',
          'cloudflare:environment-binding:old:production:services',
          'cloudflare:binding-shape:old:future_resources',
        ]),
      );
      expect(
        report.findings.find(
          ({ fingerprint }) =>
            fingerprint === 'cloudflare:binding-shape:old:future_resources',
        ),
      ).toMatchObject({ confidence: 'reduced', state: 'constrained' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces Render graph preflight diagnostics through spec drift', async () => {
    const graph: ProjectGraph = {
      nodes: {
        site: {
          name: 'site',
          type: 'app',
          data: {
            root: 'apps/site',
            metadata: {
              'megamono:render': { schemaVersion: 1 },
              'megamono:preflight': {
                diagnostics: [
                  {
                    severity: 'warning',
                    code: 'render-next-isr-shared-cache',
                    message:
                      'Multi-instance Next service site has no detectable shared cacheHandler configuration.',
                    path: 'render.yaml',
                    service: 'site',
                  },
                ],
              },
            },
          },
        },
      },
      dependencies: { site: [] },
    };

    const report = await runRepositoryHealth({
      workspaceRoot: '/virtual',
      graph,
      config: DEFAULT_MEGAMONO_CONFIG,
      documents: [],
      checks: ['spec-drift'],
    });

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        fingerprint: 'render:render-next-isr-shared-cache:site:site',
        state: 'alignable',
        confidence: 'complete',
      }),
    );
  });

  it('reports named database ownership and adapter drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-database-'));
    try {
      await mkdir(join(root, 'packages/database-primary'), { recursive: true });
      await writeFile(
        join(root, 'playstack.json'),
        JSON.stringify({
          databases: {
            primary: {
              adapter: 'drizzle',
              target: 'packages/shared/schema',
            },
          },
        }),
      );
      const graph: ProjectGraph = {
        nodes: {
          'database-primary': {
            name: 'database-primary',
            type: 'lib',
            data: { root: 'packages/database-primary' },
          },
        },
        dependencies: { 'database-primary': [] },
      };
      const config: MegamonoConfig = {
        ...DEFAULT_MEGAMONO_CONFIG,
        databases: {
          primary: { adapter: 'prisma', project: 'database-primary' },
          events: { adapter: 'drizzle', project: 'database-events' },
        },
      };

      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph,
        config,
        documents: [],
        checks: ['spec-drift'],
      });
      expect(report.findings.map(({ fingerprint }) => fingerprint)).toEqual(
        expect.arrayContaining([
          'database:adapter-disagreement:primary',
          'database:target-outside-project:primary',
          'database:missing-project:events:database-events',
        ]),
      );

      await writeFile(
        join(root, 'playstack.json'),
        JSON.stringify({
          databases: {
            primary: {
              adapter: 'prisma',
              target: 'packages/database-primary/prisma/models',
            },
          },
        }),
      );
      const aligned = await runRepositoryHealth({
        workspaceRoot: root,
        graph,
        config: {
          ...config,
          databases: { primary: config.databases.primary },
        },
        documents: [],
        checks: ['spec-drift'],
      });
      expect(
        aligned.findings.filter(({ fingerprint }) =>
          fingerprint.startsWith('database:'),
        ),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a missing Drizzle dialect and accepts the Playstack contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-health-dialect-'));
    try {
      await mkdir(join(root, 'packages/database-events'), { recursive: true });
      const graph: ProjectGraph = {
        nodes: {
          'database-events': {
            name: 'database-events',
            type: 'lib',
            data: { root: 'packages/database-events' },
          },
        },
        dependencies: { 'database-events': [] },
      };
      const config: MegamonoConfig = {
        ...DEFAULT_MEGAMONO_CONFIG,
        databases: {
          events: { adapter: 'drizzle', project: 'database-events' },
        },
      };
      const writePlaystack = async (dialect?: string) =>
        writeFile(
          join(root, 'playstack.json'),
          JSON.stringify({
            databases: {
              events: {
                adapter: 'drizzle',
                ...(dialect ? { dialect } : {}),
                target: 'packages/database-events/src/schema',
              },
            },
          }),
        );

      await writePlaystack();
      const missing = await runRepositoryHealth({
        workspaceRoot: root,
        graph,
        config,
        documents: [],
        checks: ['spec-drift'],
      });
      expect(missing.findings.map(({ fingerprint }) => fingerprint)).toContain(
        'database:dialect-disagreement:events',
      );

      await writePlaystack('postgresql');
      const aligned = await runRepositoryHealth({
        workspaceRoot: root,
        graph,
        config,
        documents: [],
        checks: ['spec-drift'],
      });
      expect(
        aligned.findings.filter(({ fingerprint }) =>
          fingerprint.startsWith('database:'),
        ),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
