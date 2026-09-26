import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { logger, type ExecutorContext } from '@nx/devkit';
import { afterEach, expect, it, vi } from 'vitest';
import run from './run';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.each([0, 1, null])(
  'passes argument vectors unchanged and reports exit %s',
  async (code) => {
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
    const args = [
      'test',
      '--manifest-path',
      "crates/my crate's & demo/Cargo.toml",
      '--locked',
    ];
    const pending = run({ tool: 'cargo', args }, {
      root: process.cwd(),
    } as ExecutorContext);
    expect(spawn).toHaveBeenCalledWith('cargo', args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      shell: false,
    });
    child.emit('close', code);
    expect(await pending).toEqual({ success: code === 0 });
  },
);

it('reports missing tools and removes signal handlers', async () => {
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const before = process.listenerCount('SIGTERM');
  const child = new EventEmitter();
  vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
  const pending = run({ tool: 'cargo', args: [] }, {
    root: process.cwd(),
  } as ExecutorContext);
  child.emit('error', new Error('ENOENT'));
  expect(await pending).toEqual({ success: false });
  expect(process.listenerCount('SIGTERM')).toBe(before);
});
