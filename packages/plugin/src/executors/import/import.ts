import { logger, type PromiseExecutor } from '@nx/devkit';
import {
  analyzeRepositoryImport,
  ImportDecisionError,
  ImportOptionsError,
  ImportPreflightError,
  renderRepositoryImportReport,
} from '../../lib/repository-import';
import {
  assertNoPartialRepositoryImport,
  completedRepositoryImport,
  executeRepositoryImport,
  ImportExecutionError,
} from '../../lib/repository-import-execution';
import type { ImportExecutorSchema } from './schema';

const runExecutor: PromiseExecutor<ImportExecutorSchema> = async (
  options,
  context,
) => {
  try {
    if (options.execute && !options.expectedSourceSha) {
      throw new ImportDecisionError(
        'import-expected-source-sha-required',
        'Execution requires expectedSourceSha from the approved analysis.',
      );
    }
    if (options.execute && !options.history) {
      throw new ImportDecisionError(
        'import-history-required',
        'Execution requires an explicit history strategy.',
      );
    }
    if (options.execute) {
      const marker = await completedRepositoryImport(context.root, options);
      if (marker) {
        logger.info(
          `Import ${options.name} is already complete at ${marker.sourceSha}; no changes made.`,
        );
        return { success: true };
      }
      await assertNoPartialRepositoryImport(context.root, options.name);
    }

    const analysis = await analyzeRepositoryImport({
      workspaceRoot: context.root,
      options,
      projectNames: Object.keys(context.projectGraph?.nodes ?? {}),
      targetProjects: Object.entries(context.projectGraph?.nodes ?? {}).map(
        ([name, node]) => {
          const packageName = (
            node.data.metadata as { js?: { packageName?: unknown } } | undefined
          )?.js?.packageName;
          return {
            name,
            ...(typeof packageName === 'string' ? { packageName } : {}),
          };
        },
      ),
    });
    logger.info(renderRepositoryImportReport(analysis).trimEnd());

    if (analysis.blockers.length > 0) {
      const first = analysis.blockers[0];
      throw new ImportPreflightError(first.code, first.message);
    }
    if (!options.execute) return { success: true };
    if (analysis.unresolved.length > 0) {
      throw new ImportDecisionError(
        analysis.unresolved[0].code,
        analysis.unresolved[0].message,
      );
    }
    const result = await executeRepositoryImport(
      context.root,
      analysis,
      options,
    );
    logger.info(
      `Imported ${analysis.name} at ${analysis.sourceSha} in ${result.integrationCommit}.`,
    );
    return { success: true };
  } catch (error) {
    const failure = error as Error & { code?: string; exitCode?: number };
    logger.error(
      `${failure.code ? `${failure.code}: ` : ''}${failure.message}`,
    );
    if (
      error instanceof ImportOptionsError ||
      error instanceof ImportPreflightError ||
      error instanceof ImportDecisionError ||
      error instanceof ImportExecutionError
    ) {
      return { success: false, exitCode: error.exitCode };
    }
    return { success: false };
  }
};

export default runExecutor;
