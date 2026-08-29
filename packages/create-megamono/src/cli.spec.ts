import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule, main } from './cli.js';

describe('CLI entrypoint', () => {
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
          '--dry-run',
        ]),
      ).resolves.toBe(0);
      expect(output).toHaveBeenCalledWith(
        expect.stringContaining('"pnpm" "dlx" "create-nx-workspace@23.1.1"'),
      );
    } finally {
      output.mockRestore();
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
