import { readJson, writeJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MEGAMONO_CONFIG } from '../../lib/config';
import { databaseGenerator } from './database';

function workspace(manager: 'npm' | 'pnpm' = 'pnpm') {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'package.json', {
    name: '@fixture/workspace',
    private: true,
    ...(manager === 'npm' ? { workspaces: ['packages/*'] } : {}),
  });
  tree.write(
    manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json',
    manager === 'pnpm' ? 'lockfileVersion: 9\n' : '{"lockfileVersion":3}\n',
  );
  if (manager === 'pnpm') {
    tree.write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  }
  writeJson(tree, 'megamono.json', {
    ...DEFAULT_MEGAMONO_CONFIG,
    conventions: {
      ...DEFAULT_MEGAMONO_CONFIG.conventions,
      packageManager: manager,
    },
  });
  return tree;
}

describe('database generator', () => {
  it('creates a user-named Prisma target and reruns without a diff', async () => {
    const tree = workspace();
    await databaseGenerator(tree, {
      name: 'events',
      adapter: 'prisma',
      interactive: false,
      yes: true,
    });

    expect(readJson(tree, 'megamono.json').databases).toEqual({
      events: {
        adapter: 'prisma',
        project: 'fixture-workspace-prisma-events',
        schema: 'libs/prisma/events/prisma/schema.prisma',
      },
    });
    expect(readJson(tree, 'playstack.json').databases).toEqual({
      events: {
        adapter: 'prisma',
        target: 'libs/prisma/events/prisma',
      },
    });
    expect(
      tree.read('libs/prisma/events/prisma/schema.prisma', 'utf8'),
    ).toContain('provider = "prisma-client"');
    expect(
      readJson(tree, 'libs/prisma/events/project.json').targets.validate.options
        .command,
    ).toBe('prisma validate --schema prisma');
    expect(tree.read('pnpm-workspace.yaml', 'utf8')).toContain(
      "- 'libs/prisma/events'",
    );

    const before = tree
      .listChanges()
      .map(({ path, content }) => [path, content?.toString()]);
    await databaseGenerator(tree, {
      name: 'events',
      adapter: 'prisma',
      interactive: false,
      yes: true,
    });
    expect(
      tree
        .listChanges()
        .map(({ path, content }) => [path, content?.toString()]),
    ).toEqual(before);
  });

  it('adds nested projects only to the pnpm packages block', async () => {
    const tree = workspace();
    tree.write(
      'pnpm-workspace.yaml',
      [
        'packages:',
        "  - 'apps/*'",
        "  - 'packages/*'",
        'autoInstallPeers: true',
        'allowBuilds:',
        "  '@swc/core': true",
        '  nx: true',
        '',
      ].join('\n'),
    );

    await databaseGenerator(tree, {
      name: 'primary',
      adapter: 'prisma',
      interactive: false,
      yes: true,
    });

    expect(tree.read('pnpm-workspace.yaml', 'utf8')).toBe(
      [
        'packages:',
        "  - 'apps/*'",
        "  - 'packages/*'",
        "  - 'libs/prisma/primary'",
        'autoInstallPeers: true',
        'allowBuilds:',
        "  '@swc/core': true",
        '  nx: true',
        '',
      ].join('\n'),
    );
  });

  it('creates a Drizzle target with npm-aware static validation', async () => {
    const tree = workspace('npm');
    await databaseGenerator(tree, {
      name: 'analytics',
      adapter: 'drizzle',
      interactive: false,
      yes: true,
    });

    expect(
      tree.read('libs/drizzle/analytics/drizzle.config.ts', 'utf8'),
    ).toContain("schema: './src/schema'");
    expect(
      readJson(tree, 'libs/drizzle/analytics/package.json').dependencies,
    ).toEqual({ 'drizzle-orm': '0.45.2' });
    expect(
      readJson(tree, 'libs/drizzle/analytics/project.json').targets.validate
        .options.command,
    ).toBe('tsc --noEmit -p tsconfig.json');
    expect(readJson(tree, 'playstack.json').databases.analytics).toEqual({
      adapter: 'drizzle',
      dialect: 'postgresql',
      target: 'libs/drizzle/analytics/src/schema',
    });
    expect(readJson(tree, 'package.json').workspaces).toEqual([
      'libs/drizzle/analytics',
      'packages/*',
    ]);
    expect(readJson(tree, 'libs/drizzle/analytics/tsconfig.json').extends).toBe(
      '../../../tsconfig.base.json',
    );
  });

  it('rejects an existing Drizzle target without the supported dialect', async () => {
    const tree = workspace();
    writeJson(tree, 'playstack.json', {
      databases: {
        events: {
          adapter: 'drizzle',
          target: 'libs/drizzle/events/src/schema',
          packages: {},
        },
      },
    });

    await expect(
      databaseGenerator(tree, {
        name: 'events',
        adapter: 'drizzle',
        interactive: false,
        yes: true,
      }),
    ).rejects.toThrow(/different adapter, dialect, or path/);
  });

  it('keeps dry-run mutation-free and rejects conflicting names', async () => {
    const tree = workspace();
    const before = tree
      .listChanges()
      .map(({ path, content }) => [path, content?.toString()]);
    await databaseGenerator(tree, {
      name: 'primary',
      adapter: 'prisma',
      interactive: false,
      yes: true,
      dryRun: true,
    });
    expect(
      tree
        .listChanges()
        .map(({ path, content }) => [path, content?.toString()]),
    ).toEqual(before);

    writeJson(tree, 'megamono.json', {
      ...DEFAULT_MEGAMONO_CONFIG,
      databases: {
        primary: { adapter: 'prisma', project: 'database-primary' },
      },
    });
    await expect(
      databaseGenerator(tree, {
        name: 'primary',
        adapter: 'drizzle',
        interactive: false,
        yes: true,
      }),
    ).rejects.toThrow(/already configured as prisma/);
  });

  it('adopts an explicitly selected existing database project', async () => {
    const tree = workspace();
    writeJson(tree, 'packages/existing-db/project.json', {
      name: 'existing-db',
      root: 'packages/existing-db',
      projectType: 'library',
      tags: ['scope:fixture-workspace'],
    });
    tree.write(
      'packages/existing-db/drizzle.config.ts',
      "export default { schema: './src/schema' };\n",
    );
    tree.write('packages/existing-db/src/schema/index.ts', 'export {};\n');

    await databaseGenerator(tree, {
      name: 'events',
      adapter: 'drizzle',
      directory: 'packages/existing-db',
      project: 'existing-db',
      target: 'packages/existing-db/src/schema',
      interactive: false,
      yes: true,
    });

    expect(readJson(tree, 'megamono.json').databases.events).toEqual({
      adapter: 'drizzle',
      project: 'existing-db',
      schema: 'packages/existing-db/drizzle.config.ts',
    });
    expect(readJson(tree, 'packages/existing-db/project.json').tags).toContain(
      'type:data',
    );
    expect(readJson(tree, 'packages/existing-db/project.json').tags).toContain(
      'database:drizzle',
    );
    expect(tree.read('packages/existing-db/drizzle.config.ts', 'utf8')).toBe(
      "export default { schema: './src/schema' };\n",
    );
  });

  it('adopts a root Prisma layout without moving schema, migrations, or client ownership', async () => {
    const tree = workspace();
    writeJson(tree, 'package.json', {
      name: '@fixture/workspace',
      private: true,
      dependencies: { '@prisma/client': '^6.19.3' },
      devDependencies: { prisma: '^6.19.3', typescript: '~5.9.2' },
    });
    const schema = `generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n`;
    tree.write('prisma/schema.prisma', schema);
    tree.write('prisma/migrations/20260830_init/migration.sql', 'SELECT 1;\n');
    tree.write('apps/api/Dockerfile', 'RUN pnpm exec prisma generate\n');

    await databaseGenerator(tree, {
      name: 'primary',
      adapter: 'prisma',
      interactive: false,
      yes: true,
    });

    expect(tree.read('prisma/schema.prisma', 'utf8')).toBe(schema);
    expect(
      tree.read('prisma/migrations/20260830_init/migration.sql', 'utf8'),
    ).toBe('SELECT 1;\n');
    expect(tree.read('apps/api/Dockerfile', 'utf8')).toBe(
      'RUN pnpm exec prisma generate\n',
    );
    expect(readJson(tree, 'prisma/project.json')).toMatchObject({
      projectType: 'library',
      targets: {
        validate: {
          options: {
            command: 'prisma validate --schema prisma/schema.prisma',
          },
        },
      },
    });
    expect(readJson(tree, 'prisma/project.json').targets.generate).toBe(
      undefined,
    );
    expect(readJson(tree, 'megamono.json').databases.primary).toEqual({
      adapter: 'prisma',
      project: 'fixture-workspace-prisma-primary',
      schema: 'prisma/schema.prisma',
    });
    expect(tree.exists('playstack.json')).toBe(false);
    expect(readJson(tree, 'package.json').dependencies['@prisma/client']).toBe(
      '^6.19.3',
    );
    expect(readJson(tree, 'package.json').devDependencies.prisma).toBe(
      '^6.19.3',
    );
  });

  it('enables existing Prisma artifact composition only with an explicit target', async () => {
    const tree = workspace();
    writeJson(tree, 'package.json', {
      name: '@fixture/workspace',
      private: true,
      dependencies: { '@prisma/client': '^6.19.3' },
      devDependencies: { prisma: '^6.19.3', typescript: '~5.9.2' },
    });
    tree.write(
      'prisma/schema.prisma',
      'generator client {\n  provider = "prisma-client-js"\n}\n',
    );

    await databaseGenerator(tree, {
      name: 'primary',
      adapter: 'prisma',
      target: 'prisma',
      interactive: false,
      yes: true,
    });

    expect(readJson(tree, 'playstack.json').databases.primary).toEqual({
      adapter: 'prisma',
      target: 'prisma',
    });
    expect(readJson(tree, 'prisma/project.json').targets).toMatchObject({
      validate: {
        options: { command: 'prisma validate --schema prisma' },
      },
      generate: {
        options: { command: 'prisma generate --schema prisma' },
      },
    });
  });

  it('relocates a root Prisma layout into a context package without changing history or dependency majors', async () => {
    const tree = workspace();
    writeJson(tree, 'package.json', {
      name: '@fixture/workspace',
      private: true,
      scripts: {
        'prisma:generate': 'prisma generate --schema prisma/schema.prisma',
      },
      dependencies: { '@prisma/client': '^6.19.3' },
      devDependencies: { prisma: '^6.19.3', typescript: '~5.9.2' },
    });
    const schema = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}
`;
    tree.write('prisma/schema.prisma', schema);
    tree.write(
      'prisma/models/account.prisma',
      'model Account { id String @id }\n',
    );
    tree.write(
      'prisma/migrations/20260830_init/migration.sql',
      '-- history\nSELECT 1;\n',
    );
    tree.write(
      'apps/api/Dockerfile',
      'RUN prisma validate --schema prisma/schema.prisma\n',
    );
    await databaseGenerator(tree, {
      name: 'primary',
      adapter: 'prisma',
      target: 'prisma',
      interactive: false,
      yes: true,
    });
    writeJson(tree, 'playstack.json', {
      ...readJson(tree, 'playstack.json'),
      databases: {
        primary: {
          ...readJson(tree, 'playstack.json').databases.primary,
          packages: { '@playstack/auth': {} },
        },
      },
    });

    const beforeDryRun = tree
      .listChanges()
      .map(({ path, content }) => [path, content?.toString()]);
    await databaseGenerator(tree, {
      name: 'primary',
      adapter: 'prisma',
      relocate: true,
      clientOutput: 'src/generated',
      interactive: false,
      yes: true,
      dryRun: true,
    });
    expect(
      tree
        .listChanges()
        .map(({ path, content }) => [path, content?.toString()]),
    ).toEqual(beforeDryRun);

    await databaseGenerator(tree, {
      name: 'primary',
      adapter: 'prisma',
      relocate: true,
      clientOutput: 'src/generated',
      interactive: false,
      yes: true,
    });

    const root = 'libs/prisma/primary';
    expect(tree.exists('prisma/schema.prisma')).toBe(false);
    expect(tree.read(`${root}/prisma/schema.prisma`, 'utf8')).toContain(
      'output   = "../src/generated"',
    );
    expect(
      tree.read(
        `${root}/prisma/migrations/20260830_init/migration.sql`,
        'utf8',
      ),
    ).toBe('-- history\nSELECT 1;\n');
    expect(tree.read(`${root}/prisma/models/account.prisma`, 'utf8')).toBe(
      'model Account { id String @id }\n',
    );
    expect(readJson(tree, `${root}/package.json`)).toMatchObject({
      dependencies: { '@prisma/client': '^6.19.3' },
      devDependencies: { prisma: '^6.19.3', typescript: '~5.9.2' },
    });
    expect(readJson(tree, `${root}/project.json`).targets).toMatchObject({
      validate: { options: { command: 'prisma validate --schema prisma' } },
      generate: {
        outputs: ['{projectRoot}/src/generated'],
        options: { command: 'prisma generate --schema prisma' },
      },
    });
    expect(readJson(tree, 'megamono.json').databases.primary).toEqual({
      adapter: 'prisma',
      project: 'fixture-workspace-prisma-primary',
      schema: `${root}/prisma/schema.prisma`,
    });
    expect(readJson(tree, 'playstack.json').databases.primary).toEqual({
      adapter: 'prisma',
      target: `${root}/prisma`,
      packages: { '@playstack/auth': {} },
    });
    expect(tree.read('prisma.config.ts', 'utf8')).toContain(
      `schema: '${root}/prisma'`,
    );
    expect(readJson(tree, 'package.json').scripts['prisma:generate']).toBe(
      `prisma generate --schema ${root}/prisma`,
    );
    expect(tree.read('apps/api/Dockerfile', 'utf8')).toBe(
      `RUN prisma validate --schema ${root}/prisma\n`,
    );

    const beforeRerun = tree
      .listChanges()
      .map(({ path, content }) => [path, content?.toString()]);
    await databaseGenerator(tree, {
      name: 'primary',
      adapter: 'prisma',
      relocate: true,
      clientOutput: 'src/generated',
      interactive: false,
      yes: true,
    });
    expect(
      tree
        .listChanges()
        .map(({ path, content }) => [path, content?.toString()]),
    ).toEqual(beforeRerun);
  });

  it('rejects a Prisma artifact target that excludes the schema entry', async () => {
    const tree = workspace();
    tree.write(
      'prisma/schema.prisma',
      'generator client {\n  provider = "prisma-client-js"\n}\n',
    );

    await expect(
      databaseGenerator(tree, {
        name: 'primary',
        adapter: 'prisma',
        target: 'prisma/models',
        interactive: false,
        yes: true,
      }),
    ).rejects.toThrow(
      /target prisma\/models excludes the datasource-bearing schema prisma\/schema\.prisma/,
    );
  });

  it('fails relocation before mutation when Prisma config owns a computed schema path', async () => {
    const tree = workspace();
    tree.write(
      'prisma/schema.prisma',
      'generator client {\n  provider = "prisma-client-js"\n}\n',
    );
    tree.write(
      'prisma.config.ts',
      "export default defineConfig({ schema: resolve('prisma') });\n",
    );
    const before = tree
      .listChanges()
      .map(({ path, content }) => [path, content?.toString()]);

    await expect(
      databaseGenerator(tree, {
        name: 'primary',
        adapter: 'prisma',
        relocate: true,
        interactive: false,
        yes: true,
        dryRun: true,
      }),
    ).rejects.toThrow(
      /owns a schema expression Megamono cannot safely rewrite/,
    );
    expect(
      tree
        .listChanges()
        .map(({ path, content }) => [path, content?.toString()]),
    ).toEqual(before);
  });

  it('reuses existing adapter and TypeScript versions for a new database project', async () => {
    const tree = workspace();
    writeJson(tree, 'package.json', {
      name: '@fixture/workspace',
      private: true,
      dependencies: { '@prisma/client': '^6.19.3' },
      devDependencies: { prisma: '^6.19.3', typescript: '~5.9.2' },
    });
    await databaseGenerator(tree, {
      name: 'events',
      adapter: 'prisma',
      interactive: false,
      yes: true,
    });
    expect(readJson(tree, 'libs/prisma/events/package.json')).toMatchObject({
      name: '@fixture-workspace/prisma-events',
      dependencies: { '@prisma/client': '^6.19.3' },
      devDependencies: { prisma: '^6.19.3', typescript: '~5.9.2' },
    });
  });

  it('preserves an existing explicit Playstack package allowlist', async () => {
    const tree = workspace();
    writeJson(tree, 'playstack.json', {
      databases: {
        events: {
          adapter: 'prisma',
          target: 'libs/prisma/events/prisma',
          packages: { '@playstack/auth': {} },
        },
      },
    });

    await databaseGenerator(tree, {
      name: 'events',
      adapter: 'prisma',
      interactive: false,
      yes: true,
    });

    expect(readJson(tree, 'playstack.json').databases.events.packages).toEqual({
      '@playstack/auth': {},
    });
  });
});
