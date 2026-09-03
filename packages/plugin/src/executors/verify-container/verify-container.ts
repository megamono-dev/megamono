import { logger, type PromiseExecutor } from '@nx/devkit';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isSafeWorkspaceRelativePath } from '../../lib/config';
import {
  serializeContainerVerificationReport,
  verifyContainerDefinition,
} from '../../lib/container-verification';
import type { VerifyContainerExecutorSchema } from './schema';

function runDocker(args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn('docker', [...args], {
      cwd,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

const runExecutor: PromiseExecutor<VerifyContainerExecutorSchema> = async (
  options,
  context,
) => {
  const dockerfile = options.dockerfile ?? 'Dockerfile';
  const buildContext = options.context ?? '.';
  for (const [name, value] of [
    ['dockerfile', dockerfile],
    ['context', buildContext],
    ['report', options.report],
  ] as const)
    if (value && !isSafeWorkspaceRelativePath(value)) {
      logger.error(`${name} must be workspace-relative.`);
      return { success: false };
    }
  const report = await verifyContainerDefinition({
    workspaceRoot: context.root,
    dockerfile,
  });
  const serialized = serializeContainerVerificationReport(report);
  if (options.report) {
    const path = resolve(context.root, options.report);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serialized, 'utf8');
  }
  logger.info(serialized.trimEnd());
  if (report.findings.some(({ severity }) => severity === 'error'))
    return { success: false };
  if (options.smoke) {
    const code = await runDocker(
      ['build', '--file', dockerfile, resolve(context.root, buildContext)],
      context.root,
    );
    if (code !== 0) return { success: false };
  }
  return { success: true };
};

export default runExecutor;
