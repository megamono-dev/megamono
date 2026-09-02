import { addProjectConfiguration, readJson, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { databaseGenerator } from '../generators/database/database';
import {
  createWorkspaceInitPlan,
  surveyWorkspaceInit,
} from './workspace-init-plan';
import { DEFAULT_MEGAMONO_CONFIG } from './config';

function quickzonesShapedPortfolio() {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    name: '@portfolio/workspace',
    private: true,
    packageManager: 'pnpm@11.24.0',
    dependencies: {
      '@nestjs/core': '^11.1.0',
      '@prisma/client': '^6.19.3',
      next: '^16.2.0',
    },
    devDependencies: {
      nx: '22.7.6',
      prisma: '^6.19.3',
      typescript: '~5.9.2',
    },
  });
  tree.write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  tree.write('.gitignore', 'basemarks-swift/.build/\n');
  tree.write('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'libs/*'\n");
  writeJson(tree, 'nx.json', { plugins: ['@nx/js/typescript'] });
  writeJson(tree, 'tsconfig.base.json', {
    compilerOptions: {
      paths: {
        'content-collections': ['apps/site/.content-collections/generated'],
      },
    },
  });

  addProjectConfiguration(tree, '@portfolio/site', {
    root: 'apps/site',
    targets: {
      dev: {
        executor: 'nx:run-commands',
        options: { command: 'next dev -p 4200' },
      },
    },
  });
  tree.write('apps/site/next.config.js', 'module.exports = {};\n');
  tree.write('apps/site/content-collections.ts', 'export default {};\n');
  addProjectConfiguration(tree, '@portfolio/api', {
    root: 'apps/api',
    projectType: 'application',
    targets: {
      serve: {
        executor: '@nx/js:node',
        options: { command: 'node apps/api/dist/main.js' },
      },
    },
  });
  tree.write('apps/api/tsconfig.app.json', '{}');
  addProjectConfiguration(tree, '@portfolio/mobile-app', {
    root: 'apps/mobile-app',
    projectType: 'application',
    targets: {
      build: {
        executor: 'nx:run-commands',
        options: { command: 'expo export -p ios' },
      },
    },
  });
  writeJson(tree, 'apps/mobile-app/package.json', {
    name: '@portfolio/mobile-app',
    dependencies: { expo: '57.0.10', 'react-native': '0.86.2' },
  });
  writeJson(tree, 'apps/mobile-app/app.json', { expo: {} });
  tree.write(
    'apps/api/Dockerfile',
    'RUN pnpm exec prisma generate\nCMD ["node", "main.js"]\n',
  );
  addProjectConfiguration(tree, '@portfolio/nest-data', {
    root: 'libs/nest-data',
    targets: { build: { executor: 'nx:run-commands' } },
  });
  tree.write('libs/nest-data/tsconfig.lib.json', '{}');

  tree.write(
    'prisma/schema.prisma',
    'generator client {\n  provider = "prisma-client-js"\n}\n',
  );
  tree.write('prisma/migrations/20260830_init/migration.sql', 'SELECT 1;\n');
  tree.write(
    'apps/apple/QuickzonesKit/Package.swift',
    '// swift-tools-version: 6.0\n',
  );
  tree.write(
    'apps/apple/Quickzones.xcodeproj/project.pbxproj',
    '// !$*UTF8*$!\nrootObject = PROJECT;\n',
  );
  tree.write(
    'basemarks-swift/.build/checkouts/dependency/README.md',
    '# Generated dependency documentation\n',
  );
  for (const scheme of [
    'Quickzones Mac Direct',
    'Quickzones Mac App Store',
    'Quickzones Performance',
    'Quickzones',
  ]) {
    tree.write(
      `apps/apple/Quickzones.xcodeproj/xcshareddata/xcschemes/${scheme}.xcscheme`,
      '<Scheme />\n',
    );
  }
  tree.write(
    '.github/workflows/ci.yml',
    'jobs:\n  verify:\n    steps:\n      - run: pnpm exec nx run-many -t lint test build\n',
  );
  tree.write(
    '.github/workflows/release-apple.yml',
    'jobs:\n  release:\n    steps:\n      - run: xcodebuild -scheme "Quickzones Mac App Store"\n',
  );
  for (const name of ['00-overview', '01-mac-app', '02-zones-model'])
    tree.write(`docs/specs/${name}.md`, `# ${name}\n`);
  writeJson(tree, 'megamono.json', DEFAULT_MEGAMONO_CONFIG);
  return tree;
}

describe('mixed-platform portfolio adoption fixture', () => {
  it('classifies inferred Next, Nest, and library projects without flattening platforms', () => {
    const tree = quickzonesShapedPortfolio();
    const survey = surveyWorkspaceInit(tree);
    expect(survey.baseline).toMatchObject({
      packageManager: 'pnpm@11.24.0',
      nx: '22.7.6',
      typescript: '~5.9.2',
    });
    expect(survey.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '@portfolio/site',
          type: 'application',
          platform: 'web',
        }),
        expect.objectContaining({
          name: '@portfolio/api',
          type: 'application',
          platform: 'node',
        }),
        expect.objectContaining({
          name: '@portfolio/nest-data',
          type: 'library',
        }),
        expect.objectContaining({
          name: '@portfolio/mobile-app',
          type: 'application',
          platform: 'mobile',
        }),
      ]),
    );
    expect(survey.documentation.markdown).toHaveLength(3);
    expect(survey.documentation.markdown).not.toContain(
      'basemarks-swift/.build/checkouts/dependency/README.md',
    );
    expect(survey.manifests.apple).toEqual([
      'apps/apple/QuickzonesKit/Package.swift',
    ]);
    expect(survey.existing.contentCollections).toEqual([
      'apps/site/content-collections.ts',
    ]);

    const plan = createWorkspaceInitPlan(tree, {
      only: 'docs,lint,inference',
      docsLoader: '.megamono/content-collections.ts',
      docsModule: 'megamono-docs',
      docsOutput: '.megamono/content-collections',
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.decisions).toEqual([]);
  });

  it('adopts the root Prisma project without changing mature integration files', async () => {
    const tree = quickzonesShapedPortfolio();
    const schema = tree.read('prisma/schema.prisma', 'utf8');
    const migration = tree.read(
      'prisma/migrations/20260830_init/migration.sql',
      'utf8',
    );
    const dockerfile = tree.read('apps/api/Dockerfile', 'utf8');

    await databaseGenerator(tree, {
      name: 'primary',
      adapter: 'prisma',
      interactive: false,
      yes: true,
    });

    expect(tree.read('prisma/schema.prisma', 'utf8')).toBe(schema);
    expect(
      tree.read('prisma/migrations/20260830_init/migration.sql', 'utf8'),
    ).toBe(migration);
    expect(tree.read('apps/api/Dockerfile', 'utf8')).toBe(dockerfile);
    expect(readJson(tree, 'megamono.json').databases.primary.schema).toBe(
      'prisma/schema.prisma',
    );
    expect(tree.exists('playstack.json')).toBe(false);
  });
});
