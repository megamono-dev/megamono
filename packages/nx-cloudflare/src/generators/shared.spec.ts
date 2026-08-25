import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { CLOUDFLARE_RECOVERY_PATH, createPostFlushCallback } from './shared';

describe('Cloudflare generator external command recovery', () => {
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
