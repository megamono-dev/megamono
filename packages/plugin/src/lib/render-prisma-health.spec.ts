import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectGraph } from '@nx/devkit';
import { DEFAULT_MEGAMONO_CONFIG } from './config';
import { renderPrismaFindings } from './render-prisma-health';
import { runRepositoryHealth } from './health';

describe('Render Prisma deployment health', () => {
  const config = {
    ...DEFAULT_MEGAMONO_CONFIG,
    databases: {
      primary: {
        adapter: 'prisma' as const,
        project: 'db',
        schema: 'libs/db/prisma',
      },
    },
  };
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'megamono-render-prisma-'));
    mkdirSync(join(root, 'libs/db'), { recursive: true });
    writeFileSync(join(root, 'libs/db/prisma.config.ts'), 'export default {};');
    const service = {
      name: 'api',
      rootDir: '.',
      buildCommand:
        "pnpm install --frozen-lockfile && pnpm exec nx run 'api:build'",
      preDeployCommand:
        "pnpm exec prisma migrate deploy --schema 'libs/db/prisma' --config 'libs/db/prisma.config.ts'",
    };
    const graph: ProjectGraph = {
      nodes: {
        api: {
          name: 'api',
          type: 'app',
          data: {
            root: 'apps/api',
            targets: {
              build: { dependsOn: [{ target: 'generate', projects: ['db'] }] },
            },
            metadata: {
              'megamono:render': {
                schemaVersion: 1,
                blueprintPath: 'render.yaml',
                services: [service],
              },
            },
          },
        },
        persistence: {
          name: 'persistence',
          type: 'lib',
          data: { root: 'libs/persistence' },
        },
        db: {
          name: 'db',
          type: 'lib',
          data: {
            root: 'libs/db',
            targets: {
              generate: {
                executor: 'nx:run-commands',
                options: {
                  cwd: 'libs/db',
                  command: 'prisma generate --schema prisma',
                },
              },
            },
          },
        },
      },
      dependencies: {
        api: [{ source: 'api', target: 'persistence', type: 'static' }],
        persistence: [{ source: 'persistence', target: 'db', type: 'static' }],
        db: [],
      },
    };
    return { root, service, graph };
  }

  it('accepts the complete build-generation and migration chain through a transitive database dependency', () => {
    const { root, graph } = fixture();
    try {
      expect(renderPrismaFindings(root, graph, config)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces both missing steps through the public health report', async () => {
    const { root, graph, service } = fixture();
    try {
      service.preDeployCommand = '';
      const build = graph.nodes.api.data.targets?.build;
      if (!build) throw new Error('Missing fixture build');
      build.dependsOn = [];
      const report = await runRepositoryHealth({
        workspaceRoot: root,
        graph,
        config,
        documents: [],
        checks: ['spec-drift'],
      });
      expect(
        report.findings
          .filter(({ fingerprint }) => fingerprint.startsWith('render:prisma-'))
          .map(({ fingerprint }) => fingerprint),
      ).toEqual([
        'render:prisma-generate:api:api:primary',
        'render:prisma-migrate:api:api:primary',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    'pnpm exec prisma migrate deploy --schema libs/wrong/prisma --config libs/db/prisma.config.ts',
    'pnpm exec prisma migrate deploy --schema libs/db/prisma',
    'echo prisma migrate deploy --schema libs/db/prisma --config libs/db/prisma.config.ts',
    'pnpm exec prisma migrate dev --schema libs/db/prisma --config libs/db/prisma.config.ts',
    'pnpm run migrate-reviewed',
    'pnpm exec prisma migrate deploy --help --schema libs/db/prisma --config libs/db/prisma.config.ts',
    'pnpm exec prisma migrate deploy --schema libs/db/prisma --schema other --config libs/db/prisma.config.ts',
  ])(
    'does not claim an unverified or wrong migration command is qualified: %s',
    (command) => {
      const { root, graph, service } = fixture();
      try {
        service.preDeployCommand = command;
        expect(renderPrismaFindings(root, graph, config)).toEqual([
          expect.objectContaining({
            fingerprint: 'render:prisma-migrate:api:api:primary',
            confidence: 'reduced',
          }),
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('does not treat a target named generate as proof of Prisma generation', () => {
    const { root, graph } = fixture();
    try {
      const generate = graph.nodes.db.data.targets?.generate;
      if (!generate) throw new Error('Missing fixture generation');
      generate.options = { ...generate.options, command: 'echo generate' };
      expect(renderPrismaFindings(root, graph, config)).toEqual([
        expect.objectContaining({
          fingerprint: 'render:prisma-generate:api:api:primary',
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires client generation before compilation for direct build commands', () => {
    const { root, graph, service } = fixture();
    try {
      service.buildCommand =
        'pnpm exec nx run api:build && pnpm exec prisma generate --schema libs/db/prisma --config libs/db/prisma.config.ts';
      const build = graph.nodes.api.data.targets?.build;
      if (!build) throw new Error('Missing fixture build');
      build.dependsOn = [];
      expect(renderPrismaFindings(root, graph, config)).toContainEqual(
        expect.objectContaining({
          fingerprint: 'render:prisma-generate:api:api:primary',
        }),
      );
      service.buildCommand =
        'pnpm install --frozen-lockfile && pnpm exec prisma generate --schema libs/db/prisma --config libs/db/prisma.config.ts && pnpm exec nx run api:build';
      expect(renderPrismaFindings(root, graph, config)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let a single-file override omit configured multi-file model fragments', () => {
    const { root, graph, service } = fixture();
    try {
      writeFileSync(
        join(root, 'libs/db/prisma.config.ts'),
        "export default { schema: 'prisma' };",
      );
      const fileConfig = {
        ...config,
        databases: {
          primary: {
            ...config.databases.primary,
            schema: 'libs/db/prisma/schema.prisma',
          },
        },
      };
      expect(renderPrismaFindings(root, graph, fileConfig)).toEqual([]);
      service.preDeployCommand =
        'pnpm exec prisma migrate deploy --schema libs/db/prisma/schema.prisma --config libs/db/prisma.config.ts';
      expect(renderPrismaFindings(root, graph, fileConfig)).toEqual([
        expect.objectContaining({
          fingerprint: 'render:prisma-migrate:api:api:primary',
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags excluded schemas and does not flag unrelated services or Drizzle projects', () => {
    const { root, graph, service } = fixture();
    try {
      service.rootDir = 'apps/api';
      expect(renderPrismaFindings(root, graph, config)).toContainEqual(
        expect.objectContaining({
          fingerprint: 'render:prisma-root:api:api:primary',
        }),
      );
      graph.dependencies.api = [];
      expect(renderPrismaFindings(root, graph, config)).toEqual([]);
      graph.dependencies.api = [
        { source: 'api', target: 'db', type: 'static' },
      ];
      expect(
        renderPrismaFindings(root, graph, {
          ...config,
          databases: {
            primary: { ...config.databases.primary, adapter: 'drizzle' },
          },
        }),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
