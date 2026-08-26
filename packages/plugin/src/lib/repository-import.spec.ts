import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_MEGAMONO_CONFIG } from './config';
import {
  analyzeRepositoryImport,
  ImportOptionsError,
  normalizedImportDestination,
  renderRepositoryImportReport,
  sanitizedImportSource,
} from './repository-import';

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
    dependencies: { react: '^19.0.0' },
  });
  await writeJson(root, 'tsconfig.base.json', {
    compilerOptions: { paths: { '@fixture/shared': ['./libs/shared/src.ts'] } },
  });
  await writeJson(root, 'megamono.json', {
    ...DEFAULT_MEGAMONO_CONFIG,
    conventions: {
      ...DEFAULT_MEGAMONO_CONFIG.conventions,
      packageManager: 'npm',
    },
  });
  await writeFile(
    join(root, '.env'),
    'SHARED_TOKEN=target-fixture-value\n',
    'utf8',
  );
  await initializeGit(root, 'target seed');
  await run(root, 'git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  await run(root, 'git', [
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  ]);
  await run(root, 'git', ['switch', '-c', 'import/fixture']);
}

async function createSource(
  root: string,
  conflicting = true,
  withRepositoryFiles = false,
) {
  await mkdir(root, { recursive: true });
  await writeJson(root, 'package.json', {
    name: 'source-app',
    private: true,
    packageManager: 'npm@11.0.0',
    scripts: {
      build: 'node src/build.mjs',
      test: 'node --test',
      lint: 'node --check src/index.mjs',
    },
    dependencies: conflicting ? { react: '^18.0.0' } : { zod: '^4.0.0' },
  });
  await writeJson(root, 'tsconfig.json', {
    compilerOptions: {
      paths: conflicting
        ? { '@fixture/shared': ['./src/shared.ts'] }
        : { '@source/local': ['./src/local.ts'] },
    },
  });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'src/index.mjs'),
    conflicting
      ? "import '@fixture/shared';\nexport const token = process.env.SHARED_TOKEN;\n"
      : 'export const imported = true;\n',
    'utf8',
  );
  if (conflicting) {
    await writeFile(
      join(root, '.env.example'),
      'SHARED_TOKEN=source-secret-that-must-not-appear\n',
      'utf8',
    );
  }
  if (withRepositoryFiles) {
    await writeFile(
      join(root, 'src/commented.mjs'),
      `// import '../docs/guides/overview.md';
export const example = "require('../docs/guides/overview.md')";
`,
      'utf8',
    );
    await writeJson(root, 'nx.json', { plugins: ['source-only-plugin'] });
    await mkdir(join(root, '.github/workflows'), { recursive: true });
    await writeFile(
      join(root, '.github/workflows/ci.yml'),
      'name: Source CI\n',
      'utf8',
    );
    await mkdir(join(root, 'docs/guides'), { recursive: true });
    await writeFile(
      join(root, 'docs/guides/overview.md'),
      '# Source overview\n',
      'utf8',
    );
    await mkdir(join(root, 'docs/decisions'), { recursive: true });
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
    await writeFile(join(root, 'docs/INDEX.md'), '# Source index\n', 'utf8');
  }
  await initializeGit(root, 'source seed');
  return (await run(root, 'git', ['rev-parse', 'HEAD'])).stdout.trim();
}

describe('repository import analysis', { timeout: 20_000 }, () => {
  let temporaryRoot: string;
  let targetRoot: string;
  let sourceRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'megamono-import-test-'));
    targetRoot = join(temporaryRoot, 'target');
    sourceRoot = join(temporaryRoot, 'source');
    await createTarget(targetRoot);
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('produces stable local analysis without changing either repository', async () => {
    const sourceSha = await createSource(sourceRoot);
    const targetBefore = await run(targetRoot, 'git', [
      'status',
      '--porcelain',
    ]);
    const sourceBefore = await run(sourceRoot, 'git', [
      'status',
      '--porcelain',
    ]);
    const input = {
      workspaceRoot: targetRoot,
      options: {
        source: '../source',
        ref: 'main',
        name: 'imported-app',
      },
      projectNames: ['existing-app'],
    } as const;

    const first = await analyzeRepositoryImport(input);
    const second = await analyzeRepositoryImport(input);
    const report = renderRepositoryImportReport(first);

    expect(first.sourceSha).toBe(sourceSha);
    expect(first.sourceKind).toBe('local');
    expect(first.blockers).toEqual([]);
    expect(first.dependencyConflicts).toEqual([
      {
        name: 'react',
        source: '^18.0.0',
        target: '^19.0.0',
      },
    ]);
    expect(first.collisions.map(({ kind, name }) => [kind, name])).toEqual([
      ['alias', '@fixture/shared'],
      ['environment', 'SHARED_TOKEN'],
    ]);
    expect(first.collisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'alias',
          affectedFiles: ['src/index.mjs', 'tsconfig.json'],
        }),
        expect.objectContaining({
          kind: 'environment',
          affectedFiles: ['.env.example', 'src/index.mjs'],
        }),
      ]),
    );
    expect(first.ready).toBe(false);
    expect(renderRepositoryImportReport(second)).toBe(report);
    expect(report).toContain(`Resolved source SHA: \`${sourceSha}\``);
    expect(report).not.toContain('source-secret-that-must-not-appear');
    expect(
      (await run(targetRoot, 'git', ['status', '--porcelain'])).stdout,
    ).toBe(targetBefore.stdout);
    expect(
      (await run(sourceRoot, 'git', ['status', '--porcelain'])).stdout,
    ).toBe(sourceBefore.stdout);
  });

  it('uses the target workspace package manager for imported commands', async () => {
    await writeJson(targetRoot, 'megamono.json', DEFAULT_MEGAMONO_CONFIG);
    await run(targetRoot, 'git', ['add', 'megamono.json']);
    await run(targetRoot, 'git', ['commit', '-m', 'use pnpm']);
    await createSource(sourceRoot, false);

    const result = await analyzeRepositoryImport({
      workspaceRoot: targetRoot,
      options: { source: sourceRoot, name: 'imported-app' },
    });

    expect(result.packageManager).toBe('pnpm');
    expect(result.commands).toMatchObject({
      build: 'pnpm run build',
      test: 'pnpm run test',
      lint: 'pnpm run lint',
    });
    expect(result.ready).toBe(true);
  });

  it('validates collision destinations and plans an exact build-ready rewrite scope', async () => {
    await createSource(sourceRoot);
    const resolved = await analyzeRepositoryImport({
      workspaceRoot: targetRoot,
      options: {
        source: sourceRoot,
        name: 'imported-app',
        resolutions: {
          dependencies: { react: '^19.0.0' },
          aliases: { '@fixture/shared': '@imported/shared' },
          environment: { SHARED_TOKEN: 'IMPORTED_SHARED_TOKEN' },
        },
      },
    });

    expect(resolved.ready).toBe(true);
    expect(renderRepositoryImportReport(resolved)).toContain(
      '`@fixture/shared` → `@imported/shared` in `src/index.mjs`, `tsconfig.json`',
    );
    expect(renderRepositoryImportReport(resolved)).toContain(
      '`SHARED_TOKEN` → `IMPORTED_SHARED_TOKEN` in `.env.example`, `src/index.mjs`',
    );

    const rejected = await analyzeRepositoryImport({
      workspaceRoot: targetRoot,
      options: {
        source: sourceRoot,
        name: 'imported-app',
        resolutions: {
          aliases: {
            '@fixture/shared': '@fixture/shared',
            '@stale/alias': '@imported/stale',
          },
          environment: {
            SHARED_TOKEN: 'SHARED_TOKEN',
            STALE_TOKEN: 'IMPORTED_STALE_TOKEN',
          },
        },
      },
    });

    expect(rejected.blockers.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'import-invalid-alias-resolution',
        'import-invalid-environment-resolution',
        'import-unused-alias-resolution',
        'import-unused-environment-resolution',
      ]),
    );
    expect(rejected.ready).toBe(false);
  });

  it('clones a remote source to temporary storage and resolves its immutable SHA', async () => {
    const sourceSha = await createSource(sourceRoot, false);
    const remoteRoot = join(temporaryRoot, 'source.git');
    await run(temporaryRoot, 'git', [
      'clone',
      '--bare',
      sourceRoot,
      remoteRoot,
    ]);
    const remoteBefore = await readFile(join(remoteRoot, 'HEAD'), 'utf8');

    const analysis = await analyzeRepositoryImport({
      workspaceRoot: targetRoot,
      options: {
        source: pathToFileURL(remoteRoot).href,
        ref: 'main',
        expectedSourceSha: sourceSha,
        name: 'remote-app',
      },
    });

    expect(analysis.sourceKind).toBe('remote');
    expect(analysis.sourceSha).toBe(sourceSha);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.ready).toBe(true);
    expect(await readFile(join(remoteRoot, 'HEAD'), 'utf8')).toBe(remoteBefore);
  });

  it('reports dirty trees, SHA changes, and name collisions before mutation', async () => {
    await createSource(sourceRoot);
    await writeFile(join(sourceRoot, 'dirty.txt'), 'dirty\n', 'utf8');
    await writeFile(join(targetRoot, 'dirty.txt'), 'dirty\n', 'utf8');

    const analysis = await analyzeRepositoryImport({
      workspaceRoot: targetRoot,
      options: {
        source: '../source',
        name: 'existing-app',
        expectedSourceSha: '0'.repeat(40),
        history: 'squash',
      },
      projectNames: ['existing-app'],
    });

    expect(analysis.blockers.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'import-history-loss-not-accepted',
        'import-source-dirty-tree',
        'import-source-sha-changed',
        'import-target-dirty-tree',
      ]),
    );
    expect(analysis.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'import-project-name-collision' }),
      ]),
    );
  });

  it('rejects embedded HTTP credentials without echoing them', () => {
    expect(() =>
      sanitizedImportSource('https://token:secret@example.com/source.git'),
    ).toThrow(ImportOptionsError);
    try {
      sanitizedImportSource('https://token:secret@example.com/source.git');
    } catch (error) {
      expect((error as Error).message).not.toContain('token');
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('rejects unsafe destinations before source inspection', () => {
    for (const destination of [
      '.git/imported-app',
      '.megamono/imported-app',
      'apps//imported-app',
      'apps/../imported-app',
      '/apps/imported-app',
    ]) {
      expect(() =>
        normalizedImportDestination('imported-app', destination),
      ).toThrow(ImportOptionsError);
    }
  });

  it('reports an invalid host configuration before execution', async () => {
    await createSource(sourceRoot, false);
    await writeJson(targetRoot, 'megamono.json', { version: 1 });
    await run(targetRoot, 'git', ['add', 'megamono.json']);
    await run(targetRoot, 'git', ['commit', '-m', 'break host config']);

    const analysis = await analyzeRepositoryImport({
      workspaceRoot: targetRoot,
      options: { source: sourceRoot, name: 'imported-app' },
    });

    expect(analysis.blockers).toContainEqual(
      expect.objectContaining({ code: 'import-host-config' }),
    );
    expect(analysis.ready).toBe(false);
  });

  it('plans documentation and infrastructure routes without changing either repository', async () => {
    await createSource(sourceRoot, false, true);
    const targetBefore = (
      await run(targetRoot, 'git', ['status', '--porcelain=v1'])
    ).stdout;
    const sourceBefore = (
      await run(sourceRoot, 'git', ['status', '--porcelain=v1'])
    ).stdout;

    const analysis = await analyzeRepositoryImport({
      workspaceRoot: targetRoot,
      options: { source: sourceRoot, name: 'imported-app' },
    });
    const report = renderRepositoryImportReport(analysis);

    expect(analysis.ready).toBe(true);
    expect(analysis.documentationTopicsToExtend).toEqual(['sessions']);
    expect(analysis.repositoryRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'docs/guides/overview.md',
          destination: 'docs/specs/imported-app/guides/overview.md',
          action: 'migrate-document',
        }),
        expect.objectContaining({
          source: 'docs/decisions/preserved.md',
          destination: 'docs/decisions/preserved.md',
          document: expect.objectContaining({
            id: 'decision-20240102-use-sessions',
            date: '2024-01-02',
          }),
        }),
        expect.objectContaining({
          source: '.github/workflows/ci.yml',
          action: 'archive',
        }),
        expect.objectContaining({ source: 'nx.json', action: 'archive' }),
      ]),
    );
    expect(report).toContain('## Repository routes');
    expect(report).toContain('`sessions`');
    expect(
      (await run(targetRoot, 'git', ['status', '--porcelain=v1'])).stdout,
    ).toBe(targetBefore);
    expect(
      (await run(sourceRoot, 'git', ['status', '--porcelain=v1'])).stdout,
    ).toBe(sourceBefore);
  });

  it('blocks a documentation ID collision before the history graft', async () => {
    await createSource(sourceRoot, false, true);
    await mkdir(join(targetRoot, 'docs/decisions'), { recursive: true });
    await writeFile(
      join(targetRoot, 'docs/decisions/host.md'),
      `---
id: decision-20240102-use-sessions
type: decision
status: accepted
visibility: internal
projects: [host-app]
topics: []
summary: Existing host decision.
date: 2024-01-02
supersedes: null
references: []
external_references: []
---

# Existing host decision
`,
      'utf8',
    );
    await run(targetRoot, 'git', ['add', 'docs/decisions/host.md']);
    await run(targetRoot, 'git', ['commit', '-m', 'add host decision']);

    const analysis = await analyzeRepositoryImport({
      workspaceRoot: targetRoot,
      options: { source: sourceRoot, name: 'imported-app' },
    });

    expect(analysis.blockers).toContainEqual(
      expect.objectContaining({
        code: 'import-doc-id-collision',
        subject: 'decision-20240102-use-sessions',
      }),
    );
    expect(analysis.ready).toBe(false);
    expect(
      (await run(targetRoot, 'git', ['log', '-1', '--format=%s'])).stdout,
    ).toBe('add host decision\n');
  });

  it('blocks source code that imports a file routed out of the application', async () => {
    await createSource(sourceRoot, false, true);
    await writeFile(
      join(sourceRoot, 'src/index.mjs'),
      "import overview from '../docs/guides/overview.md';\nexport { overview };\n",
      'utf8',
    );
    await run(sourceRoot, 'git', ['add', 'src/index.mjs']);
    await run(sourceRoot, 'git', [
      'commit',
      '-m',
      'import routed documentation',
    ]);

    const analysis = await analyzeRepositoryImport({
      workspaceRoot: targetRoot,
      options: { source: sourceRoot, name: 'imported-app' },
    });

    expect(analysis.routedModuleReferences).toEqual([
      {
        sourceFile: 'src/index.mjs',
        specifier: '../docs/guides/overview.md',
        targetSource: 'docs/guides/overview.md',
        targetDestination: 'docs/specs/imported-app/guides/overview.md',
        reason: 'documentation',
      },
    ]);
    expect(analysis.blockers).toContainEqual(
      expect.objectContaining({ code: 'import-routed-module-reference' }),
    );
    expect(analysis.ready).toBe(false);
  });

  it('plans graph edges for imported dependencies owned by target projects', async () => {
    await createSource(sourceRoot, false);
    await writeJson(sourceRoot, 'package.json', {
      name: 'source-app',
      private: true,
      dependencies: { '@fixture/host-shared': '*' },
    });
    await writeFile(
      join(sourceRoot, 'src/index.mjs'),
      "import { shared } from '@fixture/host-shared';\nexport { shared };\n",
      'utf8',
    );
    await run(sourceRoot, 'git', ['add', '.']);
    await run(sourceRoot, 'git', ['commit', '-m', 'use target-owned package']);

    const analysis = await analyzeRepositoryImport({
      workspaceRoot: targetRoot,
      options: { source: sourceRoot, name: 'imported-app' },
      targetProjects: [
        { name: 'host-shared', packageName: '@fixture/host-shared' },
      ],
    });
    const report = renderRepositoryImportReport(analysis);

    expect(analysis.expectedGraphDependencies).toEqual([
      { project: 'host-shared', packageName: '@fixture/host-shared' },
    ]);
    expect(report).toContain(
      '`imported-app` → `host-shared` via `@fixture/host-shared`',
    );
    expect(analysis.ready).toBe(true);
  });
});
