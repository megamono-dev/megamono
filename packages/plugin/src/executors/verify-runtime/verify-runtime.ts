import { logger, type PromiseExecutor } from '@nx/devkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isSafeWorkspaceRelativePath } from '../../lib/config';
import {
  serializeRuntimeDependencyReport,
  verifyRuntimeDependencies,
} from '../../lib/runtime-verification';
import type { VerifyRuntimeExecutorSchema } from './schema';

function outputPathFromTarget(
  projectRoot: string,
  target: { readonly outputs?: readonly string[]; readonly options?: unknown },
): string | null {
  const options =
    target.options && typeof target.options === 'object'
      ? (target.options as Record<string, unknown>)
      : {};
  if (typeof options.outputPath === 'string') return options.outputPath;
  const output = target.outputs?.find((entry) => typeof entry === 'string');
  return output
    ? output
        .replace(/^\{workspaceRoot\}\//, '')
        .replace(/\{projectRoot\}/g, projectRoot)
    : null;
}

const runExecutor: PromiseExecutor<VerifyRuntimeExecutorSchema> = async (
  options,
  context,
) => {
  const project = options.project ?? context.projectName;
  if (!project) {
    logger.error('verify-runtime requires a project option or target project.');
    return { success: false };
  }
  const node = context.projectGraph?.nodes[project];
  if (!node) {
    logger.error(`Unknown Nx project ${project}.`);
    return { success: false };
  }
  const targetName = options.buildTarget ?? 'build';
  const target = node.data.targets?.[targetName];
  const outputPath =
    options.outputPath ??
    (target ? outputPathFromTarget(node.data.root, target) : null);
  if (!outputPath || !isSafeWorkspaceRelativePath(outputPath)) {
    logger.error(
      `Unable to infer a safe output path for ${project}:${targetName}; pass --outputPath explicitly.`,
    );
    return { success: false };
  }
  if (options.report && !isSafeWorkspaceRelativePath(options.report)) {
    logger.error('Runtime verification report must be workspace-relative.');
    return { success: false };
  }
  if (
    options.webpackEvidence &&
    !isSafeWorkspaceRelativePath(options.webpackEvidence)
  ) {
    logger.error('Webpack evidence must be workspace-relative.');
    return { success: false };
  }
  const report = await verifyRuntimeDependencies({
    workspaceRoot: context.root,
    project,
    projectRoot: node.data.root,
    outputPath,
    webpackEvidence: options.webpackEvidence,
  });
  const serialized = serializeRuntimeDependencyReport(report);
  if (options.report) {
    const path = resolve(context.root, options.report);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serialized, 'utf8');
  }
  logger.info(serialized.trimEnd());
  return { success: report.findings.length === 0 };
};

export default runExecutor;
