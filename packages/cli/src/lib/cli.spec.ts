import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runMegamonoCli,
  type CommandResult,
  type MegamonoCliIo,
} from './cli.js';

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly capture: boolean;
}

const fixtures: string[] = [];

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function workspace(
  manager: 'npm' | 'pnpm',
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
  await writeFile(
    join(root, manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'),
    manager === 'pnpm' ? 'lockfileVersion: 9\n' : '{"lockfileVersion":3}\n',
  );
  for (const packageName of packages) {
    await json(
      join(root, 'node_modules', ...packageName.split('/'), 'package.json'),
      { name: packageName, version: '0.0.1' },
    );
  }
  if (packages.includes('@megamono/plugin')) {
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
      ...(selectedPlaystackPackages
        ? {
            selectPlaystackPackages: async () => selectedPlaystackPackages,
          }
        : {}),
      ...(selectedAppType
        ? { selectAppType: async () => selectedAppType }
        : {}),
      ...(confirmedAddPlan !== undefined
        ? { confirmAddPlan: async () => confirmedAddPlan }
        : {}),
      runCommand: async (command, args, options) => {
        const invocation = {
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

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((fixture) => rm(fixture, { recursive: true, force: true })),
  );
});

describe('@megamono/cli', () => {
  it('routes module additions through workspace-init', async () => {
    const root = await workspace('pnpm');
    const harness = io(root);

    expect((await runMegamonoCli(['add', 'docs', '--dry-run'], harness.value)).exitCode).toBe(0);
    expect(harness.invocations).toEqual([
      {
        command: 'pnpm',
        args: [
          'exec',
          'nx',
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

  it('delegates an explicit application through the canonical generator', async () => {
    const root = await workspace('pnpm', [
      'nx',
      '@megamono/plugin',
      '@nx/next',
      '@nx/playwright',
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
      args: ['install', '--save-dev', '@nx/nest@0.0.1', '@nx/jest@0.0.1'],
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
      (
        await runMegamonoCli(
          ['add', 'app', 'web', '--dry-run'],
          harness.value,
        )
      ).exitCode,
    ).toBe(0);
    expect(harness.stdout[0]).toContain('@nx/next, @nx/playwright');
    expect(harness.invocations).toHaveLength(1);
    expect(harness.invocations[0].args).toContain('@megamono/plugin:app');
  });

  it('selects and confirms an application interactively', async () => {
    const root = await workspace('pnpm', [
      'nx',
      '@megamono/plugin',
      '@nx/nest',
      '@nx/jest',
    ]);
    const harness = io(root, undefined, undefined, 'api', true);
    expect((await runMegamonoCli(['add', 'app'], harness.value)).exitCode).toBe(0);
    expect(harness.invocations[0].args).toEqual([
      'exec',
      'nx',
      'generate',
      '@megamono/plugin:app',
      '--type=api',
      '--yes',
    ]);
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

  it('delegates pnpm init options unchanged to the local generator', async () => {
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
        command: 'pnpm',
        args: [
          'exec',
          'nx',
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

  it('installs requested Playstack packages from yalc after Megamono init', async () => {
    const root = await workspace('pnpm');
    const store = await mkdtemp(join(tmpdir(), 'megamono-cli-yalc-'));
    fixtures.push(store);
    for (const packageName of ['@playstack/cli', '@playstack/auth']) {
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
    const harness = io(root, (invocation) =>
      invocation.command === 'yalc' && invocation.args[0] === 'dir'
        ? { exitCode: 0, stdout: store }
        : { exitCode: 0 },
    );

    const result = await runMegamonoCli(
      [
        'init',
        '--playstack-packages=auth,@playstack/auth',
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
        ],
        cwd: root,
        capture: false,
      },
      {
        command: 'yalc',
        args: ['add', '@playstack/cli', '--dev', '--no-pure'],
        cwd: root,
        capture: false,
      },
      {
        command: 'yalc',
        args: ['add', '@playstack/auth', '--no-pure'],
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

  it('prompts for products when playstack-packages has no value', async () => {
    const root = await workspace('npm');
    const harness = io(root, undefined, ['auth', 'cache']);

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
        command: 'npm',
        args: ['install', '--save-dev', '@playstack/cli'],
        cwd: root,
        capture: false,
      },
      {
        command: 'npm',
        args: ['install', '@playstack/auth', '@playstack/cache'],
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
    expect((await runMegamonoCli([], harness.value)).exitCode).toBe(0);
    expect(harness.stdout[0]).toBe('0.0.1-test');
    expect(harness.stdout[1]).toContain('Usage: megamono');
  });
});
