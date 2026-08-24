import { writeJson, type Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { ConvertDecisionError, type ConvertGitState } from '../../lib/convert';
import { convertGenerator } from './convert';

const cleanGit: ConvertGitState = {
  available: true,
  clean: true,
  branch: 'convert/example-app',
  defaultBranch: 'main',
  baseSha: '0123456789abcdef',
};

function fixture(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    name: 'existing-app',
    private: true,
    scripts: {
      build: 'vite build',
      test: 'vitest run',
      lint: 'eslint .',
    },
    devDependencies: {
      '@megamono/plugin': '0.0.1',
      nx: '23.1.1',
      vite: '^8.0.0',
      vitest: '^4.0.0',
    },
  });
  writeJson(tree, 'package-lock.json', {
    name: 'existing-app',
    lockfileVersion: 3,
    packages: {},
  });
  tree.write('src/main.ts', 'export const app = true;\n');
  tree.write('vite.config.ts', 'export default {};\n');
  return tree;
}

describe('convert generator', () => {
  it('applies the accepted plan, conventions, docs seed, and report', async () => {
    const tree = fixture();

    const callback = await convertGenerator(
      tree,
      {
        appName: 'example-app',
        interactive: false,
        acceptPlan: true,
        verify: 'none',
        report: 'docs/reports/example-app-convert.md',
        scope: 'product',
      },
      { gitState: cleanGit, pluginVersion: '0.0.1' },
    );

    expect(callback).toBeTypeOf('function');
    expect(tree.exists('apps/example-app/src/main.ts')).toBe(true);
    expect(tree.exists('apps/example-app/project.json')).toBe(true);
    expect(tree.exists('megamono.json')).toBe(true);
    expect(tree.exists('docs/DESIGN.md')).toBe(true);
    expect(
      tree
        .children('docs/decisions')
        .some((path) =>
          path.endsWith('-adopt-megamono-repository-structure.md'),
        ),
    ).toBe(true);
    expect(tree.read('docs/reports/example-app-convert.md', 'utf8')).toContain(
      '# Megamono conversion analysis',
    );
    expect(tree.exists('.megamono/conversions/example-app.json')).toBe(true);
    const config = JSON.parse(tree.read('megamono.json', 'utf8') ?? '');
    expect(config.platforms).toContain('web');
    expect(
      Object.values(config.conventions.rules).every(
        (rule) => (rule as { severity: string }).severity === 'warning',
      ),
    ).toBe(true);
  }, 15_000);

  it('is a no-op when the completed conversion is rerun', async () => {
    const tree = fixture();
    const options = {
      appName: 'example-app',
      interactive: false,
      acceptPlan: true,
      verify: 'none' as const,
    };
    await convertGenerator(tree, options, {
      gitState: cleanGit,
      pluginVersion: '0.0.1',
    });
    const changes = tree.listChanges();

    expect(await convertGenerator(tree, options)).toBeUndefined();
    expect(tree.listChanges()).toEqual(changes);
  }, 15_000);

  it('keeps dry-run analysis mutation-free without plan acceptance', async () => {
    const tree = fixture();
    const changes = tree.listChanges();

    expect(
      await convertGenerator(
        tree,
        {
          appName: 'example-app',
          interactive: false,
          acceptPlan: false,
          dryRun: true,
        },
        { gitState: cleanGit },
      ),
    ).toBeUndefined();
    expect(tree.listChanges()).toEqual(changes);
  });

  it('refuses an unaccepted execution before changing the tree', async () => {
    const tree = fixture();
    const changes = tree.listChanges();

    await expect(
      convertGenerator(
        tree,
        {
          appName: 'example-app',
          interactive: false,
          acceptPlan: false,
        },
        { gitState: cleanGit },
      ),
    ).rejects.toBeInstanceOf(ConvertDecisionError);
    expect(tree.listChanges()).toEqual(changes);
  });
});
