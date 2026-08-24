import { logger, type PromiseExecutor } from '@nx/devkit';
import {
  cp,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import matter = require('gray-matter');
import { format } from 'prettier';
import { readMegamonoConfig } from '../../lib/config';
import { formatDiagnostic, hasErrors } from '../../lib/diagnostics';
import { generateDocsIndexes, validateRepositoryDocs } from '../../lib/docs';
import { planDocumentArchive } from '../../lib/docs-lifecycle';
import type { DocsArchiveExecutorSchema } from './schema';

async function renderDocument(
  content: string,
  data: Readonly<Record<string, unknown>>,
): Promise<string> {
  return format(matter.stringify(content, data), { parser: 'markdown' });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const runExecutor: PromiseExecutor<DocsArchiveExecutorSchema> = async (
  options,
  context,
) => {
  let temporaryRoot: string | undefined;
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
    const plan = planDocumentArchive(validation.documents, {
      id: options.id,
      status: options.status,
      reason: options.reason,
      replacementId: options.replacementId,
      completedAt: options.completedAt,
    });
    const sourcePath = plan.document.absolutePath;
    const absoluteDocsRoot = resolve(context.root, docsRoot);
    const destinationPath = resolve(
      absoluteDocsRoot,
      plan.destinationRelativePath,
    );
    if (await exists(destinationPath)) {
      throw new Error(
        `Archive destination already exists at ${relative(context.root, destinationPath)}.`,
      );
    }
    const rendered = await renderDocument(
      plan.document.content,
      plan.data as Readonly<Record<string, unknown>>,
    );

    temporaryRoot = await mkdtemp(join(tmpdir(), 'megamono-archive-'));
    const temporaryDocsRoot = resolve(temporaryRoot, docsRoot);
    await mkdir(dirname(temporaryDocsRoot), { recursive: true });
    await cp(absoluteDocsRoot, temporaryDocsRoot, { recursive: true });
    const temporarySource = resolve(
      temporaryDocsRoot,
      plan.document.relativePath,
    );
    const temporaryDestination = resolve(
      temporaryDocsRoot,
      plan.destinationRelativePath,
    );
    await mkdir(dirname(temporaryDestination), { recursive: true });
    await writeFile(temporaryDestination, rendered, 'utf8');
    await unlink(temporarySource);
    const proposed = await validateRepositoryDocs(
      temporaryRoot,
      config,
      docsRoot,
    );
    if (hasErrors(proposed.diagnostics)) {
      const details = proposed.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map(formatDiagnostic)
        .join('\n');
      throw new Error(`Archive plan would invalidate the corpus:\n${details}`);
    }

    logger.info(
      `${options.dryRun ? 'Would move' : 'Move'} ${relative(context.root, sourcePath)} -> ${relative(context.root, destinationPath)}`,
    );
    logger.info(`Set ${plan.data.id} status to ${plan.data.status}.`);
    if (options.dryRun) return { success: true };

    await mkdir(dirname(destinationPath), { recursive: true });
    const stagedPath = `${sourcePath}.megamono-staged`;
    const backupPath = `${sourcePath}.megamono-backup`;
    await writeFile(stagedPath, rendered, 'utf8');
    try {
      await rename(sourcePath, backupPath);
      await rename(stagedPath, destinationPath);
      await unlink(backupPath);
    } catch (error) {
      await rm(stagedPath, { force: true });
      await rm(destinationPath, { force: true });
      try {
        await rename(backupPath, sourcePath);
      } catch {
        // The source rename may not have happened; preserve the original error.
      }
      throw error;
    }

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
  } finally {
    if (temporaryRoot)
      await rm(temporaryRoot, { recursive: true, force: true });
  }
};

export default runExecutor;
