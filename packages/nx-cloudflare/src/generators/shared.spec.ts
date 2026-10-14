import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  CLOUDFLARE_RECOVERY_PATH,
  createPostFlushCallback,
  typegenTask,
} from './shared';

describe('Cloudflare generator external command recovery', () => {
  it.each([
    ['npm', 'package-lock.json', ['exec', 'wrangler', '--']],
    ['pnpm', 'pnpm-lock.yaml', ['exec', 'wrangler']],
    ['yarn', 'yarn.lock', ['wrangler']],
    ['bun', 'bun.lock', ['x', 'wrangler']],
  ])(
    'uses the %s workspace manager for type generation and recovery',
    async (manager, lockfile, prefix) => {
      const root = await mkdtemp(resolve(tmpdir(), 'nx-cloudflare-manager-'));
      try {
        await writeFile(resolve(root, lockfile as string), '');
        const runner = vi.fn(async () => undefined);
        const task = typegenTask(root, 'apps/api/wrangler.jsonc', runner);
        await task.run();
        const args = [
          ...prefix,
          'types',
          'apps/api/worker-configuration.d.ts',
          '--config',
          'apps/api/wrangler.jsonc',
        ];
        expect(runner).toHaveBeenCalledWith(manager, args, root);
        expect(task.retry).toBe([manager, ...args].join(' '));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('records completed steps and a deterministic retry after failure', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'nx-cloudflare-recovery-'));
    try {
      const callback = createPostFlushCallback(root, [
        {
          id: 'npm-install',
          retry: 'npm install',
          run: async () => undefined,
        },
        {
          id: 'wrangler-types',
          retry: 'npm exec wrangler -- types --config apps/api/wrangler.jsonc',
          run: async () => {
            throw new Error('injected failure');
          },
        },
      ]);
      await expect(callback?.()).rejects.toMatchObject({
        kind: 'external-command',
        exitCode: 1,
        diagnosticCode: 'cloudflare-generator-external-command',
      });
      expect(
        await readFile(resolve(root, CLOUDFLARE_RECOVERY_PATH), 'utf8'),
      ).toContain('- npm-install');
      expect(
        await readFile(resolve(root, CLOUDFLARE_RECOVERY_PATH), 'utf8'),
      ).toContain(
        'npm exec wrangler -- types --config apps/api/wrangler.jsonc',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
