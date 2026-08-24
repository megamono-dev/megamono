import { logger, type PromiseExecutor } from '@nx/devkit';
import { unlink } from 'node:fs/promises';
import { relative } from 'node:path';
import { readMegamonoConfig } from '../../lib/config';
import { formatDiagnostic, hasErrors } from '../../lib/diagnostics';
import { generateDocsIndexes, validateRepositoryDocs } from '../../lib/docs';
import { findExpiredReports } from '../../lib/docs-lifecycle';
import type { DocsPruneReportsExecutorSchema } from './schema';

const runExecutor: PromiseExecutor<DocsPruneReportsExecutorSchema> = async (
  options,
  context,
) => {
  try {
    const config = await readMegamonoConfig(
      context.root,
      options.config ?? 'megamono.json',
    );
    const docsRoot = options.docsRoot ?? config.docs.root;
    const validation = await validateRepositoryDocs(
      context.root,
      config,
      docsRoot,
    );
    if (hasErrors(validation.diagnostics)) {
      for (const diagnostic of validation.diagnostics) {
        logger.error(formatDiagnostic(diagnostic));
      }
      return { success: false };
    }
    const now = options.now ? new Date(options.now) : new Date();
    if (Number.isNaN(now.getTime()))
      throw new Error(`Invalid --now value ${options.now}.`);
    const expired = findExpiredReports(validation.documents, config, now);
    if (expired.length === 0) {
      logger.info('No expired reports.');
      return { success: true };
    }
    const expiredIds = new Set(expired.map((document) => document.data.id));
    const inbound = validation.documents.filter(
      (document) =>
        !expiredIds.has(document.data.id) &&
        (document.data.references.some((id) => expiredIds.has(id)) ||
          (document.data.supersedes
            ? expiredIds.has(document.data.supersedes)
            : false)),
    );
    if (inbound.length > 0) {
      throw new Error(
        `Expired reports still have inbound references from: ${inbound
          .map((document) => document.data.id)
          .sort()
          .join(', ')}.`,
      );
    }
    for (const document of expired) {
      logger.info(
        `${options.confirm ? 'Delete' : 'Would delete'} ${document.data.id} (${relative(context.root, document.absolutePath)})`,
      );
    }
    if (!options.confirm) return { success: true };
    for (const document of expired) await unlink(document.absolutePath);
    const finalValidation = await validateRepositoryDocs(
      context.root,
      config,
      docsRoot,
    );
    await generateDocsIndexes(
      context.root,
      config,
      finalValidation.documents,
      docsRoot,
    );
    return { success: !hasErrors(finalValidation.diagnostics) };
  } catch (error) {
    logger.error((error as Error).message);
    return { success: false };
  }
};

export default runExecutor;
