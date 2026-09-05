import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_MEGAMONO_CONFIG } from './config';
import {
  analyzeRepositoryImport,
  type RepositoryImportOptions,
} from './repository-import';
import {
  completedRepositoryImport,
  executeRepositoryImport,
  type ImportCommandRunner,
} from './repository-import-execution';

const exec = promisify(execFile);
// A nested Nx consumer must not inherit the parent test task's graph/cache context.
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('NX_')),
  ),
  CI: 'true',
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  NX_INTERACTIVE: 'false',
};
const run = async (cwd: string, command: string, args: string[]) =>
  (
    await exec(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
const json = async (root: string, path: string, value: unknown) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), JSON.stringify(value, null, 2) + '\n');
};
const seed = async (root: string, message: string) => {
  await run(root, 'git', ['init', '--initial-branch=main']);
  await run(root, 'git', ['config', 'user.name', 'Megamono fixture']);
  await run(root, 'git', ['config', 'user.email', 'fixture@megamono.com']);
  await run(root, 'git', ['add', '.']);
  await run(root, 'git', ['commit', '-m', message]);
};

describe('history-preserving monorepo imports', { timeout: 60_000 }, () => {
  let temporary: string;
  let target: string;
  let source: string;
  let sourceSha: string;
  let options: RepositoryImportOptions;
  const host = [{ name: 'sdk', root: 'libs/sdk', packageName: '@fixture/sdk' }];
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'megamono-multi-exec-'));
    target = join(temporary, 'target');
    source = join(temporary, 'source');
    await mkdir(target);
    await mkdir(source);
    await json(target, 'package.json', {
      name: 'host',
      private: true,
      workspaces: ['libs/sdk'],
    });
    await json(target, 'nx.json', { plugins: [] });
    await json(target, 'megamono.json', {
      ...DEFAULT_MEGAMONO_CONFIG,
      conventions: {
        ...DEFAULT_MEGAMONO_CONFIG.conventions,
        packageManager: 'npm',
      },
    });
    await json(target, 'libs/sdk/package.json', {
      name: '@fixture/sdk',
      version: '1.1.0',
      main: 'index.cjs',
    });
    await json(target, 'libs/sdk/project.json', {
      name: 'sdk',
      projectType: 'library',
    });
    await json(target, 'libs/sdk/tsconfig.json', {});
    await writeFile(
      join(target, 'libs/sdk/index.cjs'),
      "exports.origin = 'host';\n",
    );
    await writeFile(join(target, '.gitignore'), 'node_modules/\n.nx/\n');
    await seed(target, 'host seed');
    await run(target, 'git', [
      'update-ref',
      'refs/remotes/origin/main',
      'HEAD',
    ]);
    await run(target, 'git', [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]);
    await run(target, 'git', ['switch', '-c', 'import/fixture']);
    await json(source, 'package.json', {
      name: 'source',
      private: true,
      workspaces: ['packages/*'],
    });
    await json(source, 'nx.json', { plugins: ['never-execute-source-plugin'] });
    await json(source, 'packages/sdk/package.json', {
      name: '@fixture/sdk',
      version: '1.0.0',
      main: 'index.cjs',
    });
    await json(source, 'packages/sdk/tsconfig.json', {});
    await writeFile(
      join(source, 'packages/sdk/index.cjs'),
      "exports.origin = 'source';\n",
    );
    await json(source, 'packages/email/package.json', {
      name: '@fixture/email',
      version: '1.0.0',
      main: 'index.cjs',
      dependencies: { '@fixture/sdk': 'workspace:^1.0.0' },
    });
    await json(source, 'packages/email/tsconfig.json', {
      references: [{ path: '../sdk/tsconfig.json' }],
    });
    await writeFile(
      join(source, 'packages/email/index.cjs'),
      "module.exports = require('@fixture/sdk');\n",
    );
    await seed(source, 'source seed');
    await writeFile(join(source, 'history.txt'), 'second source commit');
    await run(source, 'git', ['add', '.']);
    await run(source, 'git', ['commit', '-m', 'source follow-up']);
    sourceSha = await run(source, 'git', ['rev-parse', 'HEAD']);
    options = {
      source,
      name: 'imported',
      destination: 'libs/imported',
      expectedSourceSha: sourceSha,
      history: 'subtree',
      verify: 'build',
      execute: true,
      monorepo: {
        projects: {
          'packages/sdk': { action: 'reuse', project: 'sdk' },
          'packages/email': {
            action: 'import',
            name: 'email',
            configuration: {
              projectType: 'library',
              tags: ['platform:node', 'scope:shared', 'type:util'],
              targets: {
                build: {
                  executor: 'nx:run-commands',
                  options: {
                    command: `node -e "require('node:assert/strict').equal(require('@fixture/email').origin, 'host')"`,
                  },
                },
              },
            },
          },
        },
      },
    };
  });
  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });
  const analyze = () =>
    analyzeRepositoryImport({
      workspaceRoot: target,
      options,
      targetProjects: host,
    });

  it.each(['reuse', 'rename'] as const)(
    '%s: retains both histories, registers projects and verifies a real Nx graph/build',
    async (mode) => {
      if (mode === 'rename') {
        const configuration = (packageName: string) => ({
          projectType: 'library' as const,
          targets: {
            build: {
              executor: 'nx:run-commands',
              options: {
                command: `node -e "require('node:assert/strict').equal(require('${packageName}').origin, 'source')"`,
              },
            },
          },
        });
        options = {
          ...options,
          monorepo: {
            projects: {
              'packages/sdk': {
                action: 'import',
                name: 'imported-sdk',
                packageName: '@fixture/imported-sdk',
                configuration: configuration('@fixture/imported-sdk'),
              },
              'packages/email': {
                action: 'import',
                name: 'email',
                configuration: configuration('@fixture/email'),
              },
            },
          },
        };
      }
      const before = await run(target, 'git', ['rev-parse', 'HEAD']);
      const analysis = await analyze();
      expect(analysis.blockers).toEqual([]);
      expect(analysis.unresolved).toEqual([]);
      expect(await run(target, 'git', ['status', '--porcelain'])).toBe('');
      const nxRoot = dirname(require.resolve('nx/package.json'));
      const nxManifest = JSON.parse(
        await readFile(join(nxRoot, 'package.json'), 'utf8'),
      );
      const nxBin = join(
        nxRoot,
        typeof nxManifest.bin === 'string' ? nxManifest.bin : nxManifest.bin.nx,
      );
      const commands: string[] = [];
      const runner: ImportCommandRunner = async (command) => {
        commands.push(command.display);
        if (command.phase === 'dependencies') {
          await run(target, 'npm', [
            'install',
            '--offline',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
          ]);
          await symlink(nxRoot, join(target, 'node_modules/nx'), 'dir');
        } else if (
          command.phase === 'graph' ||
          command.phase === 'build' ||
          command.args.includes('show')
        ) {
          // Docs and Megamono checks have their own integration fixtures. This fixture
          // executes actual package resolution, Nx discovery, dependency edges and builds.
          return run(target, process.execPath, [
            nxBin,
            ...command.args
              .slice(command.args.indexOf('nx') + 1)
              .filter((arg) => arg !== '--'),
          ]);
        }
      };
      const result = await executeRepositoryImport(
        target,
        analysis,
        options,
        runner,
      );
      expect(
        await run(target, 'git', [
          'merge-base',
          '--is-ancestor',
          sourceSha,
          'HEAD',
        ]),
      ).toBe('');
      expect(
        await run(target, 'git', [
          'merge-base',
          '--is-ancestor',
          before,
          'HEAD',
        ]),
      ).toBe('');
      expect(
        await readFile(join(target, 'libs/sdk/index.cjs'), 'utf8'),
      ).toContain("'host'");
      if (mode === 'reuse')
        await expect(
          readFile(join(target, 'libs/imported/packages/sdk/index.cjs')),
        ).rejects.toThrow('ENOENT');
      else
        expect(
          await readFile(
            join(target, 'libs/imported/packages/sdk/index.cjs'),
            'utf8',
          ),
        ).toContain("'source'");
      expect(
        await run(target, 'git', [
          'show',
          `${result.graftCommit}:.megamono-import/imported/packages/sdk/index.cjs`,
        ]),
      ).toContain("'source'");
      expect(
        JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
          .workspaces,
      ).toContain('libs/imported/packages/email');
      expect(
        JSON.parse(
          await readFile(
            join(target, 'libs/imported/packages/email/tsconfig.json'),
            'utf8',
          ),
        ).references[0].path,
      ).toBe(
        mode === 'reuse'
          ? '../../../sdk/tsconfig.json'
          : '../sdk/tsconfig.json',
      );
      expect(commands.some((command) => command.includes('email:build'))).toBe(
        true,
      );
      expect(await completedRepositoryImport(target, options)).toEqual(
        result.marker,
      );
      await expect(
        completedRepositoryImport(target, {
          ...options,
          monorepo: { projects: {} },
        }),
      ).rejects.toThrow('different monorepo project map');
      expect(await run(target, 'git', ['status', '--porcelain'])).toBe('');
      expect(await run(source, 'git', ['rev-parse', 'HEAD'])).toBe(sourceSha);
      expect(await run(source, 'git', ['status', '--porcelain'])).toBe('');
    },
  );

  it('refuses a changed reviewed map before grafting and leaves recovery after failed verification', async () => {
    const analysis = await analyze();
    const before = await run(target, 'git', ['rev-parse', 'HEAD']);
    await expect(
      executeRepositoryImport(target, analysis, {
        ...options,
        monorepo: { projects: {} },
      }),
    ).rejects.toThrow('exact reviewed project map');
    expect(await run(target, 'git', ['rev-parse', 'HEAD'])).toBe(before);
    const runner: ImportCommandRunner = async (command) => {
      if (command.phase === 'graph')
        return JSON.stringify({
          graph: {
            nodes: { sdk: {}, email: {} },
            dependencies: { email: [{ target: 'sdk' }] },
          },
        });
      if (command.phase === 'build') throw new Error('fixture build failure');
    };
    await expect(
      executeRepositoryImport(target, analysis, options, runner),
    ).rejects.toThrow();
    expect(
      await readFile(join(target, 'MEGAMONO-RECOVERY.md'), 'utf8'),
    ).toContain('email:build');
    expect(await run(target, 'git', ['log', '-1', '--format=%s'])).not.toBe(
      `import imported at ${sourceSha.slice(0, 12)}`,
    );
    expect(await run(source, 'git', ['rev-parse', 'HEAD'])).toBe(sourceSha);
    expect(await run(source, 'git', ['status', '--porcelain'])).toBe('');
  });
});
