import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runMegamonoCli,
  type CommandResult,
  type MegamonoCliIo,
  type PackageManager,
  type WorkspaceMutationState,
} from './cli.js';
import type { HostedAuthOperations, HostedProfile } from './hosted-auth.js';

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly capture: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

const fixtures: string[] = [];

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function workspace(
  manager: PackageManager,
  packages: readonly string[] = ['nx', '@megamono/plugin'],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'megamono-cli-'));
  fixtures.push(root);
  await json(join(root, 'package.json'), {
    name: 'fixture',
    private: true,
    devDependencies: Object.fromEntries(
      packages.map((name) => [name, '0.0.1']),
    ),
  });
  await json(join(root, 'nx.json'), {});
  await json(join(root, 'megamono.json'), {
    version: 1,
    conventions: {
      nestFeatureLibraries: true,
      docsLocation: 'centralized',
      packageManager: manager,
      rules: {},
    },
  });
  const lockfiles: Record<PackageManager, readonly [string, string]> = {
    npm: ['package-lock.json', '{"lockfileVersion":3}\n'],
    pnpm: ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
    yarn: ['yarn.lock', '# yarn lockfile v1\n'],
    bun: ['bun.lock', '{}\n'],
  };
  await writeFile(join(root, lockfiles[manager][0]), lockfiles[manager][1]);
  for (const packageName of packages) {
    await json(
      join(root, 'node_modules', ...packageName.split('/'), 'package.json'),
      {
        name: packageName,
        version: '0.0.1',
        ...(['nx', '@playstack/cli'].includes(packageName)
          ? {
              bin: {
                [packageName === 'nx' ? 'nx' : 'playstack']: './bin/cli.js',
              },
            }
          : {}),
      },
    );
    if (['nx', '@playstack/cli'].includes(packageName)) {
      await mkdir(join(root, 'node_modules', packageName, 'bin'), {
        recursive: true,
      });
      await writeFile(
        join(root, 'node_modules', packageName, 'bin/cli.js'),
        '// fixture executable',
      );
    }
  }
  if (packages.includes('@megamono/plugin')) {
    await json(
      join(root, 'node_modules', '@megamono', 'plugin', 'compatibility.json'),
      {
        playstackIntegration: { node: '>=20', eslint: '^9.0.0' },
        scaffoldPackages: {},
      },
    );
    await json(
      join(root, 'node_modules', '@megamono', 'plugin', 'availability.json'),
      {
        version: 1,
        generators: {
          app: { status: 'available' },
          'docs-spec': { status: 'available' },
          'integration-sentry': {
            status: 'gated',
            gate: 'The Sentry integration fixture contract has not passed.',
          },
          'integration-postmark': {
            status: 'reserved',
            gate: 'Postmark integration generation is reserved for a later wave.',
          },
        },
      },
    );
  }
  return root;
}

function io(
  cwd: string,
  responder?: (invocation: Invocation) => CommandResult,
  selectedPlaystackPackages?: readonly string[],
  selectedAppType?: string,
  confirmedAddPlan?: boolean,
  databaseSelection?: {
    readonly name: string;
    readonly adapter: string;
  },
  mutationState: WorkspaceMutationState = {
    available: true,
    clean: true,
    branch: 'feat/add-capability',
    defaultBranch: 'main',
  },
  selectedPlaystackSurfaces?: Readonly<Partial<Record<'web' | 'api', string>>>,
  selectedWebStyling?: string,
): {
  readonly value: MegamonoCliIo;
  readonly invocations: Invocation[];
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const invocations: Invocation[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    invocations,
    stdout,
    stderr,
    value: {
      cwd,
      version: '0.0.1-test',
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      workspaceMutationState: async () => mutationState,
      activeToolchainState: async () => ({
        node: 'v22.23.1',
        npm: '11.5.2',
        pnpm: '11.24.0',
        yarn: '4.9.4',
        bun: '1.1.26',
      }),
      ...(selectedPlaystackPackages
        ? {
            selectPlaystackPackages: async () => selectedPlaystackPackages,
          }
        : {}),
      ...(selectedPlaystackSurfaces
        ? {
            selectPlaystackSurface: async (kind: 'web' | 'api') =>
              selectedPlaystackSurfaces[kind] ?? '',
          }
        : {}),
      ...(selectedAppType
        ? { selectAppType: async () => selectedAppType }
        : {}),
      ...(selectedWebStyling
        ? { selectWebStyling: async () => selectedWebStyling }
        : {}),
      ...(databaseSelection
        ? {
            inputDatabaseName: async () => databaseSelection.name,
            selectDatabaseAdapter: async () => databaseSelection.adapter,
          }
        : {}),
      ...(confirmedAddPlan !== undefined
        ? { confirmAddPlan: async () => confirmedAddPlan }
        : {}),
      runCommand: async (command, args, options) => {
        const invocation = {
          ...(options.env ? { env: options.env } : {}),
          command,
          args: [...args],
          cwd: options.cwd,
          capture: options.capture ?? false,
        };
        invocations.push(invocation);
        return responder?.(invocation) ?? { exitCode: 0 };
      },
    },
  };
}

function surfaceGraphResult(
  invocation: Invocation,
  projects: Readonly<
    Record<
      string,
      {
        readonly root: string;
        readonly projectType?: string;
        readonly tags?: readonly string[];
      }
    >
  >,
): CommandResult | undefined {
  const showIndex = invocation.args.indexOf('show');
  if (showIndex === -1) return undefined;
  if (invocation.args[showIndex + 1] === 'projects') {
    return { exitCode: 0, stdout: JSON.stringify(Object.keys(projects)) };
  }
  if (invocation.args[showIndex + 1] === 'project') {
    const project = projects[invocation.args[showIndex + 2] ?? ''];
    return project
      ? { exitCode: 0, stdout: JSON.stringify(project) }
      : { exitCode: 1 };
  }
  return undefined;
}

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((fixture) => rm(fixture, { recursive: true, force: true })),
  );
});

describe('@megamono/cli', () => {
  it('runs artifact diagnostics locally without invoking a package manager or another CLI', async () => {
    const root = await workspace('pnpm');
    const store = join(root, 'store');
    await json(join(store, 'packages/@megamono/plugin/0.0.1/package.json'), {
      name: '@megamono/plugin',
      version: '0.0.1',
    });
    await mkdir(join(store, 'packages/@megamono/plugin/0.0.1/dist'), {
      recursive: true,
    });
    await writeFile(
      join(store, 'packages/@megamono/plugin/0.0.1/dist/index.js'),
      'export {};',
    );
    const runCommand = vi.fn();
    const output: string[] = [];
    const result = await runMegamonoCli(
      [
        'diagnostics',
        'packages',
        '--packages=@megamono/plugin',
        `--yalc-store=${store}`,
        '--json',
      ],
      {
        cwd: root,
        version: '0.0.1',
        stdout: (message) => output.push(message),
        stderr: () => undefined,
        runCommand,
      },
    );
    expect(result.exitCode).toBe(1); // Fixture installation has no emitted files.
    expect(JSON.parse(output[0]).packages[0].locations[0].status).toBe(
      'unreadable',
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['adopt', 'Usage: megamono adopt'],
    ['health', 'Usage: megamono health'],
    ['verify', 'Usage: megamono verify runtime'],
  ])('renders command-specific help for %s', async (topic, usage) => {
    const root = await workspace('npm');
    const harness = io(root);

    const result = await runMegamonoCli(['help', topic], harness.value);

    expect(result.exitCode).toBe(0);
    expect(harness.stdout).toEqual([expect.stringContaining(usage)]);
    expect(harness.invocations).toEqual([]);
  });

  it('logs in through hosted auth and selects a personal or organization account', async () => {
    const harness = io('/not-a-workspace');
    const initial: HostedProfile = {
      user: { id: 'user-1', email: 'developer@megamono.test' },
      account: null,
      accounts: [
        { id: 'personal-1', name: 'Personal', slug: 'personal', role: 'owner' },
        { id: 'commune-1', name: 'Commune', slug: 'commune', role: 'member' },
      ],
    };
    const selected: HostedProfile = {
      ...initial,
      account: { id: 'commune-1', role: 'member' },
    };
    const auth: HostedAuthOperations = {
      login: vi.fn(async () => initial),
      profile: vi.fn(async () => selected),
      logout: vi.fn(async () => undefined),
      switchAccount: vi.fn(async () => selected),
    };

    const result = await runMegamonoCli(
      ['auth', 'login', '--service-url=https://app.megamono.test'],
      {
        ...harness.value,
        hostedAuth: auth,
        selectHostedAccount: async () => 'commune-1',
      },
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(auth.login).toHaveBeenCalledWith('https://app.megamono.test');
    expect(auth.switchAccount).toHaveBeenCalledWith(
      'https://app.megamono.test',
      'commune-1',
    );
    expect(harness.stdout.join('\n')).toContain(
      'Active account: Commune (commune, member).',
    );
    expect(harness.invocations).toEqual([]);
  });

  it('lists accounts and switches by slug without requiring an Nx workspace', async () => {
    const harness = io('/not-a-workspace');
    const initial: HostedProfile = {
      user: { id: 'user-1', email: 'developer@megamono.test' },
      account: { id: 'personal-1', role: 'owner' },
      accounts: [
        { id: 'personal-1', name: 'Personal', slug: 'personal', role: 'owner' },
        { id: 'commune-1', name: 'Commune', slug: 'commune', role: 'member' },
      ],
    };
    const auth: HostedAuthOperations = {
      login: vi.fn(async () => initial),
      profile: vi.fn(async () => initial),
      logout: vi.fn(async () => undefined),
      switchAccount: vi.fn(async () => ({
        ...initial,
        account: { id: 'commune-1', role: 'member' },
      })),
    };
    const value = { ...harness.value, hostedAuth: auth };

    await expect(runMegamonoCli(['account', 'list'], value)).resolves.toEqual({
      exitCode: 0,
    });
    await expect(
      runMegamonoCli(['account', 'use', 'commune'], value),
    ).resolves.toEqual({ exitCode: 0 });

    expect(harness.stdout.join('\n')).toContain(
      '* Personal (personal) — owner',
    );
    expect(auth.switchAccount).toHaveBeenCalledWith(
      'https://app.megamono.com',
      'commune-1',
    );
  });

  it('reports hosted status cleanly when no credentials are stored', async () => {
    const harness = io('/not-a-workspace');
    const auth: HostedAuthOperations = {
      login: vi.fn(),
      profile: vi.fn(async () => null),
      logout: vi.fn(async () => undefined),
      switchAccount: vi.fn(),
    };

    await expect(
      runMegamonoCli(['auth', 'status'], {
        ...harness.value,
        hostedAuth: auth,
      }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(harness.stdout).toEqual([
      'Not signed in to https://app.megamono.com.',
    ]);
  });

  it('shows database help without resolving a name, adapter, or workspace', async () => {
    const harness = io('/missing-workspace');

    await expect(
      runMegamonoCli(['add', 'database', '--help'], harness.value),
    ).resolves.toEqual({ exitCode: 0 });
    expect(harness.stdout.join('\n')).toContain(
      'Usage: megamono add database [name] [options]',
    );
    expect(harness.stdout.join('\n')).toContain('--adapter=prisma|drizzle');
    expect(harness.invocations).toEqual([]);
    expect(harness.stderr).toEqual([]);
  });

  it('rejects the active runtime and package manager before invoking Nx', async () => {
    const root = await workspace('pnpm');
    await json(join(root, 'package.json'), {
      name: 'fixture',
      private: true,
      packageManager: 'pnpm@11.24.0',
      devDependencies: { nx: '0.0.1', '@megamono/plugin': '0.0.1' },
    });
    const harness = io(root);
    const nodeResult = await runMegamonoCli(['init', '--only=agents'], {
      ...harness.value,
      activeToolchainState: async () => ({
        node: 'v26.5.0',
        pnpm: '6.18.0',
      }),
    });
    expect(nodeResult.exitCode).toBe(3);
    expect(harness.stderr.join('\n')).toContain('Node.js v26.5.0');
    expect(harness.invocations).toEqual([]);

    const managerResult = await runMegamonoCli(['init', '--only=agents'], {
      ...harness.value,
      activeToolchainState: async () => ({
        node: 'v22.23.1',
        pnpm: '6.18.0',
      }),
    });
    expect(managerResult.exitCode).toBe(3);
    expect(harness.stderr.join('\n')).toContain('pnpm 6.18.0');
    expect(harness.invocations).toEqual([]);
  });

  it('rejects an active package-manager major that differs from the workspace pin', async () => {
    const root = await workspace('pnpm');
    const manifest = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    );
    await json(join(root, 'package.json'), {
      ...manifest,
      packageManager: 'pnpm@11.24.0',
    });
    const harness = io(root);
    const result = await runMegamonoCli(['init', '--only=agents'], {
      ...harness.value,
      activeToolchainState: async () => ({ node: 'v22.23.1', pnpm: '10.9.0' }),
    });
    expect(result.exitCode).toBe(3);
    expect(harness.stderr.join('\n')).toContain(
      'does not match the workspace-declared pnpm@11.24.0 major',
    );
    expect(harness.invocations).toEqual([]);
  });

  it('routes module additions through workspace-init', async () => {
    const root = await workspace('pnpm');
    const harness = io(root);

    expect(
      (await runMegamonoCli(['add', 'docs', '--dry-run'], harness.value))
        .exitCode,
    ).toBe(0);
    expect(harness.invocations).toEqual([
      {
        command: process.execPath,
        args: [
          expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
          'generate',
          '@megamono/plugin:workspace-init',
          '--only=docs',
          '--dry-run',
        ],
        cwd: root,
        capture: false,
      },
    ]);
  });

  it.each(['--dry-run', '--dry-run=true', '--dryRun', '--dryRun=true'])(
    'delegates integration planning via %s without requiring yes',
    async (planningFlag) => {
      const root = await workspace('pnpm');
      const harness = io(root);

      const result = await runMegamonoCli(
        [
          'add',
          'integration',
          '--packages=@playstack/rate-limit',
          '--api=apps/api',
          planningFlag,
        ],
        harness.value,
      );

      expect(result.exitCode).toBe(0);
      expect(harness.invocations[0]?.args).toEqual([
        expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
        'generate',
        '@megamono/plugin:playstack-integrate',
        '--packages=@playstack/rate-limit',
        '--api=apps/api',
        planningFlag,
        '--planOnly=true',
      ]);
    },
  );

  it.each(['npm', 'pnpm', 'yarn', 'bun'] as const)(
    'uses installed Node/Nx for a %s workspace dry run',
    async (manager) => {
      const root = await workspace(manager);
      const harness = io(root);
      const result = await runMegamonoCli(
        ['add', 'docs', '--dry-run'],
        harness.value,
      );
      expect(result.exitCode).toBe(0);
      expect(harness.invocations[0]).toMatchObject({
        command: process.execPath,
        args: expect.arrayContaining([
          expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
          'generate',
          '@megamono/plugin:workspace-init',
        ]),
      });
    },
  );

  it('fails diagnostics without repairing a missing installed executable', async () => {
    const root = await workspace('pnpm');
    await rm(join(root, 'node_modules/nx/bin/cli.js'));
    const harness = io(root);
    expect((await runMegamonoCli(['health'], harness.value)).exitCode).toBe(3);
    expect(harness.invocations).toEqual([]);
    expect(harness.stderr.join('\n')).toContain('diagnostics never install');
  });

  it('delegates an explicit application through the canonical generator', async () => {
    const root = await workspace('pnpm', [
      'nx',
      '@megamono/plugin',
      '@nx/next',
      '@nx/playwright',
      '@nx/js',
      '@nx/eslint',
    ]);
    const harness = io(root);

    const result = await runMegamonoCli(
      ['add', 'app', 'web', '--name=admin', '--interactive=false', '--yes'],
      harness.value,
    );
    expect(result.exitCode).toBe(0);
    expect(harness.invocations).toEqual([
      {
        command: 'pnpm',
        args: [
          'exec',
          'nx',
          'generate',
          '@megamono/plugin:app',
          '--type=web',
          '--name=admin',
          '--interactive=false',
          '--yes',
        ],
        cwd: root,
        capture: false,
      },
    ]);
  });

  it('delegates arbitrary database names and adapters', async () => {
    const root = await workspace('pnpm');
    const explicit = io(root);
    expect(
      (
        await runMegamonoCli(
          [
            'add',
            'database',
            'events',
            '--adapter=drizzle',
            '--interactive=false',
            '--yes',
          ],
          explicit.value,
        )
      ).exitCode,
    ).toBe(0);
    expect(explicit.invocations).toEqual([
      {
        command: 'pnpm',
        args: [
          'exec',
          'nx',
          'generate',
          '@megamono/plugin:database',
          '--name=events',
          '--adapter=drizzle',
          '--interactive=false',
          '--yes',
        ],
        cwd: root,
        capture: false,
      },
    ]);

    const prompted = io(root, undefined, undefined, undefined, undefined, {
      name: 'identity',
      adapter: 'prisma',
    });
    expect(
      (await runMegamonoCli(['add', 'database'], prompted.value)).exitCode,
    ).toBe(0);
    expect(prompted.invocations[0]?.args).toContain('--name=identity');
    expect(prompted.invocations[0]?.args).toContain('--adapter=prisma');
  });

  it('installs missing Nx adapters at the workspace Nx version', async () => {
    const root = await workspace('npm');
    const harness = io(root);
    const result = await runMegamonoCli(
      ['add', 'app', 'api', '--interactive=false', '--yes'],
      harness.value,
    );
    expect(result.exitCode).toBe(0);
    expect(harness.invocations[0]).toMatchObject({
      command: 'npm',
      args: [
        'install',
        '--save-dev',
        '@nx/nest@0.0.1',
        '@nx/jest@0.0.1',
        '@nx/eslint@0.0.1',
      ],
    });
    expect(harness.invocations[1]).toMatchObject({
      command: 'npm',
      args: [
        'exec',
        'nx',
        '--',
        'generate',
        '@megamono/plugin:app',
        '--type=api',
        '--interactive=false',
        '--yes',
      ],
    });
  });

  it('previews missing adapters without installation', async () => {
    const root = await workspace('pnpm');
    const harness = io(root);
    expect(
      (await runMegamonoCli(['add', 'app', 'web', '--dry-run'], harness.value))
        .exitCode,
    ).toBe(0);
    expect(harness.stdout[0]).toContain(
      '@nx/next, @nx/playwright, @nx/js, @nx/eslint',
    );
    expect(harness.invocations).toHaveLength(1);
    expect(harness.invocations[0].args).toContain('@megamono/plugin:app');
  });

  it('selects and confirms an application interactively', async () => {
    const root = await workspace('pnpm', [
      'nx',
      '@megamono/plugin',
      '@nx/nest',
      '@nx/jest',
      '@nx/eslint',
    ]);
    const harness = io(root, undefined, undefined, 'api', true);
    expect((await runMegamonoCli(['add', 'app'], harness.value)).exitCode).toBe(
      0,
    );
    expect(harness.invocations[0].args).toEqual([
      'exec',
      'nx',
      'generate',
      '@megamono/plugin:app',
      '--type=api',
      '--yes',
    ]);
  });

  it('selects web styling before confirming the application plan', async () => {
    const root = await workspace('pnpm', [
      'nx',
      '@megamono/plugin',
      '@nx/next',
      '@nx/playwright',
      '@nx/js',
      '@nx/eslint',
    ]);
    const harness = io(
      root,
      undefined,
      undefined,
      'web',
      true,
      undefined,
      undefined,
      undefined,
      'stylex',
    );
    expect((await runMegamonoCli(['add', 'app'], harness.value)).exitCode).toBe(
      0,
    );
    expect(harness.invocations[0].args).toContain('--styling=stylex');
  });

  it('refuses app and database mutations from an unsafe Git state', async () => {
    const root = await workspace('pnpm');
    const dirty = io(
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        available: true,
        clean: false,
        branch: 'feat/dirty',
        defaultBranch: 'main',
      },
    );

    expect(
      (
        await runMegamonoCli(
          ['add', 'app', 'api', '--interactive=false', '--yes'],
          dirty.value,
        )
      ).exitCode,
    ).toBe(3);
    expect(dirty.invocations).toEqual([]);
    expect(dirty.stderr.at(-1)).toContain('clean working tree');

    const defaultBranch = io(
      root,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        available: true,
        clean: true,
        branch: 'main',
        defaultBranch: 'main',
      },
    );
    expect(
      (
        await runMegamonoCli(
          [
            'add',
            'database',
            'events',
            '--adapter=drizzle',
            '--interactive=false',
            '--yes',
          ],
          defaultBranch.value,
        )
      ).exitCode,
    ).toBe(3);
    expect(defaultBranch.invocations).toEqual([]);
    expect(defaultBranch.stderr.at(-1)).toContain('default branch main');
  });

  it('reports durable recovery after delegated add failures', async () => {
    const root = await workspace('npm');
    const app = io(root, (invocation) => ({
      exitCode: invocation.args.includes('@megamono/plugin:app') ? 4 : 0,
    }));
    expect(
      (
        await runMegamonoCli(
          ['add', 'app', 'api', '--interactive=false', '--yes'],
          app.value,
        )
      ).exitCode,
    ).toBe(4);
    expect(app.stderr.at(-1)).toContain(
      'Dependencies already installed: @nx/nest, @nx/jest, @nx/eslint',
    );
    expect(app.stderr.at(-1)).toContain('Inspect git diff');

    const database = io(root, (invocation) => ({
      exitCode: invocation.args.includes('@megamono/plugin:database') ? 4 : 0,
    }));
    expect(
      (
        await runMegamonoCli(
          [
            'add',
            'database',
            'events',
            '--adapter=drizzle',
            '--interactive=false',
            '--yes',
          ],
          database.value,
        )
      ).exitCode,
    ).toBe(4);
    expect(database.stderr.at(-1)).toContain(
      'Inspect git diff for partial files',
    );
  });

  it('delegates available generators and diagnoses gated names', async () => {
    const root = await workspace('pnpm');
    const harness = io(root);

    expect(
      (
        await runMegamonoCli(
          ['generate', 'docs-spec', 'workspace', '--title=Contract'],
          harness.value,
        )
      ).exitCode,
    ).toBe(0);
    expect(harness.invocations[0]).toMatchObject({
      command: 'pnpm',
      args: [
        'exec',
        'nx',
        'generate',
        '@megamono/plugin:docs-spec',
        'workspace',
        '--title=Contract',
      ],
    });

    const gated = await runMegamonoCli(
      ['generate', 'integration-sentry'],
      harness.value,
    );
    expect(gated.exitCode).toBe(3);
    expect(harness.stderr.at(-1)).toBe(
      'Generator integration-sentry is gated: The Sentry integration fixture contract has not passed.',
    );
    expect(harness.invocations).toHaveLength(1);
  });

  it('diagnoses reserved and unknown generators before Nx delegation', async () => {
    const root = await workspace('npm');
    const harness = io(root);

    expect(
      (
        await runMegamonoCli(
          ['generate', 'integration-postmark'],
          harness.value,
        )
      ).exitCode,
    ).toBe(3);
    expect(harness.stderr.at(-1)).toContain(
      'Generator integration-postmark is reserved:',
    );
    expect(
      (await runMegamonoCli(['generate', 'made-up'], harness.value)).exitCode,
    ).toBe(3);
    expect(harness.stderr.at(-1)).toBe(
      'Generator made-up is reserved: No canonical Megamono generator uses this name.',
    );
    expect(harness.invocations).toEqual([]);
  });

  it('delegates read-only survey through the workspace-local Nx binary', async () => {
    const root = await workspace('pnpm');
    const harness = io(join(root, 'apps', 'web'));
    await mkdir(harness.value.cwd, { recursive: true });

    const result = await runMegamonoCli(
      ['init', '--survey', '--only=docs,agents'],
      harness.value,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.invocations).toEqual([
      {
        command: process.execPath,
        args: [
          expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
          'generate',
          '@megamono/plugin:workspace-init',
          '--survey',
          '--only=docs,agents',
        ],
        cwd: root,
        capture: false,
      },
    ]);
  });

  it.each([true, false])(
    'keeps survey stdout pure JSON (installed plugin: %s)',
    async (installed) => {
      const root = await workspace(
        'npm',
        installed ? ['nx', '@megamono/plugin'] : ['nx'],
      );
      const survey = {
        schemaVersion: 1,
        baseline: {},
        inventory: {},
        projects: [],
        recommendations: [],
        note: 'braces { and escaped "quotes" }',
      };
      const harness = io(root, ({ args }) =>
        args.includes('generate')
          ? {
              exitCode: 0,
              stdout: `NX Generating\n${JSON.stringify(survey, null, 2)}\nNOTE: dry run`,
              stderr: 'Nx warning',
            }
          : { exitCode: 0, stdout: 'npm installed packages' },
      );
      const result = await runMegamonoCli(
        ['adopt', '--format=json'],
        harness.value,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(harness.stdout.join('\n'))).toEqual(survey);
      expect(harness.stderr.join('\n')).toContain('NX Generating');
      expect(harness.stderr.join('\n')).toContain('Nx warning');
      if (!installed)
        expect(harness.stderr.join('\n')).toContain('npm installed packages');
      expect(harness.invocations.every(({ capture }) => capture)).toBe(true);
    },
  );

  it.each([
    { exitCode: 7, stdout: 'NX graph failed' },
    { exitCode: 0, stdout: '{"unrelated":true}' },
    { exitCode: 0, stdout: '{"schemaVersion":1' },
  ])(
    'fails closed without JSON stdout for an unsuccessful survey: %j',
    async (response) => {
      const root = await workspace('npm');
      const harness = io(root, () => response);
      const result = await runMegamonoCli(
        ['adopt', '--format', 'json'],
        harness.value,
      );
      expect(result.exitCode).toBe(response.exitCode || 3);
      expect(harness.stdout).toEqual([]);
      expect(harness.stderr.join('\n')).toContain(response.stdout);
      expect(JSON.parse(harness.stderr.at(-1) ?? '{}')).toMatchObject({
        schemaVersion: 1,
        type: 'megamono.survey.error',
        code: response.exitCode
          ? 'survey-command-failed'
          : 'survey-output-invalid',
        exitCode: response.exitCode || 3,
      });
    },
  );

  it.each([0, 7])(
    'uses a completed private handoff and removes it even on exit %s',
    async (exitCode) => {
      const root = await workspace('npm');
      const survey = {
        schemaVersion: 1,
        baseline: {},
        inventory: {},
        projects: [],
        recommendations: [],
        large: 'é'.repeat(100_000),
      };
      let file = '';
      const harness = io(root, ({ env }) => {
        file = env?.MEGAMONO_SURVEY_OUTPUT_FILE ?? '';
        writeFileSync(file, JSON.stringify(survey), { flag: 'wx' });
        return { exitCode, stdout: 'NX banner and truncated logger output' };
      });
      const result = await runMegamonoCli(
        ['adopt', '--format=json'],
        harness.value,
      );
      expect(result.exitCode).toBe(exitCode);
      if (!exitCode)
        expect(JSON.parse(harness.stdout.join('\n'))).toEqual(survey);
      else expect(harness.stdout).toEqual([]);
      expect(existsSync(file)).toBe(false);
    },
  );

  it('reports staging and preflight failures without a success-shaped stdout payload', async () => {
    for (const packages of [['nx'], []]) {
      const root = await workspace('npm', packages);
      const harness = io(root, () => ({
        exitCode: 1,
        stdout: 'npm install failed',
      }));
      expect(
        (
          await runMegamonoCli(
            [
              'adopt',
              '--format=json',
              ...(packages.length ? [] : ['--local-packages=invalid']),
            ],
            harness.value,
          )
        ).exitCode,
      ).toBe(packages.length ? 3 : 2);
      expect(harness.stdout).toEqual([]);
      expect(JSON.parse(harness.stderr.at(-1) ?? '{}')).toMatchObject({
        type: 'megamono.survey.error',
        code: packages.length
          ? 'survey-staging-failed'
          : 'survey-preflight-failed',
      });
    }
  });

  it('stages a missing survey plugin outside the repository', async () => {
    const root = await workspace('pnpm', ['nx']);
    await json(join(root, 'node_modules/nx/package.json'), {
      name: 'nx',
      version: '23.1.1',
      bin: { nx: './dist/bin/nx.js' },
    });
    await mkdir(join(root, 'node_modules/nx/dist/bin'), { recursive: true });
    await writeFile(
      join(root, 'node_modules/nx/dist/bin/nx.js'),
      '// fixture executable',
    );
    const harness = io(root);

    const result = await runMegamonoCli(
      ['adopt', '--only=health,inference'],
      harness.value,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.invocations).toHaveLength(2);
    expect(harness.invocations[0]).toMatchObject({
      command: process.execPath,
      args: expect.arrayContaining([
        expect.stringMatching(/npm\/bin\/npm-cli\.js$/),
        'install',
        'nx@23.1.1',
        '@megamono/plugin@0.0.1-test',
      ]),
    });
    expect(harness.invocations[0]?.cwd).not.toBe(root);
    expect(harness.invocations[1]).toMatchObject({
      command: process.execPath,
      args: expect.arrayContaining([
        'generate',
        expect.stringMatching(
          /megamono-survey-.*\/node_modules\/@megamono\/plugin\/generators.json:workspace-init$/,
        ),
        '--survey=true',
        '--only=health,inference',
      ]),
      cwd: root,
    });
    expect(harness.invocations[1]?.args[0]).toMatch(
      /node_modules\/nx\/dist\/bin\/nx.js$/,
    );
    expect(harness.invocations[1]?.args).toEqual(
      expect.arrayContaining(['--dry-run', '--survey=true']),
    );
    expect(harness.invocations[1]?.env).toEqual({
      NX_DAEMON: 'false',
      NX_CACHE_DIRECTORY: join(harness.invocations[0].cwd, 'nx-cache'),
      NX_WORKSPACE_DATA_DIRECTORY: join(harness.invocations[0].cwd, 'nx-data'),
    });
  });

  it('copies survey artifacts without registering or changing the Yalc store or repository', async () => {
    const root = await workspace('npm', ['nx']);
    const store = await mkdtemp(join(tmpdir(), 'megamono-survey-store-'));
    fixtures.push(store);
    const artifact = join(store, 'packages/@megamono/plugin/0.0.1');
    await json(join(artifact, 'package.json'), {
      name: '@megamono/plugin',
      version: '0.0.1',
    });
    await json(join(store, 'installations.json'), { sentinel: ['unchanged'] });
    const before = await readFile(join(root, 'package.json'), 'utf8');
    let staged = '';
    const harness = io(root, (invocation) => {
      if (invocation.command === 'yalc') {
        expect(invocation.args).toEqual(['dir']);
        return { exitCode: 0, stdout: store };
      }
      if (invocation.args.includes('install')) {
        staged = invocation.cwd;
        expect(
          JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'))
            .devDependencies,
        ).toEqual({ '@megamono/plugin': 'file:./plugin' });
        expect(readFileSync(join(staged, 'plugin/package.json'), 'utf8')).toBe(
          readFileSync(join(artifact, 'package.json'), 'utf8'),
        );
      }
      return { exitCode: 0 };
    });

    const result = await runMegamonoCli(
      ['adopt', '--local-packages=yalc'],
      harness.value,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.invocations.map(({ command }) => command)).toEqual([
      'yalc',
      process.execPath,
      process.execPath,
    ]);
    expect(harness.invocations[0]?.args).toEqual(['dir']);
    expect(harness.invocations[1]?.args).not.toContain(
      '@megamono/plugin@0.0.1-test',
    );
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(before);
    expect(
      JSON.parse(await readFile(join(store, 'installations.json'), 'utf8')),
    ).toEqual({ sentinel: ['unchanged'] });
    await expect(readFile(join(staged, 'package.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(root, 'yalc.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports missing Yalc survey artifacts before installing a runtime', async () => {
    const root = await workspace('npm', ['nx']);
    const harness = io(root, () => ({
      exitCode: 0,
      stdout: join(root, 'missing-store'),
    }));
    await expect(
      runMegamonoCli(['adopt', '--local-packages=yalc'], harness.value),
    ).resolves.toEqual({ exitCode: 3 });
    expect(harness.stderr.join('\n')).toContain(
      'store has no @megamono/plugin',
    );
    expect(harness.invocations).toHaveLength(1);
  });

  it('distinguishes unreadable Yalc inventory from a missing publication', async () => {
    const root = await workspace('npm', ['nx']);
    const store = join(root, 'not-a-directory');
    await writeFile(store, 'fixture');
    const harness = io(root, () => ({ exitCode: 0, stdout: store }));
    expect(
      await runMegamonoCli(['adopt', '--local-packages=yalc'], harness.value),
    ).toEqual({ exitCode: 3 });
    expect(harness.stderr.join('\n')).toContain(
      'Unable to read the yalc store',
    );
    expect(harness.stderr.join('\n')).not.toContain(
      'Publish a compatible package',
    );
    expect(harness.invocations).toHaveLength(1);
  });

  it('defaults adopt to a read-only survey and requires write for mutation', async () => {
    const root = await workspace('pnpm');
    const surveyed = io(root);

    expect((await runMegamonoCli(['adopt'], surveyed.value)).exitCode).toBe(0);
    expect(surveyed.invocations[0]?.args).toEqual(
      expect.arrayContaining(['@megamono/plugin:workspace-init', '--survey']),
    );

    const written = io(root);
    expect(
      (
        await runMegamonoCli(
          ['adopt', '--only=health', '--write', '--yes'],
          written.value,
        )
      ).exitCode,
    ).toBe(0);
    expect(written.invocations[0]?.args).toEqual(
      expect.arrayContaining([
        '@megamono/plugin:workspace-init',
        '--only=health',
        '--yes',
      ]),
    );
    expect(written.invocations[0]?.args).not.toContain('--survey');
    expect(written.invocations[0]?.args).not.toContain('--write');
  });

  it('runs composable health and portability targets through local Nx', async () => {
    const root = await workspace('pnpm');
    const harness = io(root);

    expect(
      (await runMegamonoCli(['health', '--profile=migration'], harness.value))
        .exitCode,
    ).toBe(0);
    expect(
      (
        await runMegamonoCli(
          [
            'verify',
            'runtime',
            'api',
            '--outputPath=dist/apps/api',
            '--webpackEvidence=.megamono/api-webpack-evidence.json',
          ],
          harness.value,
        )
      ).exitCode,
    ).toBe(0);
    expect(
      (await runMegamonoCli(['verify', 'dependencies'], harness.value))
        .exitCode,
    ).toBe(0);
    expect(
      (
        await runMegamonoCli(
          ['verify', 'container', '--dockerfile=apps/api/Dockerfile'],
          harness.value,
        )
      ).exitCode,
    ).toBe(0);

    expect(harness.invocations.map(({ args }) => args)).toEqual([
      [
        expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
        'run',
        'megamono:check',
        '--profile=migration',
      ],
      [
        expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
        'run',
        'megamono:verify-runtime',
        '--project=api',
        '--outputPath=dist/apps/api',
        '--webpackEvidence=.megamono/api-webpack-evidence.json',
      ],
      [
        expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
        'run',
        'megamono:verify-dependencies',
      ],
      [
        expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
        'run',
        'megamono:verify-container',
        '--dockerfile=apps/api/Dockerfile',
      ],
    ]);
  });

  it('forwards a named adoption profile to the workspace-local plugin', async () => {
    const root = await workspace('pnpm');
    const harness = io(root);

    const result = await runMegamonoCli(
      ['init', '--profile=pilot', '--dry-run'],
      harness.value,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.invocations[0]).toMatchObject({
      command: process.execPath,
      args: [
        expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
        'generate',
        '@megamono/plugin:workspace-init',
        '--profile=pilot',
        '--dry-run',
      ],
    });
  });

  it('uses the npm command family and propagates delegated failures', async () => {
    const root = await workspace('npm');
    const harness = io(root, () => ({ exitCode: 4 }));

    const result = await runMegamonoCli(
      ['init', '--interactive=false', '--yes'],
      harness.value,
    );

    expect(result.exitCode).toBe(4);
    expect(harness.invocations[0]).toMatchObject({
      command: 'npm',
      args: [
        'exec',
        'nx',
        '--',
        'generate',
        '@megamono/plugin:workspace-init',
        '--interactive=false',
        '--yes',
      ],
    });
  });

  it('delegates requested Playstack capabilities to yalc-aware Playstack after Megamono init', async () => {
    const root = await workspace('pnpm');
    const store = await mkdtemp(join(tmpdir(), 'megamono-cli-yalc-'));
    fixtures.push(store);
    for (const packageName of ['@playstack/cli']) {
      await json(
        join(
          store,
          'packages',
          ...packageName.split('/'),
          '0.1.0',
          'package.json',
        ),
        { name: packageName, version: '0.1.0' },
      );
    }
    const projects = {
      web: {
        root: 'apps/web',
        projectType: 'application',
        tags: ['platform:web', 'type:app'],
      },
      api: {
        root: 'apps/api',
        projectType: 'application',
        tags: ['platform:node', 'type:app'],
      },
    } as const;
    const harness = io(root, (invocation) => {
      if (invocation.command === 'yalc' && invocation.args[0] === 'dir') {
        return { exitCode: 0, stdout: store };
      }
      return surfaceGraphResult(invocation, projects) ?? { exitCode: 0 };
    });

    const result = await runMegamonoCli(
      [
        'init',
        '--playstack-packages=auth',
        '--local-packages=yalc',
        '--only=docs',
      ],
      harness.value,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.invocations).toEqual([
      {
        command: 'yalc',
        args: ['dir'],
        cwd: root,
        capture: true,
      },
      {
        command: 'pnpm',
        args: [
          'exec',
          'nx',
          'generate',
          '@megamono/plugin:workspace-init',
          '--only=docs',
          '--localPackages=yalc',
        ],
        cwd: root,
        capture: false,
      },
      {
        command: process.execPath,
        args: [
          expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
          'show',
          'projects',
          '--json',
        ],
        cwd: root,
        capture: true,
      },
      {
        command: process.execPath,
        args: [
          expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
          'show',
          'project',
          'api',
          '--json',
        ],
        cwd: root,
        capture: true,
      },
      {
        command: process.execPath,
        args: [
          expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
          'show',
          'project',
          'web',
          '--json',
        ],
        cwd: root,
        capture: true,
      },
      {
        command: 'yalc',
        args: ['add', '@playstack/cli', '--dev', '--no-pure'],
        cwd: root,
        capture: false,
      },
      {
        command: 'pnpm',
        args: ['install'],
        cwd: root,
        capture: false,
      },
      {
        command: 'pnpm',
        args: [
          'exec',
          'playstack',
          'add',
          'auth',
          '--yes',
          '--web=apps/web',
          '--api=apps/api',
          '--local-packages=yalc',
        ],
        cwd: root,
        capture: false,
      },
      {
        command: 'pnpm',
        args: ['exec', 'playstack', 'init'],
        cwd: root,
        capture: false,
      },
    ]);
  });

  it('keeps a combined Playstack survey write-free when its CLI is absent', async () => {
    const root = await workspace('pnpm');
    const harness = io(root);

    const result = await runMegamonoCli(
      ['init', '--survey', '--playstack'],
      harness.value,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.invocations).toHaveLength(1);
    expect(harness.invocations[0]?.args).toContain('--survey');
    expect(harness.stdout.join('\n')).toContain('Playstack survey deferred');
  });

  it('keeps combined Playstack dry runs package- and file-mutation free', async () => {
    const root = await workspace('pnpm', [
      'nx',
      '@megamono/plugin',
      '@playstack/cli',
    ]);
    const projects = {
      site: {
        root: 'apps/site',
        projectType: 'application',
        tags: ['platform:web', 'type:app'],
      },
    } as const;
    const harness = io(
      root,
      (invocation) =>
        surfaceGraphResult(invocation, projects) ?? { exitCode: 0 },
    );

    const result = await runMegamonoCli(
      ['init', '--dry-run', '--playstack-packages=content', '--only=agents'],
      harness.value,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.stdout.join('\n')).toContain(
      'Playstack dry run: no packages will be installed',
    );
    expect(
      harness.invocations.some(
        ({ command, args }) =>
          command === 'yalc' ||
          (command === 'pnpm' && ['add', 'install'].includes(args[0] ?? '')),
      ),
    ).toBe(false);
    expect(
      harness.invocations.find(
        ({ args }) =>
          args.some((arg) => arg.includes('playstack')) && args.includes('add'),
      )?.args,
    ).toEqual(
      expect.arrayContaining([
        'content',
        '--yes',
        '--dry-run',
        '--web=apps/site',
      ]),
    );
    expect(harness.invocations.at(-1)?.args).toEqual([
      expect.stringMatching(/node_modules\/@playstack\/cli\/bin\/cli\.js$/),
      'init',
      '--survey',
    ]);
  });

  it('applies Playstack compatibility without narrowing core init', async () => {
    const root = await workspace('pnpm');
    const manifestPath = join(root, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await json(manifestPath, {
      ...manifest,
      engines: { node: '>=18.18 <25' },
    });
    const core = io(root);
    expect(
      (await runMegamonoCli(['init', '--survey'], core.value)).exitCode,
    ).toBe(0);

    const playstack = io(root);
    expect(
      (
        await runMegamonoCli(
          ['init', '--survey', '--playstack'],
          playstack.value,
        )
      ).exitCode,
    ).toBe(3);
    expect(playstack.invocations).toEqual([]);
    expect(playstack.stderr.at(-1)).toContain(
      'Playstack packages require Node >=20',
    );
  });

  it('checks the ESLint peer only for an explicit Playstack lint package', async () => {
    const root = await workspace('npm');
    const manifestPath = join(root, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await json(manifestPath, {
      ...manifest,
      engines: { node: '>=20 <25' },
      devDependencies: { ...manifest.devDependencies, eslint: '^8.57.0' },
    });
    const harness = io(root);
    expect(
      (
        await runMegamonoCli(
          ['init', '--playstack-packages=@playstack/lint'],
          harness.value,
        )
      ).exitCode,
    ).toBe(3);
    expect(harness.invocations).toEqual([]);
    expect(harness.stderr.at(-1)).toContain(
      'Playstack lint requires ESLint ^9.0.0',
    );
  });

  it.each(['^9.39.0', '^10.0.0', '>=9 <11', '^11.0.0', '>=9', 'latest'])(
    'uses the plugin ESLint range for CLI preflight: %s',
    async (eslint) => {
      const root = await workspace('npm');
      await json(
        join(root, 'node_modules/@megamono/plugin/compatibility.json'),
        { playstackIntegration: { node: '>=20', eslint: '>=9 <11' } },
      );
      const manifest = JSON.parse(
        await readFile(join(root, 'package.json'), 'utf8'),
      );
      await json(join(root, 'package.json'), {
        ...manifest,
        engines: { node: '>=24 <25' },
        devDependencies: { ...manifest.devDependencies, eslint },
      });
      const harness = io(root);
      await runMegamonoCli(
        ['init', '--playstack-packages=@playstack/lint'],
        harness.value,
      );
      const supported = ['^9.39.0', '^10.0.0', '>=9 <11'].includes(eslint);
      expect(
        harness.stderr.some((message) =>
          message.includes('Playstack lint requires ESLint'),
        ),
      ).toBe(!supported);
      if (!supported) expect(harness.invocations).toEqual([]);
    },
  );

  it('prompts for capabilities when playstack-packages has no value', async () => {
    const root = await workspace('npm');
    const projects = {
      storefront: {
        root: 'apps/storefront',
        projectType: 'application',
        tags: ['platform:web', 'type:app'],
      },
      gateway: {
        root: 'apps/gateway',
        projectType: 'application',
        tags: ['platform:node', 'type:app'],
      },
    } as const;
    const harness = io(
      root,
      (invocation) =>
        surfaceGraphResult(invocation, projects) ?? { exitCode: 0 },
      ['auth', 'billing'],
    );

    const result = await runMegamonoCli(
      ['init', '--playstack-packages'],
      harness.value,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.invocations).toEqual([
      {
        command: 'npm',
        args: [
          'exec',
          'nx',
          '--',
          'generate',
          '@megamono/plugin:workspace-init',
        ],
        cwd: root,
        capture: false,
      },
      {
        command: process.execPath,
        args: [
          expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
          'show',
          'projects',
          '--json',
        ],
        cwd: root,
        capture: true,
      },
      {
        command: process.execPath,
        args: [
          expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
          'show',
          'project',
          'gateway',
          '--json',
        ],
        cwd: root,
        capture: true,
      },
      {
        command: process.execPath,
        args: [
          expect.stringMatching(/node_modules\/nx\/bin\/cli\.js$/),
          'show',
          'project',
          'storefront',
          '--json',
        ],
        cwd: root,
        capture: true,
      },
      {
        command: 'npm',
        args: ['install', '--save-dev', '@playstack/cli'],
        cwd: root,
        capture: false,
      },
      {
        command: 'npm',
        args: [
          'exec',
          'playstack',
          '--',
          'add',
          'auth',
          '--yes',
          '--web=apps/storefront',
          '--api=apps/gateway',
        ],
        cwd: root,
        capture: false,
      },
      {
        command: 'npm',
        args: [
          'exec',
          'playstack',
          '--',
          'add',
          'billing',
          '--yes',
          '--web=apps/storefront',
          '--api=apps/gateway',
        ],
        cwd: root,
        capture: false,
      },
      {
        command: 'npm',
        args: ['exec', 'playstack', '--', 'init'],
        cwd: root,
        capture: false,
      },
    ]);
  });

  it('requires an explicit Playstack path for ambiguous automated surfaces', async () => {
    const root = await workspace('pnpm');
    const projects = {
      shop: {
        root: 'apps/shop',
        projectType: 'application',
        tags: ['platform:web', 'type:app'],
      },
      admin: {
        root: 'apps/admin',
        projectType: 'application',
        tags: ['platform:web', 'type:app'],
      },
    } as const;
    const ambiguous = io(
      root,
      (invocation) =>
        surfaceGraphResult(invocation, projects) ?? { exitCode: 0 },
    );

    expect(
      (
        await runMegamonoCli(
          [
            'init',
            '--playstack-packages=content',
            '--interactive=false',
            '--yes',
          ],
          ambiguous.value,
        )
      ).exitCode,
    ).toBe(4);
    expect(ambiguous.stderr.at(-1)).toContain(
      'Pass --playstack-web=<path> in automation',
    );
    expect(
      ambiguous.invocations.some(({ args }) => args.includes('playstack')),
    ).toBe(false);

    const explicit = io(
      root,
      (invocation) =>
        surfaceGraphResult(invocation, projects) ?? { exitCode: 0 },
    );
    expect(
      (
        await runMegamonoCli(
          [
            'init',
            '--playstack-packages=content',
            '--playstack-web=apps/shop',
            '--playstack-api=false',
            '--interactive=false',
            '--yes',
          ],
          explicit.value,
        )
      ).exitCode,
    ).toBe(0);
    const delegated = explicit.invocations.find(({ args }) =>
      args.includes('playstack'),
    );
    expect(delegated?.args).toContain('--web=apps/shop');
    expect(delegated?.args).not.toContain('--api=false');
    expect(explicit.invocations[0]?.args).not.toContain(
      '--playstack-web=apps/shop',
    );
  });

  it('asks which tagged application should receive an ambiguous surface', async () => {
    const root = await workspace('npm');
    const projects = {
      shop: {
        root: 'apps/shop',
        projectType: 'application',
        tags: ['platform:web', 'type:app'],
      },
      admin: {
        root: 'apps/admin',
        projectType: 'application',
        tags: ['platform:web', 'type:app'],
      },
    } as const;
    const harness = io(
      root,
      (invocation) =>
        surfaceGraphResult(invocation, projects) ?? { exitCode: 0 },
    );
    const selections: string[] = [];

    expect(
      (
        await runMegamonoCli(['init', '--playstack-packages=content'], {
          ...harness.value,
          selectPlaystackSurface: async (kind, choices) => {
            selections.push(
              `${kind}:${choices.map(({ root }) => root).join(',')}`,
            );
            return 'apps/admin';
          },
        })
      ).exitCode,
    ).toBe(0);
    expect(selections).toEqual(['web:apps/admin,apps/shop']);
    expect(
      harness.invocations.find(({ args }) => args.includes('playstack'))?.args,
    ).toContain('--web=apps/admin');
  });

  it('refuses a valueless package selector without an interactive prompt', async () => {
    const root = await workspace('pnpm');
    const harness = io(root);

    const result = await runMegamonoCli(
      ['init', '--playstack-packages'],
      harness.value,
    );

    expect(result.exitCode).toBe(2);
    expect(harness.invocations).toEqual([]);
    expect(harness.stderr.join('\n')).toContain('non-interactive');
  });

  it('honors explicit non-interactive mode even when a prompt is available', async () => {
    const root = await workspace('pnpm');
    const harness = io(root, undefined, ['auth']);

    const result = await runMegamonoCli(
      ['init', '--playstack-packages', '--interactive=false'],
      harness.value,
    );

    expect(result.exitCode).toBe(2);
    expect(harness.invocations).toEqual([]);
  });

  it('explains how to install a missing local plugin without mutating', async () => {
    const root = await workspace('pnpm', ['nx']);
    const harness = io(root);

    const result = await runMegamonoCli(['init'], harness.value);

    expect(result.exitCode).toBe(3);
    expect(harness.invocations).toEqual([]);
    expect(harness.stderr.join('\n')).toContain(
      'pnpm add --save-dev @megamono/plugin',
    );
  });

  it('retains explicit package names as a direct-install escape hatch', async () => {
    const root = await workspace('npm');
    const harness = io(root);

    const result = await runMegamonoCli(
      ['init', '--playstack-packages=@playstack/cache'],
      harness.value,
    );

    expect(result.exitCode).toBe(0);
    expect(
      harness.invocations.map(({ command, args }) => [command, args]),
    ).toEqual([
      [
        'npm',
        ['exec', 'nx', '--', 'generate', '@megamono/plugin:workspace-init'],
      ],
      ['npm', ['install', '--save-dev', '@playstack/cli']],
      ['npm', ['install', '@playstack/cache']],
      ['npm', ['exec', 'playstack', '--', 'init']],
    ]);
  });

  it('links the complete direct-package Playstack closure from yalc', async () => {
    const root = await workspace('pnpm');
    const store = await mkdtemp(join(tmpdir(), 'megamono-cli-yalc-closure-'));
    fixtures.push(store);
    const manifests = {
      '@playstack/cli': { name: '@playstack/cli', version: '0.1.0' },
      '@playstack/accounts': {
        name: '@playstack/accounts',
        version: '0.1.0',
        dependencies: {
          '@playstack/auth': '0.1.0',
          '@playstack/core': '0.1.0',
          zod: '^4.0.0',
        },
      },
      '@playstack/auth': {
        name: '@playstack/auth',
        version: '0.1.0',
        dependencies: { '@playstack/core': '0.1.0' },
        peerDependencies: { argon2: '^0.45.0' },
        peerDependenciesMeta: { argon2: { optional: true } },
      },
      '@playstack/core': { name: '@playstack/core', version: '0.1.0' },
    } as const;
    for (const [packageName, manifest] of Object.entries(manifests)) {
      await json(
        join(
          store,
          'packages',
          ...packageName.split('/'),
          manifest.version,
          'package.json',
        ),
        manifest,
      );
      if (packageName !== '@playstack/cli') {
        await json(
          join(root, '.yalc', ...packageName.split('/'), 'package.json'),
          manifest,
        );
      }
    }
    const harness = io(root, (invocation) =>
      invocation.command === 'yalc' && invocation.args[0] === 'dir'
        ? { exitCode: 0, stdout: store }
        : { exitCode: 0 },
    );

    expect(
      (
        await runMegamonoCli(
          [
            'init',
            '--playstack-packages=@playstack/accounts',
            '--local-packages=yalc',
          ],
          harness.value,
        )
      ).exitCode,
    ).toBe(0);
    expect(
      harness.invocations.map(({ command, args }) => [command, args]),
    ).toEqual([
      ['yalc', ['dir']],
      [
        'pnpm',
        [
          'exec',
          'nx',
          'generate',
          '@megamono/plugin:workspace-init',
          '--localPackages=yalc',
        ],
      ],
      ['yalc', ['add', '@playstack/cli', '--dev', '--no-pure']],
      ['pnpm', ['add', 'zod@^4.0.0']],
      [
        'yalc',
        [
          'add',
          '@playstack/accounts@0.1.0',
          '@playstack/auth@0.1.0',
          '@playstack/core@0.1.0',
          '--no-pure',
        ],
      ],
      ['pnpm', ['install']],
      ['pnpm', ['exec', 'playstack', 'init']],
    ]);
    const accounts = JSON.parse(
      await readFile(
        join(root, '.yalc', '@playstack', 'accounts', 'package.json'),
        'utf8',
      ),
    );
    expect(accounts.dependencies).toEqual({
      '@playstack/auth': 'file:../auth',
      '@playstack/core': 'file:../core',
      zod: '^4.0.0',
    });
  });

  it('preflights transitive direct-package yalc artifacts before init', async () => {
    const root = await workspace('npm');
    const store = await mkdtemp(join(tmpdir(), 'megamono-cli-yalc-missing-'));
    fixtures.push(store);
    for (const manifest of [
      { name: '@playstack/cli', version: '0.1.0' },
      {
        name: '@playstack/accounts',
        version: '0.1.0',
        dependencies: { '@playstack/auth': '0.1.0' },
      },
    ]) {
      await json(
        join(
          store,
          'packages',
          ...manifest.name.split('/'),
          manifest.version,
          'package.json',
        ),
        manifest,
      );
    }
    const harness = io(root, (invocation) =>
      invocation.command === 'yalc' && invocation.args[0] === 'dir'
        ? { exitCode: 0, stdout: store }
        : { exitCode: 0 },
    );

    expect(
      (
        await runMegamonoCli(
          [
            'init',
            '--playstack-packages=@playstack/accounts',
            '--local-packages=yalc',
          ],
          harness.value,
        )
      ).exitCode,
    ).toBe(3);
    expect(harness.invocations).toHaveLength(1);
    expect(harness.stderr.at(-1)).toContain(
      'no @playstack/auth version compatible with 0.1.0',
    );
  });

  it('rejects invalid Playstack package names as CLI usage errors', async () => {
    const root = await workspace('pnpm');
    const harness = io(root);

    const result = await runMegamonoCli(
      ['init', '--playstack-packages=@other/left-pad'],
      harness.value,
    );

    expect(result.exitCode).toBe(2);
    expect(harness.invocations).toEqual([]);
  });

  it('prints help and version without requiring a workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-cli-empty-'));
    fixtures.push(root);
    const harness = io(root);

    expect((await runMegamonoCli(['--version'], harness.value)).exitCode).toBe(
      0,
    );
    expect(
      (await runMegamonoCli(['--version', '--json'], harness.value)).exitCode,
    ).toBe(0);
    expect(JSON.parse(harness.stdout.at(-1) ?? '{}')).toMatchObject({
      package: '@megamono/cli',
      version: '0.0.1-test',
      revision: 'development',
      buildId: 'development',
    });
    expect((await runMegamonoCli([], harness.value)).exitCode).toBe(0);
    expect(harness.stdout[0]).toBe('0.0.1-test');
    expect(harness.stdout.at(-1)).toContain('Usage: megamono');
  });
});
