import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule, main, resolveInteractive } from './cli.js';

describe('CLI entrypoint', () => {
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
        version: '0.0.1',
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
      'web, api',
      'drizzle',
      'stylex',
      'events',
      'app',
      'postgres, redis',
      'springbar',
    ];
    const resolved = await resolveInteractive(
      { name: 'guided-workspace', interactive: true },
      {
        question: async (message) => {
          questions.push(message);
          return answers.shift() ?? '';
        },
        close: () => undefined,
      },
    );

    expect(resolved).toMatchObject({
      name: 'guided-workspace',
      apps: ['web', 'api'],
      services: ['postgres', 'redis'],
      databaseAdapter: 'drizzle',
      databaseName: 'events',
      styling: 'stylex',
      router: 'app',
      serviceRunner: 'springbar',
    });
    expect(questions[0]).toContain('Application types:');
    expect(questions[0]).toContain('web       Next.js product');
    expect(questions[0]).toContain('extension Browser extension');
    expect(questions[0]).toContain('type or type:name');
    expect(questions).toContainEqual(expect.stringContaining('Web styling'));
    expect(questions.at(-2)).toContain('Services (postgres, redis');
    expect(questions.at(-1)).toContain('Service runner (none, springbar)');
  });

  it('asks for web styling when a guided app uses a custom name', async () => {
    const questions: string[] = [];
    const answers = [
      'site:marketing',
      'none',
      'css-modules',
      'pages',
      '',
      'none',
    ];
    const resolved = await resolveInteractive(
      { name: 'named-site', interactive: true },
      {
        question: async (message) => {
          questions.push(message);
          return answers.shift() ?? '';
        },
        close: () => undefined,
      },
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
        services: ['typesense'],
        databaseAdapter: 'none',
        serviceRunner: 'springbar',
        interactive: true,
      },
      {
        question: async (message) => {
          questions.push(message);
          return '';
        },
        close: () => undefined,
      },
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
