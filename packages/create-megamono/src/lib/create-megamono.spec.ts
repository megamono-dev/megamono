import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  compatibility,
  configurePublishablePackages,
  CreateMegamonoError,
  createPlan,
  executePlan,
  normalizeCreateOptions,
  preflightPlan,
  readRecovery,
  renderPlan,
  requiredMegamonoPackages,
  type CommandRunner,
} from './create-megamono.js';

async function fixture(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), 'create-megamono-'));
}

function options(cwd: string, overrides: Record<string, unknown> = {}) {
  return normalizeCreateOptions({
    name: 'Acme Tools',
    apps: ['web', 'api'],
    cwd,
    platform: 'darwin',
    packageManager: 'npm',
    ...overrides,
  });
}

async function writeYalcStore(
  root: string,
  packages: readonly string[],
): Promise<void> {
  for (const name of packages) {
    const version = compatibility.scaffoldPackages[name];
    const packageRoot = resolve(root, 'packages', ...name.split('/'), version);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      resolve(packageRoot, 'package.json'),
      JSON.stringify({ name, version }),
    );
  }
}

describe('normalizeCreateOptions', () => {
  it('plans packages-only generation before release discovery and verifies explicit project IDs', () => {
    const plan = createPlan(
      options('/workspace', {
        apps: undefined,
        packages: ['core', 'client'],
        packageScope: '@acme',
        packageAccess: 'public',
        verify: 'build',
      }),
    );
    expect(plan.options.apps).toEqual([]);
    expect(plan.options.packageScope).toBe('acme');
    const rendered = renderPlan(plan);
    expect(rendered).toContain('@nx/js:library');
    expect(rendered).toContain('--directory=packages/core');
    expect(rendered).toContain('--importPath=@acme/core');
    expect(rendered).toContain('--publishable=true');
    expect(rendered).toContain('--projects=acme-tools-core,acme-tools-client');
    expect(rendered).not.toContain('@megamono/plugin:app');
    const ids = plan.steps.map((step) => step.id);
    for (const name of plan.options.packages) {
      expect(
        plan.steps[ids.indexOf(`generate-package-${name}`) + 1],
      ).toMatchObject({
        id: `hydrate-package-${name}`,
        command: 'npm',
        args: ['install'],
      });
    }
    expect(ids.indexOf('configure-publishable-packages')).toBeLessThan(
      ids.indexOf('initialize-megamono'),
    );
  });

  it.each([
    { packages: ['../escape'] },
    { packages: ['core', 'core'] },
    { packages: ['theme'] },
    { packages: ['nest-home'] },
    { packages: ['api'] },
    { packages: ['core'], packageScope: '../acme' },
    { packages: ['core'], packageAccess: 'private' },
  ])('rejects invalid or conflicting package choices: %j', (input) => {
    expect(() => options('/workspace', input)).toThrow(CreateMegamonoError);
  });

  it('sets publication access without replacing generated package exports', async () => {
    const root = await fixture();
    const plan = createPlan(options(root, { apps: [], packages: ['core'] }));
    const packageRoot = resolve(plan.options.stagingDirectory, 'packages/core');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      resolve(plan.options.stagingDirectory, 'package.json'),
      JSON.stringify({
        private: true,
        nx: { targets: { 'local-registry': {} } },
      }),
    );
    await writeFile(
      resolve(plan.options.stagingDirectory, 'nx.json'),
      JSON.stringify({
        release: {
          version: { preVersionCommand: 'pnpm dlx nx run-many -t build' },
        },
      }),
    );
    const manifest = {
      name: '@acme-tools/core',
      exports: { '.': './dist/index.js' },
      files: ['dist'],
      publishConfig: { provenance: true },
    };
    await writeFile(
      resolve(packageRoot, 'package.json'),
      JSON.stringify(manifest),
    );
    await configurePublishablePackages(plan);
    const nx = JSON.parse(
      await readFile(resolve(plan.options.stagingDirectory, 'nx.json'), 'utf8'),
    );
    expect(nx.release.projects).toEqual(['acme-tools-core']);
    expect(nx.release.version.preVersionCommand).toBe(
      'npm exec nx -- run-many -t build --projects=acme-tools-core',
    );
    expect(
      JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')),
    ).toEqual({
      ...manifest,
      publishConfig: { provenance: true, access: 'restricted' },
    });
  });
  it('normalizes the scope and applies stable defaults', () => {
    const normalized = options('/workspace');
    expect(normalized).toMatchObject({
      scope: 'acme-tools',
      apps: ['api', 'web'],
      appInstances: [
        { type: 'api', name: 'api', directory: 'apps/api' },
        { type: 'web', name: 'web', directory: 'apps/web' },
      ],
      services: [],
      databaseAdapter: 'none',
      styling: 'chakra',
      serviceRunner: 'none',
      install: true,
      verify: 'config',
      localPackages: 'registry',
      packageManager: 'npm',
    });
    expect(normalized.destination).toBe('/workspace/acme-tools');
    expect(normalized.stagingDirectory).toBe(
      '/workspace/megamono-acme-tools-staging',
    );
  });

  it('normalizes multiple named instances without collapsing their types', () => {
    const normalized = options('/workspace', {
      apps: [
        'site:marketing',
        'extension:extension-grids',
        'extension:extension-guides',
        'api',
        'web:admin',
        'web',
      ],
    });

    expect(normalized.apps).toEqual(['api', 'extension', 'site', 'web']);
    expect(normalized.appInstances).toEqual([
      { type: 'api', name: 'api', directory: 'apps/api' },
      {
        type: 'extension',
        name: 'extension-grids',
        directory: 'apps/extension-grids',
      },
      {
        type: 'extension',
        name: 'extension-guides',
        directory: 'apps/extension-guides',
      },
      { type: 'site', name: 'marketing', directory: 'apps/marketing' },
      { type: 'web', name: 'web', directory: 'apps/web' },
      { type: 'web', name: 'admin', directory: 'apps/admin' },
    ]);
  });

  it('defaults new workspaces to npm', () => {
    expect(
      normalizeCreateOptions({
        name: 'Acme Tools',
        apps: ['web'],
        cwd: '/workspace',
        platform: 'darwin',
      }).packageManager,
    ).toBe('npm');
  });

  it.each([
    [{ apps: undefined }, 4, 'Select applications'],
    [{ name: undefined }, 4, 'workspace name'],
    [{ apps: ['unknown'] }, 2, 'Unknown app'],
    [{ apps: ['extensions:guides'] }, 2, 'extension:guides'],
    [{ apps: ['web', 'site:web'] }, 2, 'unique name'],
    [{ apps: ['web:Admin Portal'] }, 2, 'normalized slug'],
    [{ integrations: ['sentry'] }, 3, 'fixture gate'],
    [{ apps: ['apple'], platform: 'linux' }, 3, 'requires macOS'],
    [{ localPackages: 'unknown' }, 2, 'local package source'],
    [{ packageManager: 'bower' }, 2, 'package manager'],
    [{ databaseAdapter: 'typeorm' }, 2, 'database adapter'],
    [
      { databaseAdapter: 'prisma', databaseName: 'Main Database' },
      2,
      'database name',
    ],
    [{ platform: 'win32' }, 3, 'supports macOS and Linux'],
  ])('returns a stable diagnostic for %j', (overrides, exitCode, message) => {
    expect(() => options('/workspace', overrides)).toThrowError(
      expect.objectContaining({
        exitCode,
        message: expect.stringContaining(message),
      }),
    );
  });
});

describe('createPlan', () => {
  it('creates an explicitly app-free workspace without app dependencies or empty build selectors', () => {
    const plan = createPlan(
      options('/workspace', { apps: [], verify: 'build' }),
    );
    expect(plan.options.appInstances).toEqual([]);
    expect(plan.options.databaseAdapter).toBe('none');
    expect(plan.steps.some((step) => step.id === 'initialize-megamono')).toBe(
      true,
    );
    expect(plan.steps.some((step) => step.id === 'check-structure')).toBe(true);
    expect(
      plan.steps.some((step) => step.id === 'verify-generated-projects'),
    ).toBe(false);
    expect(renderPlan(plan)).not.toContain('@megamono/plugin:app');
    expect(renderPlan(plan)).not.toContain('@nx/next');
    expect(renderPlan(plan)).not.toContain('@nx/nest');
  });
  it('generates and verifies every named app instance independently', () => {
    const rendered = renderPlan(
      createPlan(
        options('/workspace', {
          apps: [
            'extension:extension-grids',
            'extension:extension-guides',
            'site:marketing',
            'web',
            'web:admin',
          ],
          verify: 'build',
        }),
      ),
    );

    expect(rendered).toContain('--type=extension" "--name=extension-grids');
    expect(rendered).toContain('--type=extension" "--name=extension-guides');
    expect(rendered).toContain('--type=site" "--name=marketing');
    expect(rendered).toContain('--type=web" "--name=admin');
    expect(rendered).toContain('--type=web" "--name=web');
    expect(rendered).toContain(
      '--ports={\\"marketing\\":43017,\\"web\\":43018,\\"admin\\":43021}',
    );
    expect(rendered).toContain(
      '--projects=acme-tools-extension-grids,acme-tools-extension-guides,acme-tools-marketing,acme-tools-web,acme-tools-admin',
    );
    expect(rendered).toContain('acme-tools-marketing-e2e:e2e');
    expect(rendered).toContain('acme-tools-admin-e2e:e2e');
  });

  it.each([
    ['prisma', 'npm'],
    ['drizzle', 'npm'],
    ['prisma', 'pnpm'],
    ['drizzle', 'pnpm'],
  ])(
    'bootstraps the canonical %s database generator with %s in Git-free staging',
    (databaseAdapter, packageManager) => {
      const plan = createPlan(
        options('/workspace', {
          databaseAdapter,
          packageManager,
          databaseName: 'events',
          verify: 'config',
        }),
      );
      const ids = plan.steps.map((step) => step.id);
      expect(ids.indexOf('generate-database-events')).toBe(
        ids.indexOf('initialize-megamono') + 1,
      );
      expect(plan.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'generate-database-events',
            command: packageManager,
            cwd: 'staging',
            args: expect.arrayContaining([
              '@megamono/plugin:database',
              '--name=events',
              `--adapter=${databaseAdapter}`,
              `--project=acme-tools-${databaseAdapter}-events`,
              '--scope=acme-tools',
              '--bootstrap',
            ]),
          }),
          expect.objectContaining({
            id: 'validate-database-events',
            args: expect.arrayContaining([
              'run',
              `acme-tools-${databaseAdapter}-events:validate`,
            ]),
          }),
        ]),
      );
    },
  );

  it('uses a temporary hydrated bootstrap and dehydrates before commit when install is false', () => {
    const plan = createPlan(
      options('/workspace', { install: false, verify: 'none' }),
    );
    const ids = plan.steps.map((step) => step.id);
    const createWorkspace = plan.steps.find(
      (step) => step.kind === 'command' && step.id === 'create-nx-workspace',
    );

    expect(createWorkspace).toEqual(
      expect.objectContaining({
        args: expect.arrayContaining(['--skipInstall=false']),
      }),
    );
    expect(ids).toContain('install-plugins');
    expect(ids.indexOf('dehydrate-workspace')).toBe(
      ids.indexOf('commit-workspace') - 1,
    );
    expect(renderPlan(plan)).toContain(
      'remove bootstrap node_modules for an install-free destination',
    );
  });

  it('projects every supported service through tested Springbar pins', () => {
    const plan = createPlan(
      options('/workspace', {
        services: ['postgres', 'redis', 'clickhouse', 'typesense'],
        serviceRunner: 'springbar',
        verify: 'none',
      }),
    );
    const initialize = plan.steps.find(
      (step) => step.kind === 'command' && step.id === 'initialize-megamono',
    );

    expect(initialize).toEqual(
      expect.objectContaining({
        args: expect.arrayContaining([
          '--serviceRunner=springbar',
          '--serviceRequirements={"clickhouse":"25.8","postgres":"17","redis":"8","typesense":"30.2"}',
        ]),
      }),
    );
  });

  it('uses pnpm for workspace creation, installs, generators, and checks', () => {
    const plan = createPlan(
      options('/workspace', {
        apps: ['desktop', 'web'],
        packageManager: 'pnpm',
        verify: 'build',
      }),
    );
    const commands = plan.steps.filter(
      (
        step,
      ): step is Extract<(typeof plan.steps)[number], { kind: 'command' }> =>
        step.kind === 'command',
    );

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'create-nx-workspace',
          command: 'pnpm',
          args: expect.arrayContaining([
            'dlx',
            'create-nx-workspace@23.1.1',
            '--packageManager=pnpm',
          ]),
        }),
        expect.objectContaining({
          id: 'install-plugins',
          command: 'pnpm',
          args: expect.arrayContaining([
            'add',
            '--save-dev',
            '--save-exact',
            '@nx/eslint@23.1.1',
            '@nx/next@23.1.1',
            '@nx/playwright@23.1.1',
          ]),
        }),
        expect.objectContaining({
          id: 'generate-desktop',
          command: 'pnpm',
          args: expect.arrayContaining([
            'exec',
            'nx',
            'generate',
            '@megamono/plugin:app',
            '--type=desktop',
          ]),
        }),
        expect.objectContaining({
          id: 'generate-web',
          command: 'pnpm',
          args: expect.arrayContaining([
            'exec',
            'nx',
            'generate',
            '@megamono/plugin:app',
            '--type=web',
            '--port=43018',
          ]),
        }),
        expect.objectContaining({
          id: 'verify-generated-projects',
          command: 'pnpm',
        }),
        expect.objectContaining({
          id: 'verify-acme-tools-web-e2e',
          command: 'pnpm',
          args: expect.arrayContaining(['run', 'acme-tools-web-e2e:e2e']),
        }),
      ]),
    );
    expect(renderPlan(plan)).not.toContain('npm exec');
  });

  it.each([
    ['yarn', 'yarn', 'create', 'nx-workspace@23.1.1', 'add', ['nx']],
    ['bun', 'bun', 'x', 'create-nx-workspace@23.1.1', 'add', ['x', 'nx']],
  ] as const)(
    'uses %s consistently across bootstrap, install, and Nx delegation',
    (manager, command, scaffoldVerb, scaffoldPackage, addVerb, nxParts) => {
      const plan = createPlan(
        options('/workspace', {
          apps: ['web'],
          packageManager: manager,
          verify: 'config',
        }),
      );
      const commands = plan.steps.filter(
        (
          step,
        ): step is Extract<(typeof plan.steps)[number], { kind: 'command' }> =>
          step.kind === 'command',
      );
      expect(
        commands.find(({ id }) => id === 'create-nx-workspace'),
      ).toMatchObject({
        command,
        args: expect.arrayContaining([
          scaffoldVerb,
          scaffoldPackage,
          `--packageManager=${manager}`,
        ]),
      });
      expect(commands.find(({ id }) => id === 'install-plugins')).toMatchObject(
        {
          command,
          args: expect.arrayContaining([addVerb, '--dev']),
        },
      );
      expect(commands.find(({ id }) => id === 'generate-web')).toMatchObject({
        command,
        args: expect.arrayContaining([...nxParts, '@megamono/plugin:app']),
      });
    },
  );

  it('uses exact package versions and a deterministic ordered plan', () => {
    const plan = createPlan(
      options('/workspace', { apps: ['site', 'web'], verify: 'build' }),
    );
    const rendered = renderPlan(plan);
    expect(plan.steps.map((step) => step.id)).toEqual([
      'create-nx-workspace',
      'configure-package-manager',
      'install-plugins',
      'generate-site',
      'generate-web',
      'initialize-megamono',
      'sync-workspace',
      'format',
      'validate-docs',
      'check-structure',
      'build-project-graph',
      'verify-generated-projects',
      'verify-acme-tools-site-e2e',
      'verify-acme-tools-web-e2e',
      'commit-workspace',
    ]);
    expect(rendered).toContain('create-nx-workspace@23.1.1');
    expect(rendered).toContain(
      `@megamono/plugin@${compatibility.scaffoldPackages['@megamono/plugin']}`,
    );
    expect(rendered).toContain('@nx/next@23.1.1');
    expect(rendered).toContain('@nx/eslint@23.1.1');
    expect(rendered).toContain('@nx/playwright@23.1.1');
    expect(rendered).toContain('@playwright/test@1.64.1');
    expect(rendered).toContain('@megamono/plugin:app');
    expect(rendered).toContain('--type=site');
    expect(rendered).toContain('--type=web');
    expect(rendered).toContain('--styling=chakra');
    expect(rendered).toContain('--requestedApps=site,web');
    expect(rendered).toContain('--port=43017');
    expect(rendered).toContain('--port=43018');
    expect(rendered).toContain(
      '--only=docs,agents,ci,release,lint,skills,health,inference',
    );
    expect(rendered).toContain('--yes');
    expect(rendered).toContain('--bootstrap');
    expect(rendered).toContain('--platforms=web');
    expect(rendered).toContain('--serviceRunner=none');
    expect(rendered).toContain('--serviceRequirements={}');
    expect(rendered).toContain('"nx" "--" "sync"');
    expect(rendered).toContain('"format:write" "--all"');
    expect(rendered).not.toContain('@latest');
  });

  it('delegates Nest composition and e2e setup to the shared app preset', () => {
    const rendered = renderPlan(
      createPlan(options('/workspace', { apps: ['api'], verify: 'build' })),
    );

    expect(rendered).toContain('@nx/eslint@23.1.1');
    expect(rendered).toContain('@nx/jest@23.1.1');
    expect(rendered).toContain('@swc/jest@0.2.38');
    expect(rendered).toContain('@types/jest@30.0.0');
    expect(rendered).toContain('jest@30.3.0');
    expect(rendered).toContain('jest-environment-node@30.3.0');
    expect(rendered).toContain('jest-util@30.3.0');
    expect(rendered).toContain('ts-jest@29.4.7');
    expect(rendered).toContain('@megamono/plugin:app');
    expect(rendered).toContain('--type=api');
    expect(rendered).toContain('--name=api');
    expect(rendered).toContain('--scope=acme-tools');
    expect(rendered).toContain('--port=43016');
    expect(rendered).toContain('ts-node@10.9.1');
    expect(rendered).toContain('acme-tools-api-e2e:e2e');
  });

  it('ships the same compatibility registry as the workspace plugin', async () => {
    const bundled = JSON.parse(
      await readFile(
        new URL('../../compatibility.json', import.meta.url),
        'utf8',
      ),
    );
    const canonical = JSON.parse(
      await readFile(
        new URL('../../../plugin/compatibility.json', import.meta.url),
        'utf8',
      ),
    );
    expect(bundled).toEqual(canonical);
  });

  it('delegates the Tauri scaffold to the shared app preset', () => {
    const plan = createPlan(
      options('/workspace', { apps: ['desktop'], verify: 'none' }),
    );
    expect(plan.steps.map((step) => step.id)).toEqual([
      'create-nx-workspace',
      'configure-package-manager',
      'install-plugins',
      'generate-desktop',
      'initialize-megamono',
      'commit-workspace',
    ]);
    const rendered = renderPlan(plan);
    expect(rendered).toContain(
      `@megamono/nx-cargo@${compatibility.scaffoldPackages['@megamono/nx-cargo']}`,
    );
    expect(rendered).toContain('@megamono/plugin:app');
    expect(rendered).toContain('--type=desktop');
    expect(rendered).toContain('--defaultScope=acme-tools');
    expect(rendered).toContain('--defaultPlatform=rust');
    expect(rendered).not.toContain('create-tauri-app');
  });

  it('plans a build-ready Apple scaffold on macOS', () => {
    const plan = createPlan(
      options('/workspace', { apps: ['apple'], verify: 'build' }),
    );
    expect(plan.steps.map((step) => step.id)).toEqual([
      'create-nx-workspace',
      'configure-package-manager',
      'install-plugins',
      'generate-apple',
      'initialize-megamono',
      'sync-workspace',
      'format',
      'validate-docs',
      'check-structure',
      'build-project-graph',
      'verify-generated-projects',
      'commit-workspace',
    ]);
    const rendered = renderPlan(plan);
    expect(rendered).toContain(
      `@megamono/nx-apple@${compatibility.scaffoldPackages['@megamono/nx-apple']}`,
    );
    expect(rendered).toContain('@megamono/plugin:app');
    expect(rendered).toContain('--type=apple');
    expect(rendered).toContain('--workspaceName=Acme Tools');
    expect(rendered).toContain('--scope=acme-tools');
    expect(rendered).toContain('--projects=acme-tools-apple');
  });

  it.each(['darwin', 'linux'] as const)(
    'plans native Android applications on %s without Expo or Apple dependencies',
    (platform) => {
      const plan = createPlan(
        options('/workspace', { apps: ['android'], platform, verify: 'build' }),
      );
      const rendered = renderPlan(plan);
      expect(rendered).toContain('--type=android');
      expect(rendered).toContain('--name=android');
      expect(rendered).toContain('--platforms=android');
      expect(rendered).toContain('--projects=acme-tools-android');
      expect(rendered).not.toContain('@nx/expo');
      expect(rendered).not.toContain('@megamono/nx-apple');
    },
  );

  it('plans multiple named Android apps independently', () => {
    const plan = createPlan(
      options('/workspace', {
        apps: ['android:reader', 'android:admin'],
        verify: 'none',
      }),
    );
    const rendered = renderPlan(plan);
    expect(rendered).toContain('--name=reader');
    expect(rendered).toContain('--name=admin');
  });

  it('plans the pinned nx-cloudflare Worker generator', () => {
    const plan = createPlan(
      options('/workspace', { apps: ['worker'], verify: 'build' }),
    );
    expect(plan.steps.map((step) => step.id)).toEqual([
      'create-nx-workspace',
      'configure-package-manager',
      'install-plugins',
      'generate-worker',
      'initialize-megamono',
      'sync-workspace',
      'format',
      'validate-docs',
      'check-structure',
      'build-project-graph',
      'verify-generated-projects',
      'commit-workspace',
    ]);
    const rendered = renderPlan(plan);
    expect(rendered).toContain(
      `@megamono/nx-cloudflare@${compatibility.scaffoldPackages['@megamono/nx-cloudflare']}`,
    );
    expect(rendered).toContain('wrangler@4.125.0');
    expect(rendered).toContain('@megamono/plugin:app');
    expect(rendered).toContain('--type=worker');
    expect(rendered).toContain('--scope=acme-tools');
    expect(rendered).not.toContain('@nx/vitest');
  });

  it('initializes governance once before composing each shared app preset', () => {
    const plan = createPlan(
      options('/workspace', {
        apps: ['worker', 'mobile', 'desktop'],
        verify: 'none',
      }),
    );
    expect(plan.steps.map((step) => step.id)).toEqual([
      'create-nx-workspace',
      'configure-package-manager',
      'install-plugins',
      'generate-desktop',
      'generate-mobile',
      'generate-worker',
      'initialize-megamono',
      'commit-workspace',
    ]);
    expect(renderPlan(plan)).toContain('--platforms=mobile,rust,worker');
  });

  it('keeps the dry-run and execution plan identical', () => {
    const execute = createPlan(options('/workspace'));
    const dryRun = createPlan(options('/workspace', { dryRun: true }));
    expect(dryRun.steps).toEqual(execute.steps);
  });

  it('installs only Megamono packages from exact yalc store versions', () => {
    const plan = createPlan(
      options('/workspace', {
        apps: ['desktop', 'worker'],
        localPackages: 'yalc',
        verify: 'none',
      }),
    );
    expect(requiredMegamonoPackages(plan.options)).toEqual([
      '@megamono/nx-cargo',
      '@megamono/nx-cloudflare',
      '@megamono/plugin',
    ]);
    expect(plan.steps.slice(0, 5).map((step) => step.id)).toEqual([
      'create-nx-workspace',
      'configure-package-manager',
      'install-plugins',
      'install-local-packages',
      'hydrate-local-packages',
    ]);
    const registryInstall = plan.steps[2];
    const yalcInstall = plan.steps[3];
    expect(registryInstall).toMatchObject({
      kind: 'command',
      command: 'npm',
      args: expect.arrayContaining([
        'install',
        '--save-dev',
        '--save-exact',
        'typescript@6.0.3',
        'wrangler@4.125.0',
      ]),
    });
    expect(registryInstall).not.toEqual(
      expect.objectContaining({
        args: expect.arrayContaining([
          `@megamono/plugin@${compatibility.scaffoldPackages['@megamono/plugin']}`,
        ]),
      }),
    );
    expect(yalcInstall).toEqual({
      kind: 'command',
      id: 'install-local-packages',
      command: 'yalc',
      args: [
        'add',
        `@megamono/nx-cargo@${compatibility.scaffoldPackages['@megamono/nx-cargo']}`,
        `@megamono/nx-cloudflare@${compatibility.scaffoldPackages['@megamono/nx-cloudflare']}`,
        `@megamono/plugin@${compatibility.scaffoldPackages['@megamono/plugin']}`,
        '--dev',
        '--no-pure',
      ],
      cwd: 'staging',
    });
    expect(renderPlan(plan)).toContain(
      `"@megamono/plugin@${compatibility.scaffoldPackages['@megamono/plugin']}" "--dev" "--no-pure"`,
    );
  });

  it('places the optional Springbar MCP handoff after the atomic commit', () => {
    const plan = createPlan(
      options('/workspace', { serviceRunner: 'springbar', verify: 'none' }),
    );
    expect(plan.steps.slice(-2).map((step) => step.id)).toEqual([
      'commit-workspace',
      'configure-springbar',
    ]);
    expect(renderPlan(plan)).toContain(
      'Springbar MCP inspect_candidates -> setup_workspace',
    );
  });
});

describe('executePlan', () => {
  it('does not create staging or destination during a dry run', async () => {
    const cwd = await fixture();
    const plan = createPlan(options(cwd, { dryRun: true }));
    let calls = 0;
    await executePlan(plan, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    await expect(readFile(plan.options.destination)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(plan.options.stagingDirectory)).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });

  it('commits an install-free workspace with its manifests and lockfile intact', async () => {
    const cwd = await fixture();
    const plan = createPlan(
      options(cwd, {
        apps: ['worker'],
        install: false,
        verify: 'none',
      }),
    );
    let initialized = false;
    const runner: CommandRunner = async () => {
      if (initialized) return;
      initialized = true;
      await mkdir(resolve(plan.options.stagingDirectory, 'node_modules/pkg'), {
        recursive: true,
      });
      await mkdir(
        resolve(plan.options.stagingDirectory, 'apps/worker/node_modules/pkg'),
        { recursive: true },
      );
      await writeFile(
        resolve(plan.options.stagingDirectory, 'package.json'),
        JSON.stringify({ private: true }),
      );
      await writeFile(
        resolve(plan.options.stagingDirectory, 'package-lock.json'),
        '{}',
      );
    };

    await executePlan(plan, runner);

    expect(
      JSON.parse(
        await readFile(
          resolve(plan.options.destination, 'package.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ private: true, packageManager: 'npm@11.17.0' });
    await expect(
      readFile(resolve(plan.options.destination, 'package-lock.json'), 'utf8'),
    ).resolves.toBe('{}');
    await expect(
      readFile(resolve(plan.options.destination, 'node_modules/pkg')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(
        resolve(plan.options.destination, 'apps/worker/node_modules/pkg'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a non-empty destination before running commands', async () => {
    const cwd = await fixture();
    const plan = createPlan(options(cwd));
    await mkdir(plan.options.destination);
    await writeFile(resolve(plan.options.destination, 'owned.txt'), 'keep');
    await expect(preflightPlan(plan)).rejects.toMatchObject({ exitCode: 3 });
    expect(
      await readFile(resolve(plan.options.destination, 'owned.txt'), 'utf8'),
    ).toBe('keep');
  });

  it('refuses a file destination as a preflight error', async () => {
    const cwd = await fixture();
    const plan = createPlan(options(cwd));
    await writeFile(plan.options.destination, 'keep');
    await expect(preflightPlan(plan)).rejects.toMatchObject({ exitCode: 3 });
    expect(await readFile(plan.options.destination, 'utf8')).toBe('keep');
  });

  it('refuses a missing exact yalc package before creating staging', async () => {
    const cwd = await fixture();
    const store = await fixture();
    const plan = createPlan(
      options(cwd, {
        apps: ['worker'],
        localPackages: 'yalc',
        verify: 'none',
      }),
    );
    await writeYalcStore(store, ['@megamono/plugin']);
    await expect(preflightPlan(plan, async () => store)).rejects.toMatchObject({
      exitCode: 3,
      message: expect.stringContaining(
        `missing: @megamono/nx-cloudflare@${compatibility.scaffoldPackages['@megamono/nx-cloudflare']}`,
      ),
    });
    await expect(readFile(plan.options.stagingDirectory)).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });

  it('hydrates yalc packages before invoking the shared app preset', async () => {
    const cwd = await fixture();
    const store = await fixture();
    const plan = createPlan(
      options(cwd, {
        apps: ['api'],
        localPackages: 'yalc',
        verify: 'none',
      }),
    );
    await writeYalcStore(store, requiredMegamonoPackages(plan.options));
    const invocations: string[] = [];
    let initialized = false;
    const runner: CommandRunner = async ({ command, args }) => {
      invocations.push([command, ...args].join(' '));
      if (!initialized) {
        initialized = true;
        await mkdir(plan.options.stagingDirectory, { recursive: true });
        await writeFile(
          resolve(plan.options.stagingDirectory, 'package.json'),
          '{}',
        );
      }
    };

    await executePlan(plan, runner, undefined, async () => store);

    expect(invocations.slice(0, 4)).toEqual([
      expect.stringContaining('create-nx-workspace@23.1.1'),
      expect.stringContaining(
        'npm install --save-dev --save-exact @nx/eslint@23.1.1 @nx/jest@23.1.1 @nx/nest@23.1.1',
      ),
      `yalc add @megamono/plugin@${compatibility.scaffoldPackages['@megamono/plugin']} --dev --no-pure`,
      'npm install',
    ]);
    expect(invocations[4]).toContain('@megamono/plugin:app');
    expect(invocations[4]).toContain('--type=api');
    expect(invocations[5]).toContain('@megamono/plugin:workspace-init');
    expect(
      JSON.parse(
        await readFile(
          resolve(plan.options.destination, 'package.json'),
          'utf8',
        ),
      ),
    ).toEqual({ packageManager: 'npm@11.17.0' });
  });

  it.each(['prisma', 'drizzle', 'none'])(
    'configures adapter-scoped build approvals before installing %s',
    async (databaseAdapter) => {
      const cwd = await fixture();
      const plan = createPlan(
        options(cwd, {
          packageManager: 'pnpm',
          databaseAdapter,
          verify: 'none',
        }),
      );
      let first = true;
      const runner: CommandRunner = async () => {
        if (first) {
          first = false;
          await mkdir(plan.options.stagingDirectory);
          await writeFile(
            resolve(plan.options.stagingDirectory, 'package.json'),
            '{}',
          );
          await writeFile(
            resolve(plan.options.stagingDirectory, 'pnpm-workspace.yaml'),
            "packages:\n  - 'packages/*'\nallowBuilds:\n  '@swc/core': false\n  custom: false\n",
          );
          return;
        }
        const policy = await readFile(
          resolve(plan.options.stagingDirectory, 'pnpm-workspace.yaml'),
          'utf8',
        );
        expect(policy).toContain('"@swc/core": false');
        expect(policy).toContain('custom: false');
        expect(policy.match(/@swc\/core/g)).toHaveLength(1);
        if (databaseAdapter === 'prisma') {
          expect(policy).toContain('"@prisma/engines": true');
          expect(policy).toContain('prisma: true');
        } else {
          expect(policy).not.toContain('prisma');
        }
      };
      await executePlan(plan, runner);
    },
  );

  it('commits a staged workspace over an empty destination', async () => {
    const cwd = await fixture();
    const plan = createPlan(
      options(cwd, { verify: 'none', services: ['postgres'] }),
    );
    await mkdir(plan.options.destination);
    let first = true;
    const runner: CommandRunner = async () => {
      if (first) {
        first = false;
        await mkdir(plan.options.stagingDirectory);
        await writeFile(
          resolve(plan.options.stagingDirectory, 'package.json'),
          '{}',
        );
        await writeFile(
          resolve(plan.options.stagingDirectory, 'megamono.json'),
          JSON.stringify({
            version: 1,
            platforms: ['node', 'web'],
            services: { runner: 'none', requirements: { postgres: '17' } },
          }),
        );
      }
    };
    await executePlan(plan, runner);
    expect(
      JSON.parse(
        await readFile(
          resolve(plan.options.destination, 'package.json'),
          'utf8',
        ),
      ),
    ).toEqual({ packageManager: 'npm@11.17.0' });
    expect(
      JSON.parse(
        await readFile(
          resolve(plan.options.destination, 'megamono.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      platforms: ['node', 'web'],
      services: { runner: 'none', requirements: { postgres: '17' } },
    });
  });

  it('retains staging with recovery details after a forced failure', async () => {
    const cwd = await fixture();
    const plan = createPlan(options(cwd));
    const runner: CommandRunner = async () => {
      await mkdir(plan.options.stagingDirectory, { recursive: true });
      throw new Error('forced install failure');
    };
    await expect(executePlan(plan, runner)).rejects.toMatchObject({
      exitCode: 1,
      name: 'CreateMegamonoError',
    } satisfies Partial<CreateMegamonoError>);
    const recovery = await readRecovery(plan.options.stagingDirectory);
    expect(recovery).toContain('forced install failure');
    expect(recovery).toContain('Completed steps:\n- none');
    await expect(readFile(plan.options.destination)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('configures Springbar against the committed destination as the last step', async () => {
    const cwd = await fixture();
    const plan = createPlan(
      options(cwd, {
        apps: ['api', 'web'],
        services: ['postgres'],
        serviceRunner: 'springbar',
        verify: 'none',
      }),
    );
    let first = true;
    const runner: CommandRunner = async ({ args }) => {
      if (args.includes('@megamono/plugin:workspace-init')) {
        await writeFile(
          resolve(plan.options.stagingDirectory, 'megamono.json'),
          JSON.stringify({
            version: 1,
            platforms: ['node', 'web'],
            services: {
              runner: 'springbar',
              requirements: { postgres: '17' },
            },
          }),
        );
        return;
      }
      if (first) {
        first = false;
        await mkdir(plan.options.stagingDirectory);
        await writeFile(
          resolve(plan.options.stagingDirectory, 'package.json'),
          '{}',
        );
        await writeFile(
          resolve(plan.options.stagingDirectory, 'megamono.json'),
          JSON.stringify({ version: 1 }),
        );
      }
    };
    await executePlan(plan, runner, async (intent) => {
      expect(
        await readFile(resolve(intent.workspaceRoot, 'megamono.json'), 'utf8'),
      ).toContain('springbar');
      expect(intent.services).toEqual([
        {
          service: 'postgres',
          version: '17',
          dependentApps: ['api'],
        },
      ]);
      return { configured: true, message: 'configured' };
    });
    expect(plan.springbarResult).toEqual({
      configured: true,
      message: 'configured',
    });
  });

  it('keeps a committed workspace and retry payload when the MCP is unavailable', async () => {
    const cwd = await fixture();
    const plan = createPlan(
      options(cwd, { serviceRunner: 'springbar', verify: 'none' }),
    );
    let first = true;
    await executePlan(
      plan,
      async ({ args }) => {
        if (args.includes('@megamono/plugin:workspace-init')) {
          await writeFile(
            resolve(plan.options.stagingDirectory, 'megamono.json'),
            JSON.stringify({
              version: 1,
              platforms: ['node', 'web'],
              services: { runner: 'springbar', requirements: {} },
            }),
          );
          return;
        }
        if (first) {
          first = false;
          await mkdir(plan.options.stagingDirectory);
          await writeFile(
            resolve(plan.options.stagingDirectory, 'package.json'),
            '{}',
          );
          await writeFile(
            resolve(plan.options.stagingDirectory, 'megamono.json'),
            JSON.stringify({ version: 1 }),
          );
        }
      },
      async () => {
        throw new Error('springbar-mcp ENOENT');
      },
    );
    expect(
      await readFile(
        resolve(plan.options.destination, 'megamono.json'),
        'utf8',
      ),
    ).toContain('springbar');
    expect(plan.springbarResult).toMatchObject({
      configured: false,
      message: expect.stringContaining('springbar-mcp ENOENT'),
      retry: {
        inspect: { tool: 'inspect_candidates' },
        setup: { tool: 'setup_workspace' },
      },
    });
    await expect(readFile(plan.options.stagingDirectory)).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    );
  });
});
