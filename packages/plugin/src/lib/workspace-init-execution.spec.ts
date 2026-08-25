import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_INIT_RECOVERY_PATH,
  createWorkspaceInitPostFlushCallback,
} from './workspace-init-execution';

describe('workspace init post-flush execution', () => {
  it('records completed steps and the exact retry after failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-init-recovery-'));
    const callback = createWorkspaceInitPostFlushCallback(root, [
      { id: 'prepare', retry: 'npm run prepare', run: () => undefined },
      {
        id: 'install-dependencies',
        retry: 'npm install',
        run: () => {
          throw new Error('registry unavailable');
        },
      },
    ]);

    await expect(callback()).rejects.toMatchObject({
      diagnosticCode: 'workspace-init-external-command',
      exitCode: 1,
    });
    const recovery = await readFile(
      join(root, WORKSPACE_INIT_RECOVERY_PATH),
      'utf8',
    );
    expect(recovery).toContain('- prepare');
    expect(recovery).toContain('`npm install`');
    expect(recovery).toContain('did not commit, push, revert, or roll back');
  });

  it('removes a stale recovery report after successful completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-init-recovery-'));
    await writeFile(join(root, WORKSPACE_INIT_RECOVERY_PATH), 'stale');
    const callback = createWorkspaceInitPostFlushCallback(root, [
      {
        id: 'install-dependencies',
        retry: 'npm install',
        run: () => undefined,
      },
    ]);

    await callback();
    await expect(
      readFile(join(root, WORKSPACE_INIT_RECOVERY_PATH)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
