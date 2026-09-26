import { logger, type PromiseExecutor } from '@nx/devkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  isSafeWorkspaceRelativePath,
  readMegamonoConfig,
} from '../../lib/config';
import { hasErrors } from '../../lib/diagnostics';
import { validateRepositoryDocs } from '../../lib/docs';
import {
  HealthConfigurationError,
  HealthGraphError,
  healthUsesDocs,
  runRepositoryHealth,
  serializeHealthReport,
} from '../../lib/health';
import type { HealthExecutorSchema } from './schema';

const runExecutor: PromiseExecutor<HealthExecutorSchema> = async (
  options,
  context,
) => {
  try {
    let config;
    try {
      config = await readMegamonoConfig(
        context.root,
        options.config ?? 'megamono.json',
      );
    } catch (error) {
      throw new HealthConfigurationError((error as Error).message, {
        cause: error,
      });
    }
    if (!context.projectGraph?.nodes || !context.projectGraph.dependencies) {
      throw new HealthGraphError(
        'Repository health requires a complete Nx project graph.',
      );
    }
    const output = options.output ?? '.megamono/health.json';
    if (!isSafeWorkspaceRelativePath(output)) {
      throw new Error('Health output must be a safe workspace-relative path.');
    }
    const docs = healthUsesDocs(config)
      ? await validateRepositoryDocs(context.root, config, options.docsRoot)
      : { documents: [], diagnostics: [] };
    if (hasErrors(docs.diagnostics)) {
      throw new Error(
        'Repository health requires a valid docs corpus. Run megamono-docs:validate first.',
      );
    }
    const report = await runRepositoryHealth({
      workspaceRoot: context.root,
      graph: context.projectGraph,
      config,
      documents: docs.documents,
      checks: options.checks,
      ...(options.now ? { now: new Date(options.now) } : {}),
    });
    const passed = !(options.failOnFindings && report.findings.length > 0);
    const serialized = serializeHealthReport({
      ...report,
      gate: {
        mode: options.failOnFindings ? 'fail-on-findings' : 'report-only',
        passed: options.failOnFindings ? passed : null,
      },
    });
    const outputPath = resolve(context.root, output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, 'utf8');
    logger.info(serialized.trimEnd());
    return {
      success: passed,
    };
  } catch (error) {
    logger.error((error as Error).message);
    if (
      error instanceof HealthConfigurationError ||
      error instanceof HealthGraphError
    ) {
      return { success: false, exitCode: error.exitCode };
    }
    return { success: false };
  }
};

export default runExecutor;
