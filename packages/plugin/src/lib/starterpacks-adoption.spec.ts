import { addProjectConfiguration, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import {
  createWorkspaceInitPlan,
  renderWorkspaceInitSurvey,
  surveyWorkspaceInit,
} from './workspace-init-plan';

function starterpacksShapedWorkspace() {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    name: '@fixture/starterpacks',
    private: true,
    packageManager: 'yarn@1.22.22',
    engines: { node: '22' },
    dependencies: {
      '@nestjs/bullmq': '^11.0.2',
      '@nestjs/core': '^11.0.5',
      '@prisma/client': '^6.0.1',
      bullmq: '^5.40.0',
      next: '^15.3.0',
      react: '^19.0.0',
      redis: '^5.5.6',
    },
    devDependencies: {
      nx: '22.0.2',
      prisma: '^6.0.1',
      typescript: '^5.6.3',
    },
  });
  tree.write('yarn.lock', '# fixture lockfile\n');
  tree.write('.gitignore', '.yalc/\n.next/\ndump.rdb\nlocal-scripts/\n');

  addProjectConfiguration(tree, 'site', {
    root: 'apps/site',
    projectType: 'application',
    targets: { dev: { executor: '@nx/next:server' } },
    tags: ['type:app', 'platform:web', 'scope:starterpacks'],
  });
  tree.write(
    'apps/site/next.config.mjs',
    'export default { cacheHandler: "./cache-handler.mjs" };\n',
  );
  tree.write(
    'apps/site/src/pages/index.tsx',
    'export default function Page() { return null; }\n',
  );
  tree.write(
    'apps/site/cache-handler.mjs',
    "import { createClient } from 'redis';\nprocess.env.REDIS_URL;\n",
  );
  tree.write('apps/site/.next/server/pages/index.js', 'generated\n');

  addProjectConfiguration(tree, 'api', {
    root: 'apps/api',
    projectType: 'application',
    targets: { serve: { executor: '@nx/js:node' } },
    tags: ['type:app', 'platform:node', 'scope:starterpacks'],
  });
  tree.write(
    'apps/api/src/main.ts',
    "import { NestFactory } from '@nestjs/core';\nprocess.env.DATABASE_URL;\n",
  );
  tree.write('apps/api/Dockerfile', 'CMD ["node", "dist/apps/api/main.js"]\n');

  addProjectConfiguration(tree, 'firehose', {
    root: 'apps/firehose',
    projectType: 'application',
    targets: { serve: { executor: '@nx/js:node' } },
    tags: ['type:app', 'platform:node', 'scope:starterpacks'],
  });
  tree.write(
    'apps/firehose/src/main.ts',
    [
      "import { NestFactory } from '@nestjs/core';",
      "import { Processor } from '@nestjs/bullmq';",
      "import { Queue } from 'bullmq';",
      'process.env.REDIS_URL;',
      '',
    ].join('\n'),
  );

  for (const context of ['primary', 'auth']) {
    const root =
      context === 'primary' ? 'libs/prisma/schema' : 'libs/prisma/schema-auth';
    addProjectConfiguration(tree, `prisma-${context}`, {
      root,
      projectType: 'library',
      targets: { generate: { executor: 'nx:run-commands' } },
      tags: ['type:data', 'platform:node', 'scope:starterpacks'],
    });
    tree.write(
      `${root}/prisma/schema.prisma`,
      [
        'datasource db {',
        '  provider = "postgresql"',
        `  url = env("${context === 'primary' ? 'DATABASE_URL' : 'AUTH_DATABASE_URL'}")`,
        '}',
        '',
        `model ${context === 'primary' ? 'User' : 'AuthSession'} {`,
        '  id Int @id @default(autoincrement())',
        '}',
        '',
      ].join('\n'),
    );
    tree.write(`${root}/prisma/migrations/init/migration.sql`, 'SELECT 1;\n');
  }

  tree.write(
    'Procfile',
    'web: yarn nx run api:serve:production\nworker: yarn nx run firehose:serve:production\n',
  );
  tree.write('.yalc/@playstack/core/package.json', '{}\n');
  tree.write('dump.rdb', 'local redis state\n');
  tree.write('local-scripts/notes.md', '# unrelated local notes\n');
  return tree;
}

describe('Starterpacks-shaped mature workspace adoption', () => {
  it('reports the complete nested integration topology without generated or local artifacts', () => {
    const tree = starterpacksShapedWorkspace();
    const survey = surveyWorkspaceInit(tree);

    expect(survey.baseline).toMatchObject({
      packageManager: 'yarn@1.22.22',
      node: '22',
      nx: '22.0.2',
      typescript: '^5.6.3',
    });
    expect(survey.inventory.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'site',
          nextRouter: 'pages',
          environmentNames: ['REDIS_URL'],
          serviceKinds: ['cache'],
        }),
        expect.objectContaining({
          name: 'api',
          environmentNames: ['DATABASE_URL'],
        }),
        expect.objectContaining({
          name: 'firehose',
          environmentNames: ['REDIS_URL'],
          serviceKinds: ['queue'],
        }),
      ]),
    );
    expect(survey.inventory.databases).toEqual([
      expect.objectContaining({
        name: null,
        schema: 'libs/prisma/schema-auth/prisma/schema.prisma',
        project: 'prisma-auth',
      }),
      expect.objectContaining({
        name: null,
        schema: 'libs/prisma/schema/prisma/schema.prisma',
        project: 'prisma-primary',
      }),
    ]);
    expect(survey.inventory.deployments).toContainEqual({
      provider: 'render',
      authority: 'partial-marker',
      paths: ['Procfile'],
      services: ['web', 'worker'],
    });
    expect(survey.inventory.ambiguities).toHaveLength(2);
    expect(survey.documentation.markdown).toEqual([]);
    expect(renderWorkspaceInitSurvey(survey)).not.toContain(
      'local-scripts/notes.md',
    );
  });

  it('produces a conflict-free minimal adoption plan without enabling full governance', () => {
    const plan = createWorkspaceInitPlan(starterpacksShapedWorkspace(), {
      profile: 'minimal',
    });

    expect(plan.modules).toEqual(['lint', 'health']);
    expect(plan.conflicts).toEqual([]);
    expect(plan.decisions).toEqual([]);
    expect(plan.operations.some(({ module }) => module === 'docs')).toBe(false);
    expect(plan.suggestedCommitBatches.map(({ id }) => id)).toEqual([
      'baseline-lint',
      'health',
    ]);
  });
});
