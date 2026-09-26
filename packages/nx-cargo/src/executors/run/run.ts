import { logger, type PromiseExecutor } from '@nx/devkit';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { RunExecutorSchema } from './schema';

const runExecutor: PromiseExecutor<RunExecutorSchema> = async (
  options,
  context,
) => {
  try {
    const cwd = resolve(context.root, options.cwd ?? '.');
    let executable = 'cargo';
    let args = options.args;
    if (options.tool === 'tauri') {
      // Resolve from the owning app, not a global CLI or an npm download fallback.
      const require = createRequire(join(cwd, 'package.json'));
      const manifest = require.resolve('@tauri-apps/cli/package.json');
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
        bin?: string | Record<string, string>;
      };
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tauri;
      if (!bin)
        throw new Error(
          'The local @tauri-apps/cli package has no tauri binary.',
        );
      executable = process.execPath;
      args = [resolve(dirname(manifest), bin), ...args];
    } else if (options.tool !== 'cargo')
      throw new Error('Unsupported native tool.');
    return await new Promise<{ success: boolean }>((done) => {
      const child = spawn(executable, args, {
        cwd,
        stdio: 'inherit',
        shell: false,
      });
      const interrupt = () => child.kill('SIGINT');
      const terminate = () => child.kill('SIGTERM');
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', terminate);
      const cleanup = () => {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', terminate);
      };
      child.once('error', (error) => {
        cleanup();
        logger.error(error.message);
        done({ success: false });
      });
      child.once('close', (code) => {
        cleanup();
        done({ success: code === 0 });
      });
    });
  } catch (error) {
    logger.error((error as Error).message);
    return { success: false };
  }
};

export default runExecutor;
