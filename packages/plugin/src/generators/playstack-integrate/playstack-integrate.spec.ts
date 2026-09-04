import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { playstackIntegrateGenerator } from './playstack-integrate';

function fixture() {
  const tree = createTreeWithEmptyWorkspace();
  tree.write(
    'node_modules/@playstack/rate-limit/playstack.integration.json',
    JSON.stringify({
      schemaVersion: 1,
      package: '@playstack/rate-limit',
      integrations: [
        {
          id: 'nest-rate-limit',
          surface: 'api',
          framework: 'nest',
          requirements: {
            routes: [],
            modules: ['RateLimitModule'],
            providers: ['PLAYSTACK_RATE_LIMIT_STORE'],
            environment: ['REDIS_URL'],
            healthChecks: ['redis'],
            tests: ['rate-limit.integration.spec.ts'],
          },
          files: [
            {
              source: 'publish/integrations/nest/rate-limit.module.ts',
              target: '{apiRoot}/src/playstack/{integrationId}.module.ts',
            },
          ],
        },
      ],
    }),
  );
  tree.write(
    'node_modules/@playstack/rate-limit/publish/integrations/nest/rate-limit.module.ts',
    'export class RateLimitModule {}\n',
  );
  return tree;
}

describe('Playstack integration generator', () => {
  it('materializes package-authored wiring as application-owned source', async () => {
    const tree = fixture();

    await playstackIntegrateGenerator(tree, {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      yes: true,
    });

    expect(
      tree.read(
        'apps/api/src/playstack/nest-rate-limit.module.ts',
        'utf8',
      ),
    ).toBe('export class RateLimitModule {}\n');
    expect(
      JSON.parse(
        tree.read('.megamono/playstack-integration-plan.json', 'utf8') ?? '{}',
      ),
    ).toMatchObject({
      schemaVersion: 1,
      requirements: [
        expect.objectContaining({
          package: '@playstack/rate-limit',
          surface: 'api',
          requirements: expect.objectContaining({
            environment: ['REDIS_URL'],
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
    expect(tree.exists('apps/api/src/playstack/nest-rate-limit.module.ts')).toBe(
      false,
    );
  });

  it('fails before mutation on repository-owned target conflicts', async () => {
    const tree = fixture();
    tree.write(
      'apps/api/src/playstack/nest-rate-limit.module.ts',
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
});
