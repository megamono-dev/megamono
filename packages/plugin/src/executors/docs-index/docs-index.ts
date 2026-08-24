import { logger, type PromiseExecutor } from '@nx/devkit';
import { readMegamonoConfig } from '../../lib/config';
import { formatDiagnostic, hasErrors } from '../../lib/diagnostics';
import { generateDocsIndexes, validateRepositoryDocs } from '../../lib/docs';
import type { DocsIndexExecutorSchema } from './schema';

const runExecutor: PromiseExecutor<DocsIndexExecutorSchema> = async (
  options,
  context,
) => {
  try {
    const config = await readMegamonoConfig(
      context.root,
      options.config ?? 'megamono.json',
    );
    const validation = await validateRepositoryDocs(
      context.root,
      config,
      options.docsRoot,
    );
    for (const diagnostic of validation.diagnostics) {
      const message = formatDiagnostic(diagnostic);
      if (diagnostic.severity === 'error') logger.error(message);
      else logger.warn(message);
    }
    if (hasErrors(validation.diagnostics)) return { success: false };

    const changed = await generateDocsIndexes(
      context.root,
      config,
      validation.documents,
      options.docsRoot,
      !options.check,
    );
    if (options.check && changed.length > 0) {
      logger.error(`Documentation indexes are stale: ${changed.join(', ')}`);
      return { success: false };
    }
    if (changed.length === 0) logger.info('Documentation indexes are current.');
    else logger.info(`Updated ${changed.join(', ')}.`);
    return { success: true };
  } catch (error) {
    logger.error((error as Error).message);
    return { success: false };
  }
};

export default runExecutor;
