import { writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import {
  createWorkspaceInitPlan,
  surveyWorkspaceInit,
} from './workspace-init-plan';

function fixture() {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    name: '@fixture/workspace',
    private: true,
    workspaces: ['apps/*', 'libs/*'],
    packageManager: 'pnpm@11.24.0',
    engines: { node: '24' },
    devDependencies: { nx: '23.1.1', typescript: '5.9.3', eslint: '9.39.0' },
  });
  tree.write('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - libs/*\n');
  for (const [name, root] of [
    ['api', 'apps/api'],
    ['extension', 'apps/extension'],
    ['ingestion', 'apps/ingestion'],
    ['workers-shared', 'libs/workers-shared'],
  ]) {
    writeJson(tree, `${root}/package.json`, {
      name: `@fixture/${name}`,
      private: true,
      nx: {
        name,
        projectType: name === 'workers-shared' ? 'library' : 'application',
      },
      ...(name === 'api'
        ? { dependencies: { '@nestjs/core': '^11.0.0' } }
        : {}),
      scripts: { build: name === 'extension' ? 'vite build' : 'tsc' },
    });
  }
  tree.write(
    'apps/ingestion/wrangler.jsonc',
    '{"name":"ingestion","main":"src/index.ts"}',
  );
  tree.write(
    'apps/ingestion/src/index.ts',
    'import { shared } from "@fixture/workers-shared"; export default { fetch: shared };',
  );
  writeJson(tree, 'libs/workers-shared/tsconfig.lib.json', {
    compilerOptions: { types: ['@cloudflare/workers-types'] },
  });
  for (const browser of ['chrome', 'firefox'])
    writeJson(tree, `apps/extension/manifest.${browser}.json`, {
      manifest_version: 3,
      name: 'Fixture',
      version: '1.0.0',
    });
  writeJson(tree, 'apps/extension/dist/manifest.json', {
    manifest_version: 3,
    name: 'Generated',
    version: '1.0.0',
  });
  tree.write(
    'render.yaml',
    'services:\n  - type: web\n    name: basemarks-api\n    runtime: node\n    buildCommand: pnpm nx build api\n    startCommand: node dist/apps/api/main.js\n',
  );
  tree.write(
    '.github/workflows/release.yml',
    '# repository-owned release gate\n',
  );
  tree.write('local-notes.txt', 'unrelated uncommitted work\n');
  return tree;
}

describe('Basemarks-shaped package-manifest adoption', () => {
  it('surveys nested package projects without project.json and leaves Render mapping reviewed', () => {
    const tree = fixture();
    const before = tree.listChanges();
    const survey = surveyWorkspaceInit(tree);
    expect(survey.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'api', platform: 'node' }),
        expect.objectContaining({ name: 'ingestion', platform: 'worker' }),
        expect.objectContaining({ name: 'extension', platform: 'extension' }),
        expect.objectContaining({
          name: 'workers-shared',
          platform: 'worker',
          type: 'library',
        }),
      ]),
    );
    expect(survey.inventory.projects.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'api',
        'extension',
        'ingestion',
        'workers-shared',
      ]),
    );
    expect(JSON.stringify(survey.inventory)).not.toContain(
      'dist/manifest.json',
    );
    const plan = createWorkspaceInitPlan(tree, { profile: 'pilot' });
    expect(JSON.stringify(plan.decisions)).toContain('basemarks-api');
    expect(plan.modules).toEqual(['lint', 'health', 'inference']);
    expect(tree.listChanges()).toEqual(before);
  });

  it('accepts reviewed Render/project mappings without taking CI or release ownership', () => {
    const tree = fixture();
    writeJson(tree, '.megamono/adoption.json', {
      projects: { 'workers-shared': { type: 'util', platform: 'worker' } },
    });
    const plan = createWorkspaceInitPlan(tree, {
      profile: 'pilot',
      adoptionMap: '.megamono/adoption.json',
      renderServiceProjects: JSON.stringify({
        'basemarks-api': { project: 'api', root: 'apps/api' },
      }),
    });
    expect(plan.decisions).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(
      plan.operations.some(({ module }) =>
        ['ci', 'release', 'docs', 'agents'].includes(module),
      ),
    ).toBe(false);
    expect(tree.read('local-notes.txt', 'utf8')).toBe(
      'unrelated uncommitted work\n',
    );
  });
});
