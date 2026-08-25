import { logger, type PromiseExecutor } from '@nx/devkit';
import { readMegamonoConfig } from '../../lib/config';
import {
  formatDiagnostic,
  hasErrors,
  type Diagnostic,
} from '../../lib/diagnostics';
import { validateRepositoryDocs } from '../../lib/docs';
import { checkWorkspaceStructure } from '../../lib/structural-check';
import { checkProjectPreflights } from '../../lib/project-preflight';
import { validateInstalledSkills } from '../../lib/managed-skills';
import { validateManagedArtifactRegistry } from '../../lib/managed-artifacts';
import type { CheckExecutorSchema } from './schema';

const runExecutor: PromiseExecutor<CheckExecutorSchema> = async (
  options,
  context,
) => {
  try {
    const config = await readMegamonoConfig(
      context.root,
      options.config ?? 'megamono.json',
    );
    const diagnostics: Diagnostic[] = [];
    const acceptedDecisions = new Set<string>();
    if (!options.skipDocs) {
      const docs = await validateRepositoryDocs(
        context.root,
        config,
        options.docsRoot,
      );
      diagnostics.push(...docs.diagnostics);
      for (const document of docs.documents) {
        if (
          document.data.type === 'decision' &&
          document.data.status === 'accepted'
        ) {
          acceptedDecisions.add(document.data.id);
        }
      }
    }
    diagnostics.push(
      ...(await checkWorkspaceStructure(
        context.root,
        context.projectGraph,
        config,
        acceptedDecisions,
      )),
    );
    diagnostics.push(...(await checkProjectPreflights(context.projectGraph)));
    diagnostics.push(...validateInstalledSkills(context.root));
    diagnostics.push(...validateManagedArtifactRegistry(context.root));
    for (const diagnostic of diagnostics) {
      const message = formatDiagnostic(diagnostic);
      if (diagnostic.severity === 'error') logger.error(message);
      else logger.warn(message);
    }
    if (hasErrors(diagnostics)) return { success: false };
    if (options.verbose) logger.info('Megamono structural checks passed.');
    return { success: true };
  } catch (error) {
    logger.error((error as Error).message);
    return { success: false };
  }
};

export default runExecutor;
