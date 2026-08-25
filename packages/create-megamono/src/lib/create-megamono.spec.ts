import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  CreateMegamonoError,
  createPlan,
  executePlan,
  normalizeCreateOptions,
  preflightPlan,
  readRecovery,
  renderPlan,
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
    ...overrides,
  });
}

async function writeInferredAppPackage(
  stagingDirectory: string,
  app: 'mobile' | 'site' | 'web',
): Promise<void> {
  const root = resolve(stagingDirectory, `apps/${app}`);
  await mkdir(root, { recursive: true });
  await writeFile(
    resolve(root, 'package.json'),
    JSON.stringify({ nx: { name: `acme-tools-${app}` } }),
  );
}

describe('normalizeCreateOptions', () => {
  it('normalizes the scope and applies stable defaults', () => {
    const normalized = options('/workspace');
    expect(normalized).toMatchObject({
      scope: 'acme-tools',
      apps: ['api', 'web'],
      services: [],
      serviceRunner: 'none',
      install: true,
      verify: 'config',
    });
    expect(normalized.destination).toBe('/workspace/acme-tools');
    expect(normalized.stagingDirectory).toBe(
      '/workspace/megamono-acme-tools-staging',
    );
  });

  it.each([
    [{ apps: [] }, 4, 'At least one app'],
    [{ name: undefined }, 4, 'workspace name'],
    [{ apps: ['unknown'] }, 2, 'Unknown app'],
    [{ services: ['redis'] }, 3, 'compatibility pin'],
    [{ integrations: ['sentry'] }, 3, 'fixture gate'],
    [{ apps: ['apple'], platform: 'linux' }, 3, 'requires macOS'],
    [{ install: false }, 3, 'no-install generation path'],
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
  it('uses exact package versions and a deterministic ordered plan', () => {
    const plan = createPlan(
      options('/workspace', { apps: ['site', 'web'], verify: 'build' }),
    );
    const rendered = renderPlan(plan);
    expect(plan.steps.map((step) => step.id)).toEqual([
      'create-nx-workspace',
      'install-plugins',
      'generate-site',
      'configure-site',
      'generate-web',
      'configure-web',
      'initialize-megamono',
      'format',
      'validate-docs',
      'check-structure',
      'build-project-graph',
      'verify-generated-projects',
      'commit-workspace',
    ]);
    expect(rendered).toContain('create-nx-workspace@23.1.1');
    expect(rendered).toContain('@megamono/plugin@0.0.1');
    expect(rendered).toContain('@nx/next@23.1.1');
    expect(rendered).toContain('--appDir=false');
    expect(rendered).toContain(
      '--only=docs,agents,ci,lint,skills,health,inference',
    );
    expect(rendered).toContain('--yes');
    expect(rendered).toContain('--bootstrap');
    expect(rendered).toContain('--platforms=web');
    expect(rendered).toContain('--serviceRunner=none');
    expect(rendered).toContain('--serviceRequirements={}');
    expect(rendered).not.toContain('--router=pages');
    expect(rendered).toContain('format:write');
    expect(rendered).not.toContain('@latest');
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

  it('uses the pinned Tauri scaffold and normalizes it before initialization', () => {
    const plan = createPlan(
      options('/workspace', { apps: ['desktop'], verify: 'none' }),
    );
    expect(plan.steps.map((step) => step.id)).toEqual([
      'create-nx-workspace',
      'install-plugins',
      'generate-desktop',
      'configure-desktop',
      'install-desktop-dependencies',
      'initialize-megamono',
      'commit-workspace',
    ]);
    const rendered = renderPlan(plan);
    expect(rendered).toContain('create-tauri-app@4.6.2');
    expect(rendered).toContain('apps/desktop');
    expect(rendered).toContain('com.acme-tools.desktop');
    expect(rendered).toContain('@megamono/nx-cargo@0.0.1');
    expect(rendered).toContain('--defaultScope=acme-tools');
    expect(rendered).toContain('--defaultPlatform=rust');
    expect(rendered).not.toContain('@megamono/nx-cargo:application');
  });

  it('plans a build-ready Apple scaffold on macOS', () => {
    const plan = createPlan(
      options('/workspace', { apps: ['apple'], verify: 'build' }),
    );
    expect(plan.steps.map((step) => step.id)).toEqual([
      'create-nx-workspace',
      'install-plugins',
      'generate-apple',
      'initialize-megamono',
      'format',
      'validate-docs',
      'check-structure',
      'build-project-graph',
      'verify-generated-projects',
      'commit-workspace',
    ]);
    const rendered = renderPlan(plan);
    expect(rendered).toContain('@megamono/nx-apple@0.0.1');
    expect(rendered).toContain('@megamono/nx-apple:application');
    expect(rendered).toContain('--directory=apps/apple');
    expect(rendered).toContain('--displayName=Acme Tools');
    expect(rendered).toContain('--bundleIdentifier=com.acme-tools.apple');
    expect(rendered).toContain('--scope=acme-tools');
    expect(rendered).toContain(
      '--tags=platform:apple,scope:acme-tools,type:app,visibility:internal',
    );
    expect(rendered).toContain('--projects=acme-tools-apple');
  });

  it('plans the pinned nx-cloudflare Worker generator', () => {
    const plan = createPlan(
      options('/workspace', { apps: ['worker'], verify: 'build' }),
    );
    expect(plan.steps.map((step) => step.id)).toEqual([
      'create-nx-workspace',
      'install-plugins',
      'generate-worker',
      'initialize-megamono',
      'format',
      'validate-docs',
      'check-structure',
      'build-project-graph',
      'verify-generated-projects',
      'commit-workspace',
    ]);
    const rendered = renderPlan(plan);
    expect(rendered).toContain('@megamono/nx-cloudflare@0.0.1');
    expect(rendered).toContain('wrangler@4.125.0');
    expect(rendered).toContain('@megamono/nx-cloudflare:worker');
    expect(rendered).toContain('--directory=apps/worker');
    expect(rendered).toContain('--scope=acme-tools');
    expect(rendered).not.toContain('@nx/js:library');
    expect(rendered).not.toContain('@nx/vitest');
  });

  it('installs the normalized Desktop workspace before later Nx generators', () => {
    const plan = createPlan(
      options('/workspace', {
        apps: ['worker', 'mobile', 'desktop'],
        verify: 'none',
      }),
    );
    expect(plan.steps.map((step) => step.id)).toEqual([
      'create-nx-workspace',
      'install-plugins',
      'generate-desktop',
      'configure-desktop',
      'install-desktop-dependencies',
      'generate-mobile',
      'configure-mobile',
      'generate-worker',
      'initialize-megamono',
      'commit-workspace',
    ]);
  });

  it('keeps the dry-run and execution plan identical', () => {
    const execute = createPlan(options('/workspace'));
    const dryRun = createPlan(options('/workspace', { dryRun: true }));
    expect(dryRun.steps).toEqual(execute.steps);
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

  it('commits a staged workspace over an empty destination', async () => {
    const cwd = await fixture();
    const plan = createPlan(
      options(cwd, { verify: 'none', services: ['postgres'] }),
    );
    await mkdir(plan.options.destination);
    let first = true;
    const runner: CommandRunner = async () => {
      if (!first) return;
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
      await writeInferredAppPackage(plan.options.stagingDirectory, 'web');
    };
    await executePlan(plan, runner);
    expect(
      await readFile(resolve(plan.options.destination, 'package.json'), 'utf8'),
    ).toBe('{}');
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

  it('normalizes the generated Desktop app and registers Cargo inference', async () => {
    const cwd = await fixture();
    const plan = createPlan(
      options(cwd, { apps: ['desktop'], verify: 'none' }),
    );
    let initialized = false;
    const runner: CommandRunner = async ({ args }) => {
      if (args.includes('@megamono/plugin:workspace-init')) {
        await writeFile(
          resolve(plan.options.stagingDirectory, 'megamono.json'),
          JSON.stringify({
            version: 1,
            platforms: ['rust'],
            services: { runner: 'none', requirements: {} },
          }),
        );
        return;
      }
      if (initialized) return;
      initialized = true;
      await mkdir(
        resolve(plan.options.stagingDirectory, 'apps/desktop/src-tauri/src'),
        { recursive: true },
      );
      await writeFile(
        resolve(plan.options.stagingDirectory, 'package.json'),
        JSON.stringify({
          name: 'root',
          private: true,
          workspaces: ['packages/*'],
        }),
      );
      await writeFile(
        resolve(plan.options.stagingDirectory, 'nx.json'),
        JSON.stringify({ plugins: ['@nx/js/typescript'] }),
      );
      await writeFile(
        resolve(plan.options.stagingDirectory, 'megamono.json'),
        JSON.stringify({ version: 1 }),
      );
      await writeFile(
        resolve(plan.options.stagingDirectory, 'apps/desktop/package.json'),
        JSON.stringify({
          name: 'appsdesktop',
          private: true,
          dependencies: {
            '@tauri-apps/api': '^2',
            '@tauri-apps/plugin-opener': '^2',
          },
          devDependencies: {
            '@tauri-apps/cli': '^2',
            typescript: '~5.6.2',
            vite: '^6.0.3',
          },
        }),
      );
      await writeFile(
        resolve(
          plan.options.stagingDirectory,
          'apps/desktop/src-tauri/Cargo.toml',
        ),
        `[package]\nname = "appsdesktop"\n\n[lib]\nname = "appsdesktop_lib"\n\n[build-dependencies]\ntauri-build = { version = "2", features = [] }\n\n[dependencies]\ntauri = { version = "2", features = [] }\ntauri-plugin-opener = "2"\nserde = { version = "1", features = ["derive"] }\nserde_json = "1"\n`,
      );
      await writeFile(
        resolve(
          plan.options.stagingDirectory,
          'apps/desktop/src-tauri/src/main.rs',
        ),
        'fn main() {\n    appsdesktop_lib::run()\n}\n',
      );
      await writeFile(
        resolve(
          plan.options.stagingDirectory,
          'apps/desktop/src-tauri/tauri.conf.json',
        ),
        JSON.stringify({
          productName: 'appsdesktop',
          identifier: 'com.appsdesktop.app',
          app: { windows: [{ title: 'appsdesktop' }] },
        }),
      );
    };
    await executePlan(plan, runner);

    const rootPackage = JSON.parse(
      await readFile(resolve(plan.options.destination, 'package.json'), 'utf8'),
    );
    expect(rootPackage.workspaces).toEqual(['apps/*', 'packages/*']);
    expect(rootPackage.devDependencies).toMatchObject({ vite: '8.1.4' });
    const desktopPackage = JSON.parse(
      await readFile(
        resolve(plan.options.destination, 'apps/desktop/package.json'),
        'utf8',
      ),
    );
    expect(desktopPackage).toMatchObject({
      name: 'acme-tools-desktop',
      dependencies: {
        '@tauri-apps/api': '2.11.1',
        '@tauri-apps/plugin-opener': '2.5.4',
      },
      devDependencies: {
        '@tauri-apps/cli': '2.11.4',
        typescript: '6.0.3',
        vite: '8.1.4',
      },
    });
    const cargo = await readFile(
      resolve(plan.options.destination, 'apps/desktop/src-tauri/Cargo.toml'),
      'utf8',
    );
    expect(cargo).toContain('name = "acme-tools-desktop"');
    expect(cargo).toContain('version = "=2.11.5"');
    expect(cargo).not.toMatch(/version\s*=\s*"2"/);
    const main = await readFile(
      resolve(plan.options.destination, 'apps/desktop/src-tauri/src/main.rs'),
      'utf8',
    );
    expect(main).toContain('acme_tools_desktop_lib::run()');
    expect(main).not.toContain('appsdesktop_lib::run()');
    const nxJson = JSON.parse(
      await readFile(resolve(plan.options.destination, 'nx.json'), 'utf8'),
    );
    expect(nxJson.plugins).toContainEqual({
      plugin: '@megamono/nx-cargo',
      options: {
        scope: 'acme-tools',
        tauriTargetName: 'tauri-build',
      },
    });
    const megamono = JSON.parse(
      await readFile(
        resolve(plan.options.destination, 'megamono.json'),
        'utf8',
      ),
    );
    expect(megamono.platforms).toEqual(['rust']);
  });

  it('preserves the nx-cloudflare Worker generator output through commit', async () => {
    const cwd = await fixture();
    const plan = createPlan(options(cwd, { apps: ['worker'], verify: 'none' }));
    let initialized = false;
    const runner: CommandRunner = async ({ args }) => {
      if (!initialized) {
        initialized = true;
        await mkdir(plan.options.stagingDirectory, { recursive: true });
        await writeFile(
          resolve(plan.options.stagingDirectory, 'package.json'),
          JSON.stringify({
            devDependencies: {
              '@megamono/nx-cloudflare': '0.0.1',
              wrangler: '4.125.0',
            },
          }),
        );
        await writeFile(
          resolve(plan.options.stagingDirectory, 'nx.json'),
          JSON.stringify({ plugins: [] }),
        );
      }
      if (args.includes('@megamono/nx-cloudflare:worker')) {
        const workerRoot = resolve(
          plan.options.stagingDirectory,
          'apps/worker',
        );
        await mkdir(resolve(workerRoot, 'src'), { recursive: true });
        await writeFile(
          resolve(workerRoot, 'project.json'),
          JSON.stringify({
            name: 'acme-tools-worker',
            projectType: 'application',
            sourceRoot: 'apps/worker/src',
            tags: [
              'platform:worker',
              'scope:acme-tools',
              'type:app',
              'visibility:internal',
            ],
          }),
        );
        await writeFile(
          resolve(workerRoot, 'src/index.ts'),
          "export default { fetch: () => new Response('ok') };\n",
        );
        await writeFile(
          resolve(workerRoot, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: { types: ['./worker-configuration.d.ts'] },
          }),
        );
        await writeFile(
          resolve(workerRoot, 'worker-configuration.d.ts'),
          'interface Env {}\n',
        );
        await writeFile(
          resolve(workerRoot, 'wrangler.jsonc'),
          JSON.stringify({
            $schema: '../../node_modules/wrangler/config-schema.json',
            name: 'acme-tools-worker',
            main: 'src/index.ts',
            compatibility_date: '2026-08-23',
          }),
        );
        await writeFile(
          resolve(plan.options.stagingDirectory, 'nx.json'),
          JSON.stringify({ plugins: ['@megamono/nx-cloudflare'] }),
        );
      }
      if (args.includes('@megamono/plugin:workspace-init')) {
        await writeFile(
          resolve(plan.options.stagingDirectory, 'megamono.json'),
          JSON.stringify({ version: 1, platforms: ['worker'] }),
        );
      }
    };
    await executePlan(plan, runner);

    const workerRoot = resolve(plan.options.destination, 'apps/worker');
    const project = JSON.parse(
      await readFile(resolve(workerRoot, 'project.json'), 'utf8'),
    );
    expect(project).toMatchObject({
      name: 'acme-tools-worker',
      projectType: 'application',
      tags: expect.arrayContaining(['platform:worker', 'scope:acme-tools']),
    });
    expect(
      await readFile(resolve(workerRoot, 'src/index.ts'), 'utf8'),
    ).toContain('export default');
    const nxJson = JSON.parse(
      await readFile(resolve(plan.options.destination, 'nx.json'), 'utf8'),
    );
    expect(nxJson.plugins).toContain('@megamono/nx-cloudflare');
    expect(
      await readFile(resolve(workerRoot, 'worker-configuration.d.ts'), 'utf8'),
    ).toContain('interface Env');
    expect(
      JSON.parse(await readFile(resolve(workerRoot, 'wrangler.jsonc'), 'utf8')),
    ).toMatchObject({
      name: 'acme-tools-worker',
      main: 'src/index.ts',
      compatibility_date: '2026-08-23',
      $schema: '../../node_modules/wrangler/config-schema.json',
    });
  });

  it('marks inferred package-manifest app projects as applications', async () => {
    const cwd = await fixture();
    const apps = ['mobile', 'site', 'web'] as const;
    const plan = createPlan(options(cwd, { apps, verify: 'none' }));
    let initialized = false;
    const runner: CommandRunner = async () => {
      if (initialized) return;
      initialized = true;
      for (const app of apps) {
        await mkdir(resolve(plan.options.stagingDirectory, `apps/${app}`), {
          recursive: true,
        });
      }
      await mkdir(
        resolve(plan.options.stagingDirectory, 'apps/mobile/src/app'),
        { recursive: true },
      );
      await writeFile(
        resolve(plan.options.stagingDirectory, 'package.json'),
        '{}',
      );
      await writeFile(resolve(plan.options.stagingDirectory, 'nx.json'), '{}');
      await writeFile(
        resolve(plan.options.stagingDirectory, 'megamono.json'),
        JSON.stringify({ version: 1 }),
      );
      for (const app of apps) {
        await writeFile(
          resolve(plan.options.stagingDirectory, `apps/${app}/package.json`),
          JSON.stringify({
            name: `@acme-tools/${app}`,
            nx: { name: `acme-tools-${app}`, tags: ['platform:web'] },
          }),
        );
      }
      await writeFile(
        resolve(plan.options.stagingDirectory, 'apps/mobile/src/app/App.tsx'),
        '/* eslint-disable jsx-a11y/accessible-emoji */\nexport const App = () => null;\n',
      );
    };

    await executePlan(plan, runner);

    for (const app of apps) {
      const packageJson = JSON.parse(
        await readFile(
          resolve(plan.options.destination, `apps/${app}/package.json`),
          'utf8',
        ),
      );
      expect(packageJson.nx).toMatchObject({
        name: `acme-tools-${app}`,
        projectType: 'application',
        tags: ['platform:web'],
      });
      expect(renderPlan(plan)).toContain(
        `normalize apps/${app} as an application project`,
      );
    }
    expect(
      await readFile(
        resolve(plan.options.destination, 'apps/mobile/src/app/App.tsx'),
        'utf8',
      ),
    ).not.toContain('jsx-a11y/accessible-emoji');
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
      if (!first) return;
      first = false;
      await mkdir(plan.options.stagingDirectory);
      await writeFile(
        resolve(plan.options.stagingDirectory, 'megamono.json'),
        JSON.stringify({ version: 1 }),
      );
      await writeInferredAppPackage(plan.options.stagingDirectory, 'web');
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
        if (!first) return;
        first = false;
        await mkdir(plan.options.stagingDirectory);
        await writeFile(
          resolve(plan.options.stagingDirectory, 'megamono.json'),
          JSON.stringify({ version: 1 }),
        );
        await writeInferredAppPackage(plan.options.stagingDirectory, 'web');
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
