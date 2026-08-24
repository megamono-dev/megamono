import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from './cli.js';

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
});
