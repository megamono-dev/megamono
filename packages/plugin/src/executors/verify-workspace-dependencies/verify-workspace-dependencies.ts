import { logger, type PromiseExecutor } from '@nx/devkit';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isSafeWorkspaceRelativePath } from '../../lib/config';
import {
  serializeWorkspaceDependencyReport,
  verifyWorkspaceDependencies,
} from '../../lib/workspace-dependency-verification';
import type { VerifyWorkspaceDependenciesExecutorSchema } from './schema';

const executeFile = promisify(execFile);

async function activePnpm(root: string): Promise<string | undefined> {
  try {
    return (
      await executeFile('pnpm', ['--version'], { cwd: root })
    ).stdout.trim();
  } catch {
    return undefined;
  }
}

const runExecutor: PromiseExecutor<
  VerifyWorkspaceDependenciesExecutorSchema
> = async (options, context) => {
  if (options.report && !isSafeWorkspaceRelativePath(options.report)) {
    logger.error('Workspace dependency report must be workspace-relative.');
    return { success: false };
  }
  const checkActive = options.checkActiveToolchain !== false;
  const report = await verifyWorkspaceDependencies({
    workspaceRoot: context.root,
    ...(checkActive
      ? {
          activeNode: process.version.replace(/^v/, ''),
          activePnpm: await activePnpm(context.root),
        }
      : {}),
  });
  const serialized = serializeWorkspaceDependencyReport(report);
  if (options.report) {
    const path = resolve(context.root, options.report);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serialized, 'utf8');
  }
  logger.info(serialized.trimEnd());
  return { success: report.findings.length === 0 };
};

export default runExecutor;
