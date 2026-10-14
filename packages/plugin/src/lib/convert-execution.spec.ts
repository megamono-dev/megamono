import {
  readJson,
  readProjectConfiguration,
  writeJson,
  type Tree,
} from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONVENTION_RULES, DEFAULT_MEGAMONO_CONFIG } from './config';
import {
  analyzeConversion,
  renderConvertReport,
  type ConvertGitState,
} from './convert';
import {
  applyConversionPlan,
  convertSubprocessEnvironment,
  conversionVerificationCommands,
  ConvertVerificationError,
  createConvertPostFlushCallback,
  hasCompletedConversion,
  renderConversionRecovery,
  runConversionVerification,
  setConvertWarningMode,
  writeConvertMarker,
} from './convert-execution';

const cleanGit: ConvertGitState = {
  available: true,
  clean: true,
  branch: 'convert/example-app',
  defaultBranch: 'main',
  baseSha: '0123456789abcdef',
};

function fixture(manifest: Record<string, unknown> = {}): Tree {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    name: 'existing-app',
    private: true,
    ...manifest,
  });
  writeJson(tree, 'package-lock.json', {
    name: 'existing-app',
    lockfileVersion: 3,
    packages: {},
  });
  return tree;
}

function acceptedAnalysis(tree: Tree, extra: Record<string, unknown> = {}) {
  return analyzeConversion(
    tree,
    {
      appName: 'example-app',
      interactive: false,
      acceptPlan: true,
      ...extra,
    },
    cleanGit,
  );
}

describe('conversion execution', () => {
  it('keeps Megamono tooling at the root when creating the application manifest', () => {
    const dependencies = { react: '^19.0.0' };
    const devDependencies = {
      '@megamono/plugin': '1.0.0',
      '@megamono/nx-cargo': '1.0.0',
      vite: '^8.0.0',
    };
    const tree = fixture({ dependencies, devDependencies });
    tree.write('src/index.ts', 'export const app = true;\n');

    applyConversionPlan(tree, acceptedAnalysis(tree));

    expect(readJson(tree, 'package.json').devDependencies).toEqual(
      devDependencies,
    );
    const application = readJson(tree, 'apps/example-app/package.json');
    expect(application.devDependencies).toEqual({ vite: '^8.0.0' });
    expect(application.dependencies).toEqual(dependencies);
  });

  it('isolates verification commands from the parent Nx task context', () => {
    expect(
      convertSubprocessEnvironment({
        NX_DAEMON: 'false',
        NX_TASK_TARGET_PROJECT: 'parent-project',
        NX_TASK_HASH: 'parent-hash',
        NX_WORKSPACE_ROOT: '/parent/workspace',
        PATH: '/fixture/bin',
      }),
    ).toEqual({ NX_DAEMON: 'false', PATH: '/fixture/bin' });
  });

  it('moves the application and preserves commands through Nx targets', () => {
    const tree = fixture({
      scripts: {
        build: 'vite build',
        test: 'vitest run',
        lint: 'eslint .',
        start: 'vite',
      },
      dependencies: { react: '^19.0.0' },
      devDependencies: { vite: '^8.0.0', vitest: '^4.0.0' },
    });
    tree.write('src/main.ts', 'export const app = true;\n');
    tree.write('vite.config.ts', 'export default {};\n');

    const analysis = acceptedAnalysis(tree);
    const result = applyConversionPlan(tree, analysis, 'product');

    expect(result).toEqual({
      appPackageName: 'existing-app',
      installedPlugins: [],
    });
    expect(tree.exists('src/main.ts')).toBe(false);
    expect(tree.read('apps/example-app/src/main.ts', 'utf8')).toContain(
      'app = true',
    );
    expect(readJson(tree, 'apps/example-app/package.json')).toMatchObject({
      name: 'existing-app',
      scripts: {
        build: 'vite build',
        test: 'vitest run',
        lint: 'eslint .',
        start: 'vite',
      },
      dependencies: { react: '^19.0.0' },
    });
    expect(readJson(tree, 'package.json')).toMatchObject({
      name: 'existing-app-workspace',
      private: true,
      workspaces: ['apps/example-app'],
      scripts: {
        build: 'nx run example-app:build',
        test: 'nx run example-app:test',
        lint: 'nx run example-app:lint',
        start: 'npm --prefix apps/example-app run start',
      },
    });
    const project = readProjectConfiguration(tree, 'example-app');
    expect(project).toMatchObject({
      root: 'apps/example-app',
      sourceRoot: 'apps/example-app/src',
      projectType: 'application',
      tags: [
        'platform:web',
        'scope:product',
        'type:app',
        'visibility:internal',
      ],
    });
    expect(project.targets?.build).toMatchObject({
      executor: 'nx:run-commands',
      cache: true,
      options: {
        command: 'npm run build',
        cwd: 'apps/example-app',
      },
    });
    expect(project.targets?.deploy).toBeUndefined();
  });

  it('preserves pnpm workspace configuration and command families', () => {
    const tree = fixture({
      packageManager: 'pnpm@11.24.0',
      scripts: { build: 'node build.mjs', start: 'node server.mjs' },
    });
    tree.delete('package-lock.json');
    tree.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    tree.write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    tree.write('src/index.ts', 'export {};\n');

    const analysis = acceptedAnalysis(tree, { verify: 'build' });
    applyConversionPlan(tree, analysis);

    expect(readJson(tree, 'package.json')).toMatchObject({
      packageManager: 'pnpm@11.24.0',
      scripts: {
        build: 'nx run example-app:build',
        start: 'pnpm --dir apps/example-app run start',
      },
    });
    expect(tree.read('pnpm-workspace.yaml', 'utf8')).toBe(
      "packages:\n  - 'apps/example-app'\n  - 'packages/*'\n",
    );
    expect(conversionVerificationCommands(analysis)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'pnpm',
          display: 'pnpm exec nx run megamono:check',
        }),
        expect.objectContaining({
          command: 'pnpm',
          display: 'pnpm exec nx run example-app:build',
        }),
      ]),
    );
  });

  it('moves explicit extractions, adds aliases, and rewrites consumers', () => {
    const tree = fixture({ scripts: { build: 'tsc' } });
    tree.write(
      'src/index.ts',
      "import { shared } from './shared';\nexport { shared };\n",
    );
    tree.write('src/shared/index.ts', 'export const shared = true;\n');

    const analysis = acceptedAnalysis(tree, {
      extract: ['src/shared:libs/shared'],
    });
    applyConversionPlan(tree, analysis, 'product');

    expect(tree.read('libs/shared/index.ts', 'utf8')).toContain(
      'shared = true',
    );
    expect(tree.read('apps/example-app/src/index.ts', 'utf8')).toContain(
      "from '@product/shared'",
    );
    expect(readProjectConfiguration(tree, 'shared')).toMatchObject({
      root: 'libs/shared',
      projectType: 'library',
      tags: ['scope:product', 'type:util'],
    });
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toEqual(
      expect.objectContaining({
        '@product/shared': ['./libs/shared/index.ts'],
        '@product/shared/*': ['./libs/shared/*'],
      }),
    );
    expect(readJson(tree, 'package.json').workspaces).toEqual([
      'apps/example-app',
      'libs/shared',
    ]);
  });

  it('registers detected non-JS inference plugins', () => {
    const tree = fixture();
    tree.write('src/index.ts', 'export {};\n');
    tree.write('apple/Package.swift', '// swift-tools-version: 6.0\n');
    tree.write('native/Cargo.toml', '[package]\nname = "native"\n');

    const result = applyConversionPlan(tree, acceptedAnalysis(tree));

    expect(result.installedPlugins).toEqual([
      '@megamono/nx-apple',
      '@megamono/nx-cargo',
    ]);
    expect(readJson(tree, 'nx.json').plugins).toEqual(
      expect.arrayContaining(['@megamono/nx-apple', '@megamono/nx-cargo']),
    );
  });

  it('sets every conversion convention to warning mode', () => {
    const tree = fixture();
    writeJson(tree, 'megamono.json', DEFAULT_MEGAMONO_CONFIG);

    setConvertWarningMode(tree);

    const config = readJson(tree, 'megamono.json');
    expect(Object.keys(config.conventions.rules).sort()).toEqual(
      [...CONVENTION_RULES].sort(),
    );
    expect(Object.values(config.conventions.rules)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'warning' }),
      ]),
    );
    expect(
      Object.values(config.conventions.rules).every(
        (rule) => (rule as { severity: string }).severity === 'warning',
      ),
    ).toBe(true);
  });

  it('runs config then build and test verification in stable order', async () => {
    const tree = fixture({
      scripts: { build: 'node build.mjs', test: 'node --test' },
    });
    tree.write('src/index.ts', 'export {};\n');
    const analysis = acceptedAnalysis(tree, { verify: 'build' });
    const seen: string[] = [];

    await runConversionVerification(
      '/workspace',
      analysis,
      async (command, root) => {
        expect(root).toBe('/workspace');
        seen.push(command.display);
      },
    );

    expect(seen).toEqual(
      conversionVerificationCommands(analysis).map(({ display }) => display),
    );
    expect(seen.slice(-2)).toEqual([
      'npm exec nx -- run example-app:build',
      'npm exec nx -- run example-app:test',
    ]);
  });

  it('identifies the exact failed command for recovery', async () => {
    const tree = fixture();
    tree.write('src/index.ts', 'export {};\n');
    const analysis = acceptedAnalysis(tree);

    await expect(
      runConversionVerification('/workspace', analysis, async (command) => {
        if (command.display.includes('megamono:check')) {
          throw new Error('fixture failure');
        }
      }),
    ).rejects.toMatchObject({
      verification: {
        phase: 'config',
        display: 'npm exec nx -- run megamono:check',
      },
    });
    try {
      await runConversionVerification(
        '/workspace',
        analysis,
        async (command) => {
          if (command.display.includes('megamono:check')) throw new Error();
        },
      );
    } catch (error) {
      const failure = error as ConvertVerificationError;
      expect(
        renderConversionRecovery(analysis, failure.verification),
      ).toContain('- Retry command: `npm exec nx -- run megamono:check`');
    }
  });

  it('records completed conversions and validates idempotent reruns', () => {
    const tree = fixture({ scripts: { build: 'node build.mjs' } });
    tree.write('src/index.ts', 'export {};\n');
    const analysis = acceptedAnalysis(tree);
    applyConversionPlan(tree, analysis);
    const report = renderConvertReport(analysis);
    writeConvertMarker(tree, analysis, report);

    expect(
      hasCompletedConversion(tree, 'example-app', '.', 'apps/example-app'),
    ).toMatchObject({
      schemaVersion: 1,
      appName: 'example-app',
      baseSha: '0123456789abcdef',
      report,
    });
    expect(() =>
      hasCompletedConversion(tree, 'example-app', '.', 'apps/different'),
    ).toThrow('already uses');
  });

  it('writes post-flush recovery with the exact failed verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-convert-recovery-'));
    const tree = fixture();
    tree.write('src/index.ts', 'export {};\n');
    const analysis = acceptedAnalysis(tree);
    const callback = createConvertPostFlushCallback(
      root,
      analysis,
      [async () => undefined],
      async () => undefined,
      async (command) => {
        if (command.display.includes('megamono:check')) {
          throw new Error('fixture verification failure');
        }
      },
    );
    try {
      await expect(callback()).rejects.toThrow(ConvertVerificationError);
      const recovery = await readFile(
        join(root, 'MEGAMONO-RECOVERY.md'),
        'utf8',
      );
      expect(recovery).toContain('stopped during the `config` phase');
      expect(recovery).toContain(
        '- Failed command: `npm exec nx -- run megamono:check`',
      );
      expect(recovery).toContain('- Rollback base: `0123456789abcdef`');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
