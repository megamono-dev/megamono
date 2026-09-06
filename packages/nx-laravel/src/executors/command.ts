import type { ExecutorContext } from '@nx/devkit';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export function safeRoot(workspaceRoot: string, root: string): string {
  if (!root || isAbsolute(root) || root.split(/[\\/]/).includes('..'))
    throw new Error('Expected a workspace-relative project root.');
  const workspace = realpathSync(workspaceRoot),
    target = realpathSync(resolve(workspace, root));
  const path = relative(workspace, target);
  if (
    path === '..' ||
    path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(path)
  )
    throw new Error('Project root escapes the workspace.');
  return target;
}
export async function runTool(
  tool: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(tool, [...args], {
      cwd,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${tool} failed (${signal ?? code}).`)),
    );
  });
}
export interface CommandOptions {
  root: string;
  tool: 'php' | 'composer' | 'herd' | 'npm';
  args: string[];
  runtime?: 'system' | 'herd';
}
export default async function command(
  options: CommandOptions,
  context: ExecutorContext,
) {
  if (
    !['php', 'composer', 'herd', 'npm'].includes(options.tool) ||
    !Array.isArray(options.args) ||
    options.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
  )
    throw new Error('Invalid PHP tool command.');
  const herd =
    options.runtime === 'herd' && ['php', 'composer'].includes(options.tool);
  await runTool(
    herd ? 'herd' : options.tool,
    herd ? [options.tool, ...options.args] : options.args,
    safeRoot(context.root, options.root),
  );
  return { success: true };
}
