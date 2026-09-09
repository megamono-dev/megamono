import { createHash } from 'node:crypto';
import {
  addProjectConfiguration,
  getProjects,
  logger,
  updateProjectConfiguration,
} from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it, vi } from 'vitest';
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
  it('preserves independent plans and migration stages for two application roots', async () => {
    const tree = fixture();
    tree.write(
      'apps/dashboard/project.json',
      JSON.stringify({
        name: 'dashboard',
        root: 'apps/dashboard',
        projectType: 'application',
        targets: {},
      }),
    );
    const key = '@playstack/rate-limit:nest-rate-limit';
    const options = { packages: '@playstack/rate-limit', yes: true };
    await playstackIntegrateGenerator(tree, {
      ...options,
      api: 'apps/api',
      migrationStages: JSON.stringify({ [key]: { stage: 'compare' } }),
    });
    const indexPath = '.megamono/playstack-integration-plans.json';
    const index = JSON.parse(tree.read(indexPath, 'utf8') ?? '{}');
    const firstPlan = index.plans[`${key}@apps%2Fapi`];
    const bytes = tree.read(firstPlan, 'utf8');
    await playstackIntegrateGenerator(tree, {
      ...options,
      api: 'apps/dashboard',
    });
    const ledger = JSON.parse(
      tree.read('.megamono/playstack-integrations.json', 'utf8') ?? '{}',
    );
    expect(ledger.integrations[`${key}@apps%2Fapi`].stage).toBe('compare');
    expect(ledger.integrations[`${key}@apps%2Fdashboard`].stage).toBe(
      'planned',
    );
    expect(tree.read(firstPlan, 'utf8')).toBe(bytes);
    expect(
      Object.keys(JSON.parse(tree.read(indexPath, 'utf8') ?? '{}').plans),
    ).toHaveLength(2);
    await playstackIntegrateGenerator(tree, { ...options, api: 'apps/api' });
    expect(
      JSON.parse(
        tree.read('.megamono/playstack-integrations.json', 'utf8') ?? '{}',
      ).integrations,
    ).toEqual(ledger.integrations);
  });

  it('supports a non-reserved Nx planning flag without requiring yes or writing files', async () => {
    const tree = fixture();
    const before = tree.listChanges();
    const log = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      await playstackIntegrateGenerator(tree, {
        packages: '@playstack/rate-limit',
        api: 'apps/api',
        planOnly: true,
      });
      expect(tree.listChanges()).toEqual(before);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
  it('reports missing manifests in a read-only plan without implying integration readiness', async () => {
    const tree = fixture();
    tree.delete(
      'node_modules/@playstack/rate-limit/playstack.integration.json',
    );
    const before = tree.listChanges();
    const output = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      await playstackIntegrateGenerator(tree, {
        packages: '@playstack/rate-limit',
        api: 'apps/api',
        dryRun: true,
      });
      const plan = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      expect(plan.readiness).toMatchObject({
        verification: 'not-run',
        packages: [
          {
            package: '@playstack/rate-limit',
            manifest: 'missing',
            integrations: [],
          },
        ],
      });
      expect(plan.preflight.conflicts).toHaveLength(1);
      expect(tree.listChanges()).toEqual(before);
      await expect(
        playstackIntegrateGenerator(tree, {
          packages: '@playstack/rate-limit',
          api: 'apps/api',
          yes: true,
        }),
      ).rejects.toThrow('cannot be generated');
    } finally {
      output.mockRestore();
    }
  });

  it.each([true, false])(
    'distinguishes templates from test qualification: templates=%s',
    async (hasTemplates) => {
      const tree = fixture();
      const manifest = integrationManifest(tree);
      if (!hasTemplates) manifest.integrations[0].templates = [];
      manifest.integrations[0].requirements.requiredTests = [
        { id: 'behavior', kind: 'integration' },
      ];
      writeIntegrationManifest(tree, manifest);
      await playstackIntegrateGenerator(tree, {
        packages: '@playstack/rate-limit',
        api: 'apps/api',
        yes: true,
      });
      const plan = JSON.parse(
        tree.read('.megamono/playstack-integration-plan.json', 'utf8') ?? '{}',
      );
      expect(plan.readiness.verification).toBe('not-run');
      expect(plan.readiness.packages[0].integrations[0]).toMatchObject({
        templates: hasTemplates ? 'available' : 'none-selected',
        wiring: hasTemplates ? 'generated-or-reused' : 'application-owned',
        requiredTests: [{ id: 'behavior', target: null, status: 'not-run' }],
      });
    },
  );

  it.each([
    'missing',
    'unsupported',
    'unknown',
    'blank',
    'disabled',
    'enabled',
    'undeclared-condition',
  ])('requires explicit package-owned policy gates: %s', async (scenario) => {
    const tree = fixture();
    const manifest = integrationManifest(tree);
    // Synthetic contract: these options are not claims about current Playstack support.
    manifest.integrations[0].requirements.decisions = [
      {
        key: 'auth.registration',
        prompt: 'Enable production signup?',
        required: true,
        options: ['disabled', 'enabled'],
      },
      {
        key: 'auth.identityLinking',
        prompt: 'Select linking policy.',
        required: true,
        options: ['explicit-proof'],
      },
      {
        key: 'accounts.ownership',
        prompt: 'Select ownership.',
        required: true,
        options: ['single-owner'],
      },
    ];
    manifest.integrations[0].templates[0].when =
      scenario === 'undeclared-condition'
        ? 'decision:auth.typo=enabled'
        : 'decision:auth.registration=enabled';
    manifest.integrations.push({
      id: 'registration',
      surface: 'api',
      framework: 'nest',
      when: 'decision:auth.registration=enabled',
      requirements: {
        routes: [
          {
            id: 'register',
            methods: ['POST'],
            path: '/auth/register',
            rawBody: false,
          },
        ],
      },
      templates: [],
    });
    writeIntegrationManifest(tree, manifest);
    const decisions = {
      ...(scenario === 'missing'
        ? {}
        : {
            'auth.registration':
              scenario === 'enabled'
                ? 'enabled'
                : scenario === 'blank'
                  ? '   '
                  : 'disabled',
          }),
      'auth.identityLinking': 'explicit-proof',
      'accounts.ownership':
        scenario === 'unsupported' ? 'multi-owner' : 'single-owner',
      ...(scenario === 'unknown' ? { 'auth.refreshReplaay': 'strict' } : {}),
    };
    const before = tree.listChanges();
    const invoke = () =>
      playstackIntegrateGenerator(tree, {
        packages: '@playstack/rate-limit',
        api: 'apps/api',
        decisions: JSON.stringify(decisions),
        conditions: JSON.stringify({
          'decision:auth.registration=enabled': true,
        }),
        yes: true,
      });
    if (!['enabled', 'disabled'].includes(scenario)) {
      const errors: Record<string, string> = {
        missing: 'unresolved conditions',
        unsupported: 'must be one of',
        unknown: 'not declared',
        blank: 'valid values',
        'undeclared-condition': 'must reference',
      };
      await expect(invoke()).rejects.toThrow(errors[scenario]);
      expect(tree.listChanges()).toEqual(before);
      return;
    }
    await invoke();
    const plan = JSON.parse(
      tree.read('.megamono/playstack-integration-plan.json', 'utf8') ?? '{}',
    );
    expect(tree.exists('apps/api/src/playstack/rate-limit.module.ts')).toBe(
      scenario === 'enabled',
    );
    expect(
      plan.requirements.flatMap(
        (entry: { requirements: { routes?: unknown[] } }) =>
          entry.requirements.routes ?? [],
      ),
    ).toHaveLength(scenario === 'enabled' ? 1 : 0);
    expect(plan.selections.decisions).toEqual(decisions);
  });

  it('invalidates evidence when installed runtime bytes change without a version or manifest change', async () => {
    const tree = fixture();
    const options = {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      yes: true,
    };
    tree.write(
      'node_modules/@playstack/rate-limit/dist/index.js',
      'exports.limit = 1;',
    );
    await playstackIntegrateGenerator(tree, options);
    const path = '.megamono/playstack-integrations.json';
    const ledger = JSON.parse(tree.read(path, 'utf8') ?? '{}');
    const record =
      ledger.integrations['@playstack/rate-limit:nest-rate-limit@apps%2Fapi'];
    record.stage = 'shadow';
    record.history.push({ stage: 'shadow', fingerprint: record.fingerprint });
    tree.write(path, JSON.stringify(ledger));
    tree.write(
      'node_modules/@playstack/rate-limit/dist/index.js',
      'exports.limit = 2;',
    );
    const before = tree.listChanges();
    await expect(playstackIntegrateGenerator(tree, options)).rejects.toThrow(
      'changed during shadow',
    );
    expect(tree.listChanges()).toEqual(before);
  });

  it('resolves declared dedicated decisions before evaluating conditional templates', async () => {
    const tree = fixture();
    const manifest = integrationManifest(tree);
    manifest.integrations[0].requirements.decisions = [
      {
        key: 'auth.persistence',
        prompt: 'Select persistence.',
        required: true,
        options: ['package', 'application'],
      },
    ];
    manifest.integrations[0].templates[0].when =
      'decision:auth.persistence=application';
    writeIntegrationManifest(tree, manifest);
    await playstackIntegrateGenerator(tree, {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      persistence: 'application',
      yes: true,
    });
    expect(tree.exists('apps/api/src/playstack/rate-limit.module.ts')).toBe(
      true,
    );
  });
  it('emits Nest wiring into a shared library, connects AppModule once, and protects edits', async () => {
    const tree = fixture();
    addProjectConfiguration(tree, 'platform', {
      root: 'libs/platform/playstack',
      sourceRoot: 'libs/platform/playstack/src',
      projectType: 'library',
    });
    tree.write(
      'tsconfig.base.json',
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@fixture/platform': ['libs/platform/playstack/src/index.ts'],
          },
        },
      }),
    );
    tree.write(
      'apps/api/src/app.module.ts',
      "import { Module as NestModule } from '@nestjs/common';\n// application owned\n@NestModule({ providers: [] }) export class AppModule {}\n",
    );
    const content =
      "import { Module } from '@nestjs/common';\n@Module({}) export class RateLimitModule {}\n";
    const manifest = integrationManifest(tree);
    manifest.integrations[0].templates[0].sha256 = createHash('sha256')
      .update(content)
      .digest('hex');
    writeIntegrationManifest(tree, manifest);
    tree.write(
      'node_modules/@playstack/rate-limit/templates/rate-limit.module.ts',
      content,
    );
    const options = {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      yes: true,
      composition: JSON.stringify({
        project: 'platform',
        modules: [
          {
            file: 'libs/platform/playstack/src/playstack/rate-limit.module.ts',
            export: 'RateLimitModule',
          },
        ],
        connect: {
          file: 'apps/api/src/app.module.ts',
          module: 'AppModule',
          importPath: '@fixture/platform',
        },
      }),
    };
    await playstackIntegrateGenerator(tree, { ...options, dryRun: true });
    expect(
      tree.exists('libs/platform/playstack/src/playstack-platform.module.ts'),
    ).toBe(false);
    await playstackIntegrateGenerator(tree, options);
    expect(tree.exists('apps/api/src/playstack/rate-limit.module.ts')).toBe(
      false,
    );
    expect(
      tree.read(
        'libs/platform/playstack/src/playstack-platform.module.ts',
        'utf8',
      ),
    ).toContain('RateLimitModule as Integration0');
    const app = tree.read('apps/api/src/app.module.ts', 'utf8');
    expect(app).toContain('imports: [PlaystackPlatformModule]');
    expect(app).toContain('// application owned');
    await playstackIntegrateGenerator(tree, options);
    expect(tree.read('apps/api/src/app.module.ts', 'utf8')).toBe(app);
    const ledgerPath = '.megamono/playstack-integrations.json';
    const ledgerBefore = tree.read(ledgerPath, 'utf8') ?? '{}';
    const ledger = JSON.parse(ledgerBefore);
    const record =
      ledger.integrations['@playstack/rate-limit:nest-rate-limit@apps%2Fapi'];
    const previousFingerprint = record.fingerprint;
    record.stage = 'shadow';
    record.history.push({ stage: 'shadow', fingerprint: previousFingerprint });
    tree.write(ledgerPath, JSON.stringify(ledger));
    tree.write(
      'libs/platform/playstack/src/extra.module.ts',
      "import { Module } from '@nestjs/common';\n@Module({}) export class ExtraModule {}\n",
    );
    const changed = JSON.parse(options.composition);
    changed.modules.push({
      file: 'libs/platform/playstack/src/extra.module.ts',
      export: 'ExtraModule',
    });
    await expect(
      playstackIntegrateGenerator(tree, {
        ...options,
        composition: JSON.stringify(changed),
      }),
    ).rejects.toThrow('changed during shadow');
    tree.write(ledgerPath, ledgerBefore);
    await playstackIntegrateGenerator(tree, {
      ...options,
      composition: JSON.stringify(changed),
    });
    expect(
      JSON.parse(tree.read(ledgerPath, 'utf8') ?? '{}').integrations[
        '@playstack/rate-limit:nest-rate-limit@apps%2Fapi'
      ].fingerprint,
    ).not.toBe(previousFingerprint);
    tree.write(
      'libs/platform/playstack/src/playstack-platform.module.ts',
      '// manually ejected\n',
    );
    await expect(playstackIntegrateGenerator(tree, options)).rejects.toThrow(
      'modified content',
    );
  });

  it('refuses an invalid composition binding before emitting any templates', async () => {
    const tree = fixture();
    addProjectConfiguration(tree, 'platform', {
      root: 'libs/platform',
      projectType: 'library',
    });
    await expect(
      playstackIntegrateGenerator(tree, {
        packages: '@playstack/rate-limit',
        api: 'apps/api',
        yes: true,
        composition: JSON.stringify({
          project: 'platform',
          modules: [
            { file: 'apps/api/existing.module.ts', export: 'Existing' },
          ],
        }),
      }),
    ).rejects.toThrow('inside the selected library');
    expect(
      tree.exists('libs/platform/src/playstack/rate-limit.module.ts'),
    ).toBe(false);
  });
  it('wires required tests into Nx only after an accepted plan, and reruns safely', async () => {
    const tree = fixture();
    const manifest = integrationManifest(tree);
    manifest.integrations[0].requirements.requiredTests = [
      { id: 'rate-limit-contract', kind: 'integration' },
    ];
    writeIntegrationManifest(tree, manifest);
    updateProjectConfiguration(tree, 'api', {
      root: 'apps/api',
      targets: {
        test: {
          executor: 'nx:run-commands',
          options: { command: 'node --test' },
        },
      },
    });
    const options = {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      yes: true,
      verificationProject: 'api',
      qualification: JSON.stringify({
        '@playstack/rate-limit:nest-rate-limit:rate-limit-contract': [
          'real-database',
        ],
      }),
      verification: JSON.stringify({
        '@playstack/rate-limit:nest-rate-limit:rate-limit-contract': 'api:test',
      }),
    };
    await playstackIntegrateGenerator(tree, { ...options, dryRun: true });
    expect(
      getProjects(tree).get('api')?.targets?.['playstack-verify'],
    ).toBeUndefined();
    await playstackIntegrateGenerator(tree, options);
    expect(
      getProjects(tree).get('api')?.targets?.['playstack-verify'],
    ).toMatchObject({
      executor: 'nx:noop',
      dependsOn: [{ projects: ['api'], target: 'test' }],
    });
    await playstackIntegrateGenerator(tree, options);
    const qualifiedFingerprint = JSON.parse(
      tree.read('.megamono/playstack-integrations.json', 'utf8') ?? '{}',
    ).integrations['@playstack/rate-limit:nest-rate-limit@apps%2Fapi']
      .fingerprint;
    await playstackIntegrateGenerator(tree, {
      ...options,
      qualification: '{}',
    });
    expect(
      JSON.parse(
        tree.read('.megamono/playstack-integrations.json', 'utf8') ?? '{}',
      ).integrations['@playstack/rate-limit:nest-rate-limit@apps%2Fapi']
        .fingerprint,
    ).not.toBe(qualifiedFingerprint);
    await expect(
      playstackIntegrateGenerator(tree, {
        ...options,
        qualification: '{"unknown:test":["real-database"]}',
      }),
    ).rejects.toThrow('not an active');
  });
  it('adds reviewed application migration contracts without allowing qualification or wiring to omit them', async () => {
    const tree = fixture();
    const key = '@playstack/rate-limit:nest-rate-limit';
    // Synthetic fixture: a host may attach queue contracts to its own selected integration.
    const options = {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      yes: true,
      migrationContracts: JSON.stringify({ [key]: ['queue-jobs'] }),
      qualification: JSON.stringify({
        [`${key}:migration.queue-payload-compatibility`]: ['unit'],
      }),
    };
    const before = tree.listChanges();
    await playstackIntegrateGenerator(tree, { ...options, dryRun: true });
    expect(tree.listChanges()).toEqual(before);
    await playstackIntegrateGenerator(tree, options);
    const plan = JSON.parse(
      tree.read('.megamono/playstack-integration-plan.json', 'utf8') ?? '{}',
    );
    expect(plan.migrationContracts[key].profiles).toEqual(['queue-jobs']);
    expect(
      plan.qualification[`${key}:migration.queue-payload-compatibility`],
    ).toEqual(['real-queue', 'unit']);
    expect(plan.requirements[0].requirements.requiredTests).toEqual(
      expect.arrayContaining([
        { id: 'migration.queue-payload-compatibility', kind: 'integration' },
        { id: 'migration.queue-scheduler-recovery', kind: 'integration' },
      ]),
    );
    const unchanged = tree.listChanges();
    await expect(
      playstackIntegrateGenerator(tree, {
        ...options,
        verificationProject: 'api',
        verification: '{}',
      }),
    ).rejects.toThrow('every active');
    expect(tree.listChanges()).toEqual(unchanged);
    const fingerprint = JSON.parse(
      tree.read('.megamono/playstack-integrations.json', 'utf8') ?? '{}',
    ).integrations[`${key}@apps%2Fapi`].fingerprint;
    await playstackIntegrateGenerator(tree, {
      ...options,
      migrationContracts: undefined,
      qualification: undefined,
    });
    expect(
      JSON.parse(
        tree.read('.megamono/playstack-integrations.json', 'utf8') ?? '{}',
      ).integrations[`${key}@apps%2Fapi`].fingerprint,
    ).not.toBe(fingerprint);
  });
  it.each(['option', 'decision'])(
    'cannot bypass profile evidence using an adoption-mode %s',
    async (modeSource) => {
      const tree = fixture();
      const key = '@playstack/rate-limit:nest-rate-limit';
      const manifest = integrationManifest(tree);
      manifest.integrations[0].requirements.decisions = [
        {
          key: 'queue.adoptionMode',
          prompt: 'Adoption mode',
          required: false,
          options: ['compare', 'shadow', 'cutover'],
        },
      ];
      writeIntegrationManifest(tree, manifest);
      const before = tree.listChanges();
      await expect(
        playstackIntegrateGenerator(tree, {
          packages: '@playstack/rate-limit',
          api: 'apps/api',
          yes: true,
          migrationContracts: JSON.stringify({ [key]: ['queue-jobs'] }),
          ...(modeSource === 'option'
            ? { adoptionMode: 'cutover' as const }
            : {
                decisions: JSON.stringify({ 'queue.adoptionMode': 'cutover' }),
              }),
        }),
      ).rejects.toThrow('qualified migration stage');
      expect(tree.listChanges()).toEqual(before);
    },
  );
  it('records reviewed environment mappings and reuses an application-owned template without changing it', async () => {
    const tree = fixture();
    const path = 'libs/storage/src/storage.module.ts';
    const content = 'export class PackageStorageModule {}\n';
    tree.write(path, content);
    const options = {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      yes: true,
      equivalences: JSON.stringify({
        'cache.redisUrl': 'CACHE_REDIS_URL',
        RateLimitModule: `existing:${path}#PackageStorageModule`,
        '@playstack/rate-limit:nest-rate-limit:rate-limit-module': `existing:${path}`,
      }),
    };
    await playstackIntegrateGenerator(tree, options);
    expect(tree.read(path, 'utf8')).toBe(content);
    expect(tree.exists('apps/api/src/playstack/rate-limit.module.ts')).toBe(
      false,
    );
    const plan = JSON.parse(
      tree.read('.megamono/playstack-integration-plan.json', 'utf8') ?? '{}',
    );
    expect(plan.files[0]).toMatchObject({ target: path, reused: true });
    expect(plan.selections.equivalences).toContainEqual(
      expect.objectContaining({
        key: 'cache.redisUrl',
        value: 'CACHE_REDIS_URL',
      }),
    );
    await playstackIntegrateGenerator(tree, options);
  });

  it.each([
    { unknown: 'REDIS_URL' },
    { 'cache.redisUrl': 'redis://secret@host' },
    { RateLimitModule: 'existing:../outside.ts#Module' },
    { RateLimitModule: 'existing:libs/missing.ts#Module' },
    { RateLimitModule: 'existing:libs/storage.ts#Missing' },
  ])(
    'rejects invalid equivalences before any generated writes: %j',
    async (equivalences) => {
      const tree = fixture();
      tree.write('libs/storage.ts', 'export class StorageModule {}');
      await expect(
        playstackIntegrateGenerator(tree, {
          packages: '@playstack/rate-limit',
          api: 'apps/api',
          yes: true,
          equivalences: JSON.stringify(equivalences),
        }),
      ).rejects.toThrow();
      expect(tree.exists('apps/api/src/playstack/rate-limit.module.ts')).toBe(
        false,
      );
    },
  );
  it('is stable after repository formatting and preserves real user edits', async () => {
    const tree = fixture();
    tree.write('.prettierrc', '{"singleQuote":false}');
    const manifest = integrationManifest(tree);
    const content = "export const message='hello';\n";
    manifest.integrations[0].templates[0].sha256 = createHash('sha256')
      .update(content)
      .digest('hex');
    tree.write(
      'node_modules/@playstack/rate-limit/templates/rate-limit.module.ts',
      content,
    );
    writeIntegrationManifest(tree, manifest);
    const options = {
      packages: '@playstack/rate-limit',
      api: 'apps/api',
      yes: true,
    };
    await playstackIntegrateGenerator(tree, options);
    const target = 'apps/api/src/playstack/rate-limit.module.ts';
    const formatted = tree.read(target, 'utf8');
    expect(formatted).toBe('export const message = "hello";\n');
    await playstackIntegrateGenerator(tree, options);
    expect(tree.read(target, 'utf8')).toBe(formatted);
    tree.write(target, 'export const message = "user change";\n');
    await expect(playstackIntegrateGenerator(tree, options)).rejects.toThrow(
      'repository-owned content',
    );
    expect(tree.read(target, 'utf8')).toContain('user change');
  });
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
