import manifest from '../package.json';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { input, select, checkbox } from '@inquirer/prompts';
import {
  createInteractivePrompt,
  isMainModule,
  main,
  resolveInteractive,
  selectApplications,
  selectPackages,
  type InteractivePrompt,
} from './cli.js';

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  select: vi.fn(),
  checkbox: vi.fn(),
}));

function scriptedPrompt(
  answers: string[],
  questions: string[],
): InteractivePrompt {
  const next = (message: string, initial = '') => {
    questions.push(message);
    return answers.shift() || initial;
  };
  return {
    question: async (message, initial) => next(message, initial),
    select: async (message, choices, initial) => {
      const value = next(message, initial);
      expect(choices).toContain(value);
      return value;
    },
    multiselect: async (message) =>
      next(message)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    close: vi.fn(),
  };
}

describe('CLI entrypoint', () => {
  it('accepts packages-only automation flags without prompting for apps', async () => {
    const output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      expect(
        await main([
          'package-options-test',
          '--packages=core,client',
          '--package-scope=acme',
          '--package-access=public',
          '--interactive=false',
          '--dry-run',
        ]),
      ).toBe(0);
      const rendered = output.mock.calls
        .map(([value]) => String(value))
        .join('');
      expect(rendered).toContain('--importPath=@acme/core');
      expect(rendered).toContain('configure public npm package access');
      expect(rendered).not.toContain('@megamono/plugin:app');
    } finally {
      output.mockRestore();
    }
  });
  it('defaults package setup on without apps and off with apps', async () => {
    expect(await selectPackages(scriptedPrompt([], []), true)).toEqual([
      'core',
    ]);
    expect(await selectPackages(scriptedPrompt([], []), false)).toEqual([]);
  });

  it('adds and removes named packages with validated names', async () => {
    const prompt = scriptedPrompt(
      ['yes', 'add', 'core', 'add', 'client', 'remove', 'core', 'continue'],
      [],
    );
    const question = vi.spyOn(prompt, 'question');
    expect(await selectPackages(prompt, false)).toEqual(['client']);
    expect(question.mock.calls[0][2]?.('../escape')).toContain(
      'lowercase slugs',
    );
    expect(question.mock.calls[1][2]?.('client')).toContain('Duplicate');
  });

  it('sets up packages before tooling and defaults to no database without apps', async () => {
    const questions: string[] = [];
    const result = await resolveInteractive(
      { name: 'toolkit', apps: [], interactive: true },
      scriptedPrompt([], questions),
    );
    expect(result).toMatchObject({
      apps: [],
      packages: ['core'],
      packageScope: 'toolkit',
      packageAccess: 'restricted',
      databaseAdapter: 'none',
    });
    expect(questions.indexOf('Package access')).toBeLessThan(
      questions.indexOf('Package manager'),
    );
  });
  it('uses selectable prompts with explicit defaults and a service checklist', async () => {
    vi.mocked(select).mockResolvedValueOnce('prisma');
    vi.mocked(checkbox).mockResolvedValueOnce(['postgres', 'redis']);
    vi.mocked(input).mockResolvedValueOnce('primary');
    try {
      const prompt = createInteractivePrompt();
      expect(
        await prompt.select(
          'Database adapter',
          ['none', 'prisma', 'drizzle'],
          'prisma',
        ),
      ).toBe('prisma');
      expect(
        await prompt.multiselect('Services', ['postgres', 'redis']),
      ).toEqual(['postgres', 'redis']);
      expect(await prompt.question('Database name', 'primary')).toBe('primary');
      expect(select).toHaveBeenCalledWith({
        message: 'Database adapter',
        pageSize: 10,
        default: 'prisma',
        choices: [{ value: 'none' }, { value: 'prisma' }, { value: 'drizzle' }],
      });
      expect(checkbox).toHaveBeenCalledWith({
        message: 'Services (optional)',
        choices: [{ value: 'postgres' }, { value: 'redis' }],
      });
      expect(input).toHaveBeenCalledWith({
        message: 'Database name',
        default: 'primary',
        validate: undefined,
      });
    } finally {
      vi.clearAllMocks();
    }
  });

  it('turns prompt cancellation into a clear exit-130 error', async () => {
    vi.mocked(input).mockRejectedValueOnce(
      Object.assign(new Error('User force closed the prompt'), {
        name: 'ExitPromptError',
      }),
    );
    try {
      await expect(
        createInteractivePrompt().question('Workspace name'),
      ).rejects.toMatchObject({
        exitCode: 130,
        message: expect.stringContaining('cancelled'),
      });
    } finally {
      vi.clearAllMocks();
    }
  });

  it('preserves repeated named apps, default choices, and empty services', async () => {
    const questions: string[] = [];
    const prompt = scriptedPrompt(
      [
        'add',
        'extension',
        'extension-grids',
        'add',
        'extension',
        'extension-guides',
        'continue',
      ],
      questions,
    );
    const result = await resolveInteractive(
      { name: 'extensions', interactive: true },
      prompt,
    );
    expect(result).toMatchObject({
      apps: ['extension:extension-grids', 'extension:extension-guides'],
      packageManager: 'npm',
      databaseAdapter: 'prisma',
      databaseName: 'primary',
      services: [],
      serviceRunner: 'none',
    });
    expect(questions).not.toContain('Web styling');
    expect(questions).not.toContain('Next.js router');
    expect(prompt.close).toHaveBeenCalledOnce();
  });

  it('offers native Android instances in the guided app cart', async () => {
    const prompt = scriptedPrompt(
      ['add', 'android', 'reader', 'add', 'android', 'admin', 'continue'],
      [],
    );
    expect(await selectApplications(prompt)).toEqual([
      'android:reader',
      'android:admin',
    ]);
  });

  it('validates names and duplicate roots before adding an app', async () => {
    const prompt = scriptedPrompt(
      ['add', 'extension', 'add', 'web', 'continue'],
      [],
    );
    let calls = 0;
    prompt.question = async (_message, _initial, validate) => {
      calls++;
      expect(validate?.('custom-name')).toBe(true);
      expect(validate?.('../outside')).toContain('Invalid app name');
      expect(validate?.('web:admin')).toContain('Invalid app descriptor');
      if (calls === 2)
        expect(validate?.('shared-name')).toContain('unique name');
      return calls === 1 ? 'shared-name' : 'other-name';
    };
    expect(await selectApplications(prompt)).toEqual([
      'extension:shared-name',
      'web:other-name',
    ]);
  });

  it('suggests unique defaults for repeated app types and lets edits retain their own name', async () => {
    const prompt = scriptedPrompt(
      [
        'add',
        'extension',
        '',
        'add',
        'extension',
        '',
        'edit',
        '0',
        'extension',
        '',
        'continue',
      ],
      [],
    );
    const question = vi.spyOn(prompt, 'question');
    expect(await selectApplications(prompt)).toEqual([
      'extension',
      'extension:extension-2',
    ]);
    expect(question.mock.calls.map((call) => call[1])).toEqual([
      'extension',
      'extension-2',
      'extension',
    ]);
    expect(question.mock.calls[2][2]?.('extension')).toBe(true);
    expect(question.mock.calls[2][2]?.('extension-2')).toContain('unique name');
  });

  it('edits types and names, removes items, and renders the remaining app list', async () => {
    const questions: string[] = [];
    const prompt = scriptedPrompt(
      [
        'add',
        'web',
        '',
        'add',
        'api',
        '',
        'edit',
        '0',
        'site',
        'marketing',
        'remove',
        '1',
        'continue',
      ],
      questions,
    );
    expect(await selectApplications(prompt)).toEqual(['site:marketing']);
    expect(questions.at(-1)).toContain('site → apps/marketing');
    expect(questions.at(-1)).not.toContain('api →');
  });

  it('supports backing out of add/edit/remove and continuing without apps', async () => {
    const prompt = scriptedPrompt(
      [
        'add',
        'back',
        'add',
        'web',
        '',
        'edit',
        'back',
        'remove',
        'back',
        'edit',
        '0',
        'back',
        'remove',
        '0',
        'continue',
      ],
      [],
    );
    expect(await selectApplications(prompt)).toEqual([]);
  });

  it('preserves an explicit empty app list without opening the cart', async () => {
    const questions: string[] = [];
    const result = await resolveInteractive(
      { name: 'no-apps', interactive: true, apps: [] },
      scriptedPrompt([], questions),
    );
    expect(
      questions.some((message) => message.startsWith('Applications')),
    ).toBe(false);
    expect(result.databaseAdapter).toBe('none');
    expect(questions).not.toContain('Database name');
  });

  it('leaves noninteractive input untouched without opening prompts', async () => {
    const prompt = scriptedPrompt([], []);
    const input = { name: 'automated', interactive: false };
    expect(await resolveInteractive(input, prompt)).toBe(input);
    expect(prompt.close).not.toHaveBeenCalled();
  });

  it('closes the guided flow when a prompt rejects', async () => {
    const prompt = scriptedPrompt([], []);
    prompt.question = vi.fn().mockRejectedValue(new Error('cancelled'));
    await expect(
      resolveInteractive({ interactive: true }, prompt),
    ).rejects.toThrow('cancelled');
    expect(prompt.close).toHaveBeenCalledOnce();
  });

  it('accepts --springbar as the service-runner shortcut in a read-only plan', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      expect(
        await main([
          'springbar-example',
          '--apps=web',
          '--springbar',
          '--interactive=false',
          '--dry-run',
        ]),
      ).toBe(0);
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining(
          'Springbar MCP inspect_candidates -> setup_workspace',
        ),
      );
    } finally {
      output.mockRestore();
    }
  });

  it('rejects conflicting Springbar runner flags before creation', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(
        await main([
          'springbar-example',
          '--apps=web',
          '--springbar',
          '--service-runner=none',
          '--interactive=false',
          '--dry-run',
        ]),
      ).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('conflicts'));
    } finally {
      error.mockRestore();
    }
  });
  it.each([
    ['--help'],
    ['-h'],
    ['occupied-name', '--invalid-option', '--help'],
  ])('prints help before workspace validation: %s', async (...args) => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(main(args)).resolves.toBe(0);
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('type[:name]'),
      );
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('--local-packages=yalc'),
      );
      expect(output).toHaveBeenCalledWith(expect.stringContaining('--dry-run'));
    } finally {
      output.mockRestore();
    }
  });

  it('reports machine-readable build identity without a workspace name', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(main(['--version', '--json'])).resolves.toBe(0);
      const identity = JSON.parse(String(output.mock.calls[0]?.[0]));
      expect(identity).toMatchObject({
        package: 'create-megamono',
        version: manifest.version,
        revision: 'development',
        buildId: 'development',
      });
    } finally {
      output.mockRestore();
    }
  });

  it('ends the guided flow with services and optional Springbar setup', async () => {
    const questions: string[] = [];
    const answers = [
      'add',
      'web',
      '',
      'add',
      'api',
      '',
      'continue',
      'no',
      'pnpm',
      'drizzle',
      'stylex',
      'events',
      'app',
      'postgres, redis',
      'springbar',
    ];
    const resolved = await resolveInteractive(
      { name: 'guided-workspace', interactive: true },
      scriptedPrompt(answers, questions),
    );

    expect(resolved).toMatchObject({
      name: 'guided-workspace',
      packageManager: 'pnpm',
      apps: ['web', 'api'],
      services: ['postgres', 'redis'],
      databaseAdapter: 'drizzle',
      databaseName: 'events',
      styling: 'stylex',
      router: 'app',
      serviceRunner: 'springbar',
    });
    expect(questions[0]).toContain('No applications added yet');
    expect(questions).toContain('Application type');
    expect(questions).toContainEqual(expect.stringContaining('Web styling'));
    expect(questions.at(-2)).toBe('Services');
    expect(questions.at(-1)).toBe('Service runner');
  });

  it('asks for web styling when a guided app uses a custom name', async () => {
    const questions: string[] = [];
    const answers = [
      'add',
      'site',
      'marketing',
      'continue',
      'no',
      'npm',
      'none',
      'css-modules',
      'pages',
      '',
      'none',
    ];
    const resolved = await resolveInteractive(
      { name: 'named-site', interactive: true },
      scriptedPrompt(answers, questions),
    );

    expect(resolved.apps).toEqual(['site:marketing']);
    expect(resolved.styling).toBe('css-modules');
    expect(questions).toContainEqual(expect.stringContaining('Web styling'));
  });

  it('retains explicit service choices without prompting for them', async () => {
    const questions: string[] = [];
    const resolved = await resolveInteractive(
      {
        name: 'explicit-services',
        apps: ['api'],
        packages: [],
        services: ['typesense'],
        databaseAdapter: 'none',
        serviceRunner: 'springbar',
        interactive: true,
        packageManager: 'pnpm',
      },
      scriptedPrompt([], questions),
    );

    expect(resolved.services).toEqual(['typesense']);
    expect(resolved.serviceRunner).toBe('springbar');
    expect(questions).toEqual([]);
  });

  it('recognizes an npm-style symlink to the executable module', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'create-megamono-cli-'));
    const modulePath = resolve(root, 'dist/cli.js');
    const executablePath = resolve(root, 'node_modules/.bin/create-megamono');
    await mkdir(resolve(root, 'dist'));
    await mkdir(resolve(root, 'node_modules/.bin'), { recursive: true });
    await symlink(import.meta.filename, modulePath);
    await symlink(modulePath, executablePath);

    expect(isMainModule(pathToFileURL(modulePath).href, executablePath)).toBe(
      true,
    );
  });

  it('accepts the package manager option and renders its dry-run commands', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(
        main([
          'cli-package-manager-fixture',
          '--apps=web',
          '--interactive=false',
          '--package-manager=pnpm',
          '--router=app',
          '--dry-run',
        ]),
      ).resolves.toBe(0);
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('"pnpm" "dlx" "create-nx-workspace@23.1.1"'),
      );
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('--router=app'),
      );
    } finally {
      output.mockRestore();
    }
  });

  it('accepts repeatable positional type and type:name app descriptors', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(
        main([
          'multi-app-fixture',
          'site:marketing',
          'extension:extension-grids',
          'extension:extension-guides',
          'api',
          'web:admin',
          'web',
          '--interactive=false',
          '--dry-run',
        ]),
      ).resolves.toBe(0);
      const rendered = output.mock.calls
        .map(([value]) => String(value))
        .join('');
      expect(rendered).toContain('--type=site" "--name=marketing');
      expect(rendered).toContain('--type=extension" "--name=extension-grids');
      expect(rendered).toContain('--type=extension" "--name=extension-guides');
      expect(rendered).toContain('--type=web" "--name=admin');
    } finally {
      output.mockRestore();
    }
  });

  it('rejects mixed positional and --apps app inputs', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(
        main([
          'mixed-app-fixture',
          'web:admin',
          '--apps=api',
          '--interactive=false',
          '--dry-run',
        ]),
      ).resolves.toBe(2);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('positionally or with --apps'),
      );
    } finally {
      error.mockRestore();
    }
  });

  it('accepts an explicit database adapter and arbitrary database name', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await expect(
        main([
          'cli-database-fixture',
          '--apps=api',
          '--database-adapter=drizzle',
          '--database-name=events',
          '--interactive=false',
          '--dry-run',
        ]),
      ).resolves.toBe(0);
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('@megamono/plugin:database'),
      );
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('--name=events'),
      );
    } finally {
      output.mockRestore();
    }
  });
});
