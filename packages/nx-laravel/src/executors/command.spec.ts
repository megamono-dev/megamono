import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ExecutorContext } from '@nx/devkit';
import command, { safeRoot, runTool } from './command';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

describe('PHP command execution', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'megamono-php-command-'));
    await mkdir(join(root, 'app'));
    vi.mocked(spawn).mockImplementation(() => {
      const process = new EventEmitter();
      queueMicrotask(() => process.emit('exit', 0));
      return process as ReturnType<typeof spawn>;
    });
  });
  afterEach(async () => {
    vi.clearAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  it('uses argument arrays and the app root for Herd without invoking a shell', async () => {
    await command(
      {
        root: 'app',
        tool: 'php',
        args: ['artisan', 'test', ';not-a-shell-command'],
        runtime: 'herd',
      },
      { root } as ExecutorContext,
    );
    expect(spawn).toHaveBeenCalledWith(
      'herd',
      ['php', 'artisan', 'test', ';not-a-shell-command'],
      { cwd: safeRoot(root, 'app'), shell: false, stdio: 'inherit' },
    );
  });
  it('rejects invalid commands and traversal before launching anything', async () => {
    await expect(
      command({ root: '../outside', tool: 'php', args: [] }, {
        root,
      } as ExecutorContext),
    ).rejects.toThrow('workspace-relative');
    await expect(
      command({ root: 'app', tool: 'php', args: ['bad\0argument'] }, {
        root,
      } as ExecutorContext),
    ).rejects.toThrow('Invalid');
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects symlink escapes', async () => {
    await symlink(tmpdir(), join(root, 'outside'));
    expect(() => safeRoot(root, 'outside')).toThrow('escapes');
  });
  it('propagates tool failure instead of reporting success', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      const process = new EventEmitter();
      queueMicrotask(() => process.emit('exit', 7));
      return process as ReturnType<typeof spawn>;
    });
    await expect(runTool('php', ['artisan', 'test'], root)).rejects.toThrow(
      'php failed (7)',
    );
  });
});
