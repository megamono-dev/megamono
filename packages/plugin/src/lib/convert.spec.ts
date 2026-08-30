import { writeJson, type Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  analyzeConversion,
  assertConversionReady,
  collectConvertGitState,
  ConvertDecisionError,
  ConvertOptionsError,
  ConvertPreflightError,
  renderConvertReport,
  renderPersistedConvertReport,
  workspaceRelativeReportPath,
  type ConvertAnalysisOptions,
  type ConvertGitState,
} from './convert';

const executeFile = promisify(execFile);

const cleanFeatureBranch: ConvertGitState = {
  available: true,
  clean: true,
  branch: 'convert/example-app',
  defaultBranch: 'main',
  baseSha: '0123456789abcdef',
};

function createFixture(manifest: Record<string, unknown> = {}): Tree {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    name: 'fixture',
    private: true,
    ...manifest,
  });
  writeJson(tree, 'package-lock.json', {
    name: 'fixture',
    lockfileVersion: 3,
    packages: {},
  });
  return tree;
}

function analyze(
  tree: Tree,
  options: Partial<ConvertAnalysisOptions> = {},
  git: ConvertGitState = cleanFeatureBranch,
) {
  return analyzeConversion(
    tree,
    {
      appName: 'example-app',
      interactive: false,
      acceptPlan: true,
      ...options,
    },
    git,
  );
}

describe('conversion analysis', () => {
  it('creates a stable, accepted plan for a single-package Vite app', () => {
    const tree = createFixture({
      scripts: {
        build: 'vite build',
        test: 'vitest run',
        lint: 'eslint .',
        deploy: 'node scripts/deploy.mjs',
      },
      dependencies: { react: '^19.0.0' },
      devDependencies: { vite: '^7.0.0', vitest: '^3.0.0' },
    });
    tree.write('src/main.ts', 'export const app = true;\n');
    tree.write('vite.config.ts', 'export default {};\n');
    tree.write('public/favicon.svg', '<svg />\n');

    const result = analyze(tree);

    expect(result.ready).toBe(true);
    expect(result.detection).toMatchObject({
      packageManager: 'npm',
      shape: 'single-package',
      framework: 'vite',
      testRunner: 'vitest',
      commands: {
        build: 'npm run build',
        test: 'npm run test',
        lint: 'npm run lint',
        deploy: 'npm run deploy',
      },
    });
    expect(result.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'move',
          source: 'src',
          destination: 'apps/example-app/src',
        }),
        expect.objectContaining({
          kind: 'wrap-target',
          target: 'deploy',
          command: 'npm run deploy',
        }),
      ]),
    );
    expect(result.operations.map(({ phase }) => phase)).toEqual(
      [...result.operations.map(({ phase }) => phase)].sort(
        (left, right) =>
          ['restructure', 'targets', 'conventions', 'docs'].indexOf(left) -
          ['restructure', 'targets', 'conventions', 'docs'].indexOf(right),
      ),
    );

    const report = renderConvertReport(result);
    expect(renderConvertReport(result)).toBe(report);
    expect(report).toContain('Rollback base: `0123456789abcdef`');
    expect(report).toContain('Ready: `true`');

    const persisted = renderPersistedConvertReport(
      result,
      new Date('2026-08-24T12:34:56.000Z'),
    );
    expect(persisted).toContain(
      'id: "report-convert-example-app-20260824T123456Z"',
    );
    expect(persisted).toContain('type: "report"');
    expect(persisted).toContain('status: "generated"');
    expect(persisted).toContain('date: "2026-08-24"');
    expect(persisted).toContain(
      'references: ["decision-20260824-adopt-megamono-repository-structure"]',
    );
    expect(persisted).toContain(report.trimEnd());
  });

  it('preserves npm workspace roots as repository infrastructure', () => {
    const tree = createFixture({
      workspaces: ['packages/*'],
      scripts: { build: 'node build.mjs' },
    });
    tree.write('src/index.ts', 'export {};\n');
    writeJson(tree, 'packages/shared/package.json', {
      name: '@fixture/shared',
    });
    tree.write('packages/shared/src/index.ts', 'export const shared = true;\n');

    const result = analyze(tree);

    expect(result.ready).toBe(true);
    expect(result.detection.shape).toBe('package-json-workspaces');
    expect(result.detection.workspacePatterns).toEqual(['packages/*']);
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: 'packages' }),
    );
  });

  it('preserves pnpm workspace roots and commands', () => {
    const tree = createFixture({
      packageManager: 'pnpm@11.24.0',
      scripts: { build: 'node build.mjs' },
    });
    tree.delete('package-lock.json');
    tree.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    tree.write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    tree.write('src/index.ts', 'export {};\n');
    writeJson(tree, 'packages/shared/package.json', {
      name: '@fixture/shared',
    });

    const result = analyze(tree);

    expect(result.ready).toBe(true);
    expect(result.detection).toMatchObject({
      packageManager: 'pnpm',
      shape: 'pnpm-workspaces',
      workspacePatterns: ['packages/*'],
      commands: { build: 'pnpm run build' },
    });
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: 'packages' }),
    );
  });

  it('requires explicit decisions for ambiguous files and plan acceptance', () => {
    const tree = createFixture();
    tree.write('src/index.ts', 'export {};\n');
    tree.write('notes.txt', 'What owns this file?\n');

    const result = analyze(tree, { acceptPlan: false });

    expect(result.ready).toBe(false);
    expect(result.unresolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'convert-unclassified-path',
          path: 'notes.txt',
        }),
        expect.objectContaining({ code: 'convert-plan-acceptance' }),
      ]),
    );
    expect(() => assertConversionReady(result)).toThrow(ConvertDecisionError);
    try {
      assertConversionReady(result);
    } catch (error) {
      expect((error as ConvertDecisionError).exitCode).toBe(4);
    }
  });

  it('applies explicit root ownership resolutions without changing the tree', () => {
    const tree = createFixture();
    tree.write('src/index.ts', 'export {};\n');
    tree.write('assets/model.bin', 'fixture\n');
    tree.write('operations/runbook.md', '# Keep at root\n');
    const changesBefore = tree.listChanges();

    const result = analyze(tree, {
      resolutions: {
        assets: 'application',
        operations: 'infrastructure',
      },
    });

    expect(result.ready).toBe(true);
    expect(result.operations).toContainEqual(
      expect.objectContaining({
        kind: 'move',
        source: 'assets',
        destination: 'apps/example-app/assets',
      }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: 'operations' }),
    );
    expect(tree.listChanges()).toEqual(changesBefore);
  });

  it('refuses stale ownership resolutions', () => {
    const tree = createFixture();
    tree.write('src/index.ts', 'export {};\n');

    const result = analyze(tree, {
      resolutions: { missing: 'application' },
    });

    expect(result.unresolved).toContainEqual(
      expect.objectContaining({
        code: 'convert-unused-resolution',
        path: 'missing',
      }),
    );
  });

  it.each([
    [
      'dirty working tree',
      cleanFeatureBranch,
      { clean: false },
      'convert-dirty-tree',
    ],
    [
      'default branch',
      cleanFeatureBranch,
      { branch: 'main' },
      'convert-default-branch',
    ],
  ])('blocks %s before mutation', (_label, base, override, code) => {
    const tree = createFixture();
    tree.write('src/index.ts', 'export {};\n');
    const result = analyze(tree, {}, { ...base, ...override });

    expect(result.blockers).toContainEqual(expect.objectContaining({ code }));
    expect(() => assertConversionReady(result)).toThrow(ConvertPreflightError);
  });

  it('reports unsupported package managers and orchestrators', () => {
    const tree = createFixture({ packageManager: 'bower@1.8.14' });
    tree.write('src/index.ts', 'export {};\n');
    tree.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    writeJson(tree, 'turbo.json', { tasks: {} });

    const result = analyze(tree);

    expect(
      result.blockers
        .filter(({ code }) => code === 'convert-unsupported-orchestrator')
        .map(({ path }) => path),
    ).toEqual(['turbo.json']);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: 'convert-package-lock',
        message: expect.stringContaining('conflicting'),
      }),
    );
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: 'convert-unsupported-package-manager',
        path: 'package.json',
      }),
    );
    expect(result.ready).toBe(false);
  });

  it('plans available non-JS plugins and blocks unsupported ecosystems', () => {
    const tree = createFixture();
    tree.write('src/index.ts', 'export {};\n');
    tree.write('apple/Package.swift', '// swift-tools-version: 6.0\n');
    tree.write('apple/Sources/App/main.swift', 'print("Hello")\n');
    tree.write('native/Cargo.toml', '[package]\nname = "native"\n');
    tree.write('native/src/main.rs', 'fn main() {}\n');
    writeJson(tree, 'server/composer.json', { require: {} });

    const result = analyze(tree);

    expect(result.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'install-plugin',
          detail: expect.stringContaining('@megamono/nx-apple'),
        }),
        expect.objectContaining({
          kind: 'install-plugin',
          detail: expect.stringContaining('@megamono/nx-cargo'),
        }),
      ]),
    );
    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        code: 'convert-plugin-unavailable',
        path: 'server/composer.json',
      }),
    );
    expect(result.unresolved).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'apple' }),
        expect.objectContaining({ path: 'native' }),
        expect.objectContaining({ path: 'server' }),
      ]),
    );
  });

  it('rejects invalid or unsafe runtime options with exit code 2', () => {
    const tree = createFixture();
    const invalidOptions = [
      { appName: 'Not Valid' },
      { appName: 'valid', destination: '../outside' },
      { appName: 'valid', verify: 'everything' },
      { appName: 'valid', extract: ['missing-separator'] },
    ];

    for (const options of invalidOptions) {
      expect(() =>
        analyzeConversion(
          tree,
          options as ConvertAnalysisOptions,
          cleanFeatureBranch,
        ),
      ).toThrow(ConvertOptionsError);
      try {
        analyzeConversion(
          tree,
          options as ConvertAnalysisOptions,
          cleanFeatureBranch,
        );
      } catch (error) {
        expect((error as ConvertOptionsError).exitCode).toBe(2);
      }
    }
  });

  it('keeps persisted reports inside the workspace', () => {
    expect(
      workspaceRelativeReportPath('/workspace', 'reports/convert.md'),
    ).toBe('reports/convert.md');
    expect(() =>
      workspaceRelativeReportPath('/workspace', '../convert.md'),
    ).toThrow(ConvertOptionsError);
  });

  it('collects the clean branch and remote rollback base from Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-convert-git-'));
    const git = (...args: string[]) =>
      executeFile('git', args, { cwd: root, encoding: 'utf8' });
    try {
      await git('init', '--initial-branch=main');
      await git('config', 'user.name', 'Megamono fixture');
      await git('config', 'user.email', 'fixture@megamono.dev');
      await writeFile(join(root, 'fixture.txt'), 'clean\n');
      await git('add', 'fixture.txt');
      await git('commit', '-m', 'fixture');
      await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      await git(
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
        'refs/remotes/origin/main',
      );
      await git('switch', '-c', 'convert/example-app');
      const expectedBase = (await git('rev-parse', 'HEAD')).stdout.trim();

      expect(await collectConvertGitState(root)).toEqual({
        available: true,
        clean: true,
        branch: 'convert/example-app',
        defaultBranch: 'main',
        baseSha: expectedBase,
      });

      await writeFile(join(root, 'fixture.txt'), 'dirty\n');
      expect(await collectConvertGitState(root)).toMatchObject({
        available: true,
        clean: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
