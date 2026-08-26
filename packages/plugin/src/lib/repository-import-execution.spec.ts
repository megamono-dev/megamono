import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_MEGAMONO_CONFIG, readMegamonoConfig } from './config';
import { validateRepositoryDocs } from './docs';
import { analyzeRepositoryImport } from './repository-import';
import {
  completedRepositoryImport,
  executeSubtreeRepositoryImport,
  ImportExecutionError,
  type ImportCommandRunner,
} from './repository-import-execution';

const executeFile = promisify(execFile);

async function run(root: string, command: string, args: readonly string[]) {
  return executeFile(command, [...args], { cwd: root, encoding: 'utf8' });
}

async function writeJson(
  root: string,
  path: string,
  value: Record<string, unknown>,
) {
  const absolute = resolve(root, path);
  await mkdir(resolve(absolute, '..'), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function initializeGit(root: string, message: string) {
  await run(root, 'git', ['init', '--initial-branch=main']);
  await run(root, 'git', ['config', 'user.name', 'Megamono import fixture']);
  await run(root, 'git', [
    'config',
    'user.email',
    'import-fixture@megamono.com',
  ]);
  await run(root, 'git', ['add', '.']);
  await run(root, 'git', ['commit', '-m', message]);
}

async function createTarget(root: string) {
  await mkdir(root, { recursive: true });
  await writeJson(root, 'package.json', {
    name: 'target-workspace',
    private: true,
    workspaces: [],
  });
  await writeJson(root, 'tsconfig.base.json', {
    compilerOptions: {
      paths: { '@fixture/shared/*': ['./libs/shared/*'] },
    },
  });
  await writeJson(root, 'megamono.json', {
    ...DEFAULT_MEGAMONO_CONFIG,
    conventions: {
      ...DEFAULT_MEGAMONO_CONFIG.conventions,
      packageManager: 'npm',
    },
  });
  await writeFile(join(root, '.env'), 'SHARED_TOKEN=target-value\n', 'utf8');
  await writeFile(join(root, '.gitignore'), 'node_modules/\n.nx/\n', 'utf8');
  await initializeGit(root, 'target seed');
  await run(root, 'git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await run(root, 'git', [
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  ]);
  await run(root, 'git', ['switch', '-c', 'import/fixture']);
}

async function createSource(root: string, withRepositoryFiles = false) {
  await mkdir(root, { recursive: true });
  await writeJson(root, 'package.json', {
    name: 'source-app',
    private: true,
    scripts: {
      build: 'node src/index.mjs',
      test: 'node --test src/index.test.mjs',
      lint: 'node --check src/index.mjs',
    },
  });
  await writeJson(root, 'tsconfig.json', {
    compilerOptions: { paths: { '@fixture/shared/*': ['./src/*'] } },
  });
  await writeFile(
    join(root, '.env.example'),
    'SHARED_TOKEN=source-example\nPUBLIC_URL=${SHARED_TOKEN}\n',
    'utf8',
  );
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'src/index.mjs'),
    "export const imported = true;\nconst { SHARED_TOKEN } = process.env;\nexport const token = SHARED_TOKEN;\nexport const directToken = process.env.SHARED_TOKEN;\nexport const loadShared = () => import('@fixture/shared/tool');\nexport const resolveShared = () => require.resolve('@fixture/shared/tool');\n",
    'utf8',
  );
  await writeFile(
    join(root, 'src/index.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { imported } from './index.mjs';\ntest('imported', () => assert.equal(imported, true));\n",
    'utf8',
  );
  if (withRepositoryFiles) {
    await writeJson(root, 'nx.json', { plugins: ['source-only-plugin'] });
    await writeJson(root, 'package-lock.json', {
      name: 'source-app',
      lockfileVersion: 3,
    });
    await mkdir(join(root, '.github/workflows'), { recursive: true });
    await writeFile(
      join(root, '.github/workflows/ci.yml'),
      'name: Source CI\n',
      'utf8',
    );
    await mkdir(join(root, 'docs/guides'), { recursive: true });
    await writeFile(
      join(root, 'docs/guides/overview.md'),
      '# Source overview\n\nHow the source application works.\n',
      'utf8',
    );
    await writeFile(
      join(root, 'docs/guides/diagram.txt'),
      'source diagram\n',
      'utf8',
    );
    await mkdir(join(root, 'docs/decisions'), { recursive: true });
    await writeFile(
      join(root, 'docs/decisions/legacy.md'),
      '# Legacy choice\n\n**Status:** accepted\n**Date:** 2024-03-04\n\n## Decision\n\nKeep the legacy boundary.\n',
      'utf8',
    );
    await writeFile(
      join(root, 'docs/decisions/preserved.md'),
      `---
id: decision-20240102-use-sessions
type: decision
status: accepted
visibility: internal
projects: [source-app]
topics: [sessions]
summary: Preserve the source session boundary.
date: 2024-01-02
supersedes: null
references: []
external_references: []
---

# Preserve the source session boundary
`,
      'utf8',
    );
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/INDEX.md'), '# Source index\n', 'utf8');
  }
  await initializeGit(root, 'source seed');
  await writeFile(join(root, 'source-history.txt'), 'second commit\n', 'utf8');
  await run(root, 'git', ['add', '.']);
  await run(root, 'git', ['commit', '-m', 'source follow-up']);
  return (await run(root, 'git', ['rev-parse', 'HEAD'])).stdout.trim();
}

describe('repository import subtree execution', { timeout: 20_000 }, () => {
  let temporaryRoot: string;
  let targetRoot: string;
  let sourceRoot: string;
  let sourceSha: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'megamono-import-exec-'));
    targetRoot = join(temporaryRoot, 'target');
    sourceRoot = join(temporaryRoot, 'source');
    await createTarget(targetRoot);
    sourceSha = await createSource(sourceRoot, true);
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function analysis() {
    return analyzeRepositoryImport({
      workspaceRoot: targetRoot,
      options: {
        source: sourceRoot,
        name: 'imported-app',
        expectedSourceSha: sourceSha,
        history: 'subtree',
        verify: 'none',
        resolutions: {
          aliases: { '@fixture/shared/*': '@imported/shared/*' },
          environment: { SHARED_TOKEN: 'IMPORTED_SHARED_TOKEN' },
        },
      },
    });
  }

  it('preserves source history and commits a clean integrated project', async () => {
    const baseSha = (
      await run(targetRoot, 'git', ['rev-parse', 'HEAD'])
    ).stdout.trim();
    const commands: string[] = [];
    const runner: ImportCommandRunner = async (command) => {
      commands.push(command.display);
    };
    const options = {
      source: sourceRoot,
      name: 'imported-app',
      expectedSourceSha: sourceSha,
      history: 'subtree',
      verify: 'none',
      execute: true,
      resolutions: {
        aliases: { '@fixture/shared/*': '@imported/shared/*' },
        environment: { SHARED_TOKEN: 'IMPORTED_SHARED_TOKEN' },
      },
    } as const;
    const result = await executeSubtreeRepositoryImport(
      targetRoot,
      await analysis(),
      options,
      runner,
    );

    expect(commands).toEqual([
      'npm install',
      'npm exec nx run megamono-docs:index',
    ]);
    expect(
      await readFile(
        join(targetRoot, 'apps/imported-app/src/index.mjs'),
        'utf8',
      ),
    ).toContain('imported = true');
    expect(
      await readFile(
        join(targetRoot, 'apps/imported-app/src/index.mjs'),
        'utf8',
      ),
    ).toContain("import('@imported/shared/tool')");
    expect(
      await readFile(
        join(targetRoot, 'apps/imported-app/src/index.mjs'),
        'utf8',
      ),
    ).toContain('process.env.IMPORTED_SHARED_TOKEN');
    expect(
      await readFile(
        join(targetRoot, 'apps/imported-app/src/index.mjs'),
        'utf8',
      ),
    ).toContain('const { IMPORTED_SHARED_TOKEN: SHARED_TOKEN } = process.env');
    expect(
      await readFile(
        join(targetRoot, 'apps/imported-app/src/index.mjs'),
        'utf8',
      ),
    ).toContain("require.resolve('@imported/shared/tool')");
    expect(
      JSON.parse(
        await readFile(
          join(targetRoot, 'apps/imported-app/tsconfig.json'),
          'utf8',
        ),
      ).compilerOptions.paths,
    ).toEqual({ '@imported/shared/*': ['./src/*'] });
    expect(
      await readFile(
        join(targetRoot, 'apps/imported-app/.env.example'),
        'utf8',
      ),
    ).toBe(
      'IMPORTED_SHARED_TOKEN=source-example\nPUBLIC_URL=${IMPORTED_SHARED_TOKEN}\n',
    );
    expect(await readFile(join(targetRoot, '.env'), 'utf8')).toBe(
      'SHARED_TOKEN=target-value\n',
    );
    expect(
      await readFile(
        join(targetRoot, 'docs/specs/imported-app/guides/overview.md'),
        'utf8',
      ),
    ).toContain('id: "spec-imported-app-0001"');
    expect(
      await readFile(join(targetRoot, 'docs/decisions/preserved.md'), 'utf8'),
    ).toContain('date: "2024-01-02"');
    expect(
      await readFile(join(targetRoot, 'docs/decisions/legacy.md'), 'utf8'),
    ).toContain('date: "2024-03-04"');
    expect(
      await readFile(
        join(targetRoot, 'docs/specs/imported-app/guides/diagram.txt'),
        'utf8',
      ),
    ).toBe('source diagram\n');
    expect(
      await readFile(
        join(
          targetRoot,
          '.megamono/imports/imported-app/source-infrastructure/.github/workflows/ci.yml',
        ),
        'utf8',
      ),
    ).toBe('name: Source CI\n');
    expect(
      await readFile(
        join(
          targetRoot,
          '.megamono/imports/imported-app/source-infrastructure/nx.json',
        ),
        'utf8',
      ),
    ).toContain('source-only-plugin');
    await expect(
      readFile(join(targetRoot, 'apps/imported-app/nx.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      JSON.parse(
        await readFile(
          join(targetRoot, 'apps/imported-app/project.json'),
          'utf8',
        ),
      ).targets,
    ).toMatchObject({ build: {}, test: {}, lint: {} });
    expect(
      JSON.parse(await readFile(join(targetRoot, 'package.json'), 'utf8'))
        .workspaces,
    ).toEqual(['apps/imported-app']);
    expect(
      await readFile(
        join(targetRoot, '.megamono/imports/imported-app.json'),
        'utf8',
      ),
    ).toContain(sourceSha);
    expect(await completedRepositoryImport(targetRoot, options)).toEqual(
      result.marker,
    );
    expect(result.marker.schemaVersion).toBe(2);
    expect(result.marker.repositoryRoutes).toHaveLength(8);
    expect(result.marker.collisionRewrites).toEqual([
      {
        kind: 'alias',
        source: '@fixture/shared/*',
        destination: '@imported/shared/*',
        affectedFiles: ['src/index.mjs', 'tsconfig.json'],
      },
      {
        kind: 'environment',
        source: 'SHARED_TOKEN',
        destination: 'IMPORTED_SHARED_TOKEN',
        affectedFiles: ['.env.example', 'src/index.mjs'],
      },
    ]);
    const config = await readMegamonoConfig(targetRoot);
    expect(config.topics.extend).toContain('sessions');
    const docs = await validateRepositoryDocs(targetRoot, config);
    expect(docs.diagnostics).toEqual([]);
    expect(
      (await run(targetRoot, 'git', ['status', '--porcelain=v1'])).stdout,
    ).toBe('');
    expect(
      (await run(sourceRoot, 'git', ['status', '--porcelain=v1'])).stdout,
    ).toBe('');
    expect(
      (
        await run(targetRoot, 'git', [
          'rev-list',
          '--count',
          `${baseSha}..HEAD`,
        ])
      ).stdout,
    ).toBe('4\n');
    const subjects = (
      await run(targetRoot, 'git', ['log', '--all', '--format=%s'])
    ).stdout;
    expect(subjects).toContain('source seed');
    expect(subjects).toContain('source follow-up');
    expect(subjects).toContain('graft imported-app history');
    expect(subjects).toContain('import imported-app');
    expect(result.integrationCommit).toBe(
      (await run(targetRoot, 'git', ['rev-parse', 'HEAD'])).stdout.trim(),
    );
  });

  it('integrates and verifies with the target pnpm command family', async () => {
    await writeJson(targetRoot, 'megamono.json', DEFAULT_MEGAMONO_CONFIG);
    await writeFile(
      join(targetRoot, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n",
      'utf8',
    );
    await run(targetRoot, 'git', ['add', '.']);
    await run(targetRoot, 'git', ['commit', '-m', 'use pnpm']);
    const importAnalysis = await analysis();
    const commands: string[] = [];

    await executeSubtreeRepositoryImport(
      targetRoot,
      importAnalysis,
      {
        source: sourceRoot,
        name: 'imported-app',
        expectedSourceSha: sourceSha,
        history: 'subtree',
        verify: 'none',
        execute: true,
        resolutions: {
          aliases: { '@fixture/shared/*': '@imported/shared/*' },
          environment: { SHARED_TOKEN: 'IMPORTED_SHARED_TOKEN' },
        },
      },
      async (command) => {
        commands.push(command.display);
      },
    );

    expect(importAnalysis.packageManager).toBe('pnpm');
    expect(commands).toEqual([
      'pnpm install',
      'pnpm exec nx run megamono-docs:index',
    ]);
    expect(
      await readFile(join(targetRoot, 'pnpm-workspace.yaml'), 'utf8'),
    ).toContain("- 'apps/imported-app'");
    expect(
      JSON.parse(await readFile(join(targetRoot, 'package.json'), 'utf8'))
        .workspaces,
    ).toEqual([]);
  });

  it('leaves the graft intact and writes recovery guidance after a command failure', async () => {
    const runner: ImportCommandRunner = async (command) => {
      if (command.phase === 'docs') throw new Error('fixture docs failure');
    };

    let failure: unknown;
    try {
      await executeSubtreeRepositoryImport(
        targetRoot,
        await analysis(),
        {
          source: sourceRoot,
          name: 'imported-app',
          expectedSourceSha: sourceSha,
          history: 'subtree',
          verify: 'none',
          execute: true,
          resolutions: {
            aliases: { '@fixture/shared/*': '@imported/shared/*' },
            environment: { SHARED_TOKEN: 'IMPORTED_SHARED_TOKEN' },
          },
        },
        runner,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ImportExecutionError);
    expect(failure).toMatchObject({
      phase: 'docs',
      command: 'npm exec nx run megamono-docs:index',
    });

    const recovery = await readFile(
      join(targetRoot, 'MEGAMONO-RECOVERY.md'),
      'utf8',
    );
    const head = (await run(targetRoot, 'git', ['rev-parse', 'HEAD'])).stdout;
    expect(recovery).toContain(`Graft commit: \`${head.trim()}\``);
    expect(recovery).toContain('Megamono did not reset, revert, push');
    expect(
      (await run(targetRoot, 'git', ['status', '--porcelain=v1'])).stdout,
    ).toContain('MEGAMONO-RECOVERY.md');
    expect(
      (await run(sourceRoot, 'git', ['status', '--porcelain=v1'])).stdout,
    ).toBe('');
  });

  it('fails integration when the imported package edge is absent from the Nx graph', async () => {
    const manifest = JSON.parse(
      await readFile(join(sourceRoot, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    manifest.dependencies = { '@fixture/host-shared': '*' };
    await writeJson(sourceRoot, 'package.json', manifest);
    await writeFile(
      join(sourceRoot, 'src/host.mjs'),
      "import { shared } from '@fixture/host-shared';\nexport { shared };\n",
      'utf8',
    );
    await run(sourceRoot, 'git', ['add', '.']);
    await run(sourceRoot, 'git', ['commit', '-m', 'use host package']);
    sourceSha = (
      await run(sourceRoot, 'git', ['rev-parse', 'HEAD'])
    ).stdout.trim();
    const options = {
      source: sourceRoot,
      name: 'imported-app',
      expectedSourceSha: sourceSha,
      history: 'subtree',
      verify: 'config',
      execute: true,
      resolutions: {
        aliases: { '@fixture/shared/*': '@imported/shared/*' },
        environment: { SHARED_TOKEN: 'IMPORTED_SHARED_TOKEN' },
      },
    } as const;
    const importAnalysis = await analyzeRepositoryImport({
      workspaceRoot: targetRoot,
      options,
      targetProjects: [
        { name: 'host-shared', packageName: '@fixture/host-shared' },
      ],
    });
    const runner: ImportCommandRunner = async (command) =>
      command.phase === 'graph'
        ? JSON.stringify({
            graph: { dependencies: { 'imported-app': [] } },
          })
        : undefined;

    await expect(
      executeSubtreeRepositoryImport(
        targetRoot,
        importAnalysis,
        options,
        runner,
      ),
    ).rejects.toMatchObject({
      phase: 'graph',
      command: 'npm exec nx -- graph --print',
    });
    expect(
      await readFile(join(targetRoot, 'MEGAMONO-RECOVERY.md'), 'utf8'),
    ).toContain('`graph` phase');
  });

  it('rejects malformed collision provenance in a completion marker', async () => {
    await writeJson(targetRoot, '.megamono/imports/imported-app.json', {
      schemaVersion: 2,
      name: 'imported-app',
      source: sourceRoot,
      sourceSha,
      destination: 'apps/imported-app',
      history: 'subtree',
      graftCommit: '1'.repeat(40),
      repositoryRoutes: [],
      collisionRewrites: [{ kind: 'alias' }],
    });

    await expect(
      completedRepositoryImport(targetRoot, {
        source: sourceRoot,
        name: 'imported-app',
      }),
    ).rejects.toMatchObject({ code: 'import-invalid-marker' });
  });
});
