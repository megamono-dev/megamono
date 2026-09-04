import { createHash } from 'node:crypto';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { playstackIntegrateGenerator } from './playstack-integrate';

function fixture() {
  const tree = createTreeWithEmptyWorkspace();
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
        'apps/api/src/playstack/rate-limit.module.ts',
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
});
