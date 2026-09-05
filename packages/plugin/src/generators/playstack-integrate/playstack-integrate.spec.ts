import { createHash } from 'node:crypto';
import { addProjectConfiguration } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { playstackIntegrateGenerator } from './playstack-integrate';

function fixture() {
  const tree = createTreeWithEmptyWorkspace();
  addProjectConfiguration(tree, 'api', {
    root: 'apps/api',
    projectType: 'application',
  });
  const content = 'export class RateLimitModule {}\n';
  const sha256 = createHash('sha256').update(content).digest('hex');
  tree.write(
    'node_modules/@playstack/rate-limit/package.json',
    JSON.stringify({ name: '@playstack/rate-limit', version: '1.2.3' }),
  );
  tree.write(
    'node_modules/@playstack/rate-limit/playstack.integration.json',
    JSON.stringify({
      version: 1,
      package: '@playstack/rate-limit',
      packageVersion: '1.2.3',
      integrations: [
        {
          id: 'nest-rate-limit',
          surface: 'api',
          framework: 'nest',
          requirements: {
            routes: [],
            moduleImports: [
              { export: 'RateLimitModule', registration: ['forRoot'] },
            ],
            providerTokens: ['PLAYSTACK_RATE_LIMIT_STORE'],
            environment: [
              {
                key: 'cache.redisUrl',
                suggestedNames: ['REDIS_URL'],
                required: true,
                secret: true,
              },
            ],
          },
          templates: [
            {
              id: 'rate-limit-module',
              kind: 'module',
              source: 'templates/rate-limit.module.ts',
              target: 'src/playstack/rate-limit.module.ts',
              ejectable: true,
              sha256,
            },
          ],
        },
      ],
    }),
  );
  tree.write(
    'node_modules/@playstack/rate-limit/templates/rate-limit.module.ts',
    content,
  );
  return tree;
}

function integrationManifest(tree: ReturnType<typeof fixture>) {
  return JSON.parse(
    tree.read(
      'node_modules/@playstack/rate-limit/playstack.integration.json',
      'utf8',
    ) ?? '{}',
  );
}

function writeIntegrationManifest(
  tree: ReturnType<typeof fixture>,
  manifest: unknown,
) {
  tree.write(
    'node_modules/@playstack/rate-limit/playstack.integration.json',
    JSON.stringify(manifest),
  );
}

describe('Playstack integration generator', () => {
  it.each([
    [
      'unsupported framework',
      (manifest: ReturnType<typeof integrationManifest>) => {
        manifest.integrations[0].framework = 'unsupported';
      },
    ],
    [
      'unknown requirement',
      (manifest: ReturnType<typeof integrationManifest>) => {
        manifest.integrations[0].requirements.mandatoryDecision = true;
      },
    ],
    [
      'invalid route',
      (manifest: ReturnType<typeof integrationManifest>) => {
        manifest.integrations[0].requirements.routes = [{ path: '/refresh' }];
      },
    ],
  ])('rejects the full manifest schema: %s', async (_label, change) => {
    const tree = fixture();
    const manifest = integrationManifest(tree);
    change(manifest);
    writeIntegrationManifest(tree, manifest);
    await expect(
      playstackIntegrateGenerator(tree, {
        packages: '@playstack/rate-limit',
        api: 'apps/api',
        yes: true,
      }),
    ).rejects.toThrow('does not satisfy integration schema');
    expect(tree.exists('.megamono/playstack-integration-plan.json')).toBe(
      false,
    );
  });

  it('rejects contradictory dedicated and package decisions', async () => {
    await expect(
      playstackIntegrateGenerator(fixture(), {
        packages: '@playstack/rate-limit',
        api: 'apps/api',
        persistence: 'application',
        decisions: '{"auth.persistence":"package"}',
        yes: true,
      }),
    ).rejects.toThrow('conflicts with the dedicated option');
  });
  it('rejects unknown Nx destinations before writing', async () => {
    const tree = fixture();
    await expect(
      playstackIntegrateGenerator(tree, {
        packages: '@playstack/rate-limit',
        api: 'apps/typo',
        yes: true,
      }),
    ).rejects.toThrow('not an existing Nx project root');
    expect(tree.exists('apps/typo')).toBe(false);
  });

  it('rejects composed Nest route collisions but distinguishes HTTP methods', async () => {
    const tree = fixture();
    const manifest = integrationManifest(tree);
    manifest.integrations[0].requirements.routes = [
      {
        id: 'refresh',
        methods: ['POST'],
        path: '/auth/refresh',
        rawBody: false,
      },
    ];
    writeIntegrationManifest(tree, manifest);
    tree.write(
      'apps/api/src/auth.controller.ts',
      "import { Controller, Post as Route } from '@nestjs/common';\n@Controller('auth') export class Auth { @Route('refresh') refresh() {} }\n",
    );
    await expect(
      playstackIntegrateGenerator(tree, {
        packages: '@playstack/rate-limit',
        api: 'apps/api',
        yes: true,
      }),
    ).rejects.toThrow('Existing Nest route POST /auth/refresh');
    expect(tree.exists('.megamono/playstack-integration-plan.json')).toBe(
      false,
    );
    manifest.integrations[0].requirements.routes[0].methods = ['GET'];
    writeIntegrationManifest(tree, manifest);
    await playstackIntegrateGenerator(tree, {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      yes: true,
    });
  });
  it('materializes package-authored wiring as application-owned source', async () => {
    const tree = fixture();

    await playstackIntegrateGenerator(tree, {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      yes: true,
    });

    expect(
      tree.read('apps/api/src/playstack/rate-limit.module.ts', 'utf8'),
    ).toBe('export class RateLimitModule {}\n');
    expect(
      JSON.parse(
        tree.read('.megamono/playstack-integration-plan.json', 'utf8') ?? '{}',
      ),
    ).toMatchObject({
      schemaVersion: 1,
      commitBoundaries: [
        {
          id: 'integrate-nest-rate-limit',
          package: '@playstack/rate-limit',
          files: ['apps/api/src/playstack/rate-limit.module.ts'],
        },
      ],
      requirements: [
        expect.objectContaining({
          package: '@playstack/rate-limit',
          surface: 'api',
          requirements: expect.objectContaining({
            environment: [expect.objectContaining({ key: 'cache.redisUrl' })],
          }),
        }),
      ],
    });
  });

  it('keeps dry runs write-free', async () => {
    const tree = fixture();

    await playstackIntegrateGenerator(tree, {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      dryRun: true,
    });

    expect(tree.exists('.megamono/playstack-integration-plan.json')).toBe(
      false,
    );
    expect(tree.exists('apps/api/src/playstack/rate-limit.module.ts')).toBe(
      false,
    );
  });

  it('fails before mutation on repository-owned target conflicts', async () => {
    const tree = fixture();
    tree.write(
      'apps/api/src/playstack/rate-limit.module.ts',
      'export const applicationOwned = true;\n',
    );

    await expect(
      playstackIntegrateGenerator(tree, {
        packages: '@playstack/rate-limit',
        api: 'apps/api',
        yes: true,
      }),
    ).rejects.toThrow('repository-owned content');
    expect(tree.exists('.megamono/playstack-integration-plan.json')).toBe(
      false,
    );
  });

  it('rejects stale or tampered package integration resources', async () => {
    const tree = fixture();
    tree.write(
      'node_modules/@playstack/rate-limit/templates/rate-limit.module.ts',
      'export const tampered = true;\n',
    );

    await expect(
      playstackIntegrateGenerator(tree, {
        packages: '@playstack/rate-limit',
        api: 'apps/api',
        yes: true,
      }),
    ).rejects.toThrow('failed SHA-256 verification');
  });

  it('resolves adapter, persistence, migration, and package decisions', async () => {
    const tree = fixture();
    const manifest = integrationManifest(tree);
    manifest.integrations[0].templates[0].when = 'adapter:redis';
    manifest.integrations[0].requirements.databaseArtifacts = [
      {
        package: '@playstack/rate-limit',
        required: true,
        formats: ['prisma'],
        when: 'persistence:package',
      },
    ];
    manifest.integrations[0].requirements.healthChecks = [
      {
        id: 'redis',
        kind: 'provider',
        required: true,
        when: 'Redis is selected',
      },
    ];
    manifest.integrations[0].requirements.decisions = [
      {
        key: 'rate-limit.persistence',
        prompt: 'Select persistence.',
        required: true,
        options: ['package', 'application'],
      },
      {
        key: 'rate-limit.adoptionMode',
        prompt: 'Select migration mode.',
        required: true,
        options: ['fresh', 'compare', 'shadow', 'cutover'],
      },
      {
        key: 'rate-limit.policy',
        prompt: 'Select policy.',
        required: true,
        options: ['strict', 'compatibility'],
      },
    ];
    writeIntegrationManifest(tree, manifest);

    await playstackIntegrateGenerator(tree, {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      adapters: 'redis',
      persistence: 'application',
      adoptionMode: 'shadow',
      conditions: JSON.stringify({ 'Redis is selected': true }),
      decisions: JSON.stringify({ 'rate-limit.policy': 'compatibility' }),
      yes: true,
    });

    const plan = JSON.parse(
      tree.read('.megamono/playstack-integration-plan.json', 'utf8') ?? '{}',
    );
    expect(plan.selections).toMatchObject({
      adapters: ['redis'],
      persistence: 'application',
      adoptionMode: 'shadow',
      decisions: {
        'rate-limit.persistence': 'application',
        'rate-limit.adoptionMode': 'shadow',
        'rate-limit.policy': 'compatibility',
      },
    });
    expect(plan.unresolvedConditions).toEqual([]);
    expect(plan.unresolvedDecisions).toEqual([]);
    expect(plan.requirements[0].requirements.databaseArtifacts).toEqual([]);
  });

  it('fails closed when required conditions or decisions are unresolved', async () => {
    const tree = fixture();
    const manifest = integrationManifest(tree);
    manifest.integrations[0].templates[0].when = 'adapter:redis';
    manifest.integrations[0].requirements.decisions = [
      {
        key: 'rate-limit.policy',
        prompt: 'Select policy.',
        required: true,
      },
    ];
    writeIntegrationManifest(tree, manifest);

    await expect(
      playstackIntegrateGenerator(tree, {
        packages: '@playstack/rate-limit',
        api: 'apps/api',
        yes: true,
      }),
    ).rejects.toThrow('unresolved conditions');
    expect(tree.exists('.megamono/playstack-integration-plan.json')).toBe(
      false,
    );
  });

  it('reports existing application references before materializing wiring', async () => {
    const tree = fixture();
    const manifest = integrationManifest(tree);
    manifest.integrations[0].requirements.routes = [
      {
        id: 'rate-limit.status',
        methods: ['GET'],
        path: '/rate-limit/status',
        rawBody: false,
      },
    ];
    manifest.integrations[0].requirements.frameworkConfiguration = [
      { key: 'trustProxy', value: 'application-reviewed' },
    ];
    writeIntegrationManifest(tree, manifest);
    tree.write(
      'apps/api/src/existing.ts',
      `export const route = '/rate-limit/status';\nexport const token = 'PLAYSTACK_RATE_LIMIT_STORE';\nexport const env = process.env.REDIS_URL;\nexport const trustProxy = true;\n`,
    );

    await playstackIntegrateGenerator(tree, {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      yes: true,
    });

    const plan = JSON.parse(
      tree.read('.megamono/playstack-integration-plan.json', 'utf8') ?? '{}',
    );
    expect(plan.preflight.existingReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'route',
          key: '/rate-limit/status',
        }),
        expect.objectContaining({
          category: 'provider',
          key: 'PLAYSTACK_RATE_LIMIT_STORE',
        }),
        expect.objectContaining({ category: 'environment', key: 'REDIS_URL' }),
        expect.objectContaining({ category: 'framework', key: 'trustProxy' }),
      ]),
    );
  });

  it('refuses incompatible route declarations before writing', async () => {
    const tree = fixture();
    const manifest = integrationManifest(tree);
    manifest.integrations[0].requirements.routes = [
      {
        id: 'first',
        methods: ['POST'],
        path: '/shared',
        rawBody: false,
      },
      {
        id: 'second',
        methods: ['POST'],
        path: '/shared',
        rawBody: true,
      },
    ];
    writeIntegrationManifest(tree, manifest);

    await expect(
      playstackIntegrateGenerator(tree, {
        packages: '@playstack/rate-limit',
        api: 'apps/api',
        yes: true,
      }),
    ).rejects.toThrow('incompatible manifest requirements');
  });
});
