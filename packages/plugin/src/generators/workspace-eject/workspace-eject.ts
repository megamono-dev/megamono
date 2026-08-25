import { logger, type Tree } from '@nx/devkit';
import { ejectManagedArtifact } from '../../lib/managed-artifacts';
import type { WorkspaceEjectGeneratorSchema } from './schema';

export async function workspaceEjectGenerator(
  tree: Tree,
  options: WorkspaceEjectGeneratorSchema,
): Promise<void> {
  const plan = ejectManagedArtifact(tree, options.artifact, {
    dryRun: options.dryRun,
  });
  if (plan.state === 'already-ejected') {
    logger.info(`Artifact ${options.artifact} is already repository-owned.`);
    return;
  }
  const action =
    plan.targetAction === 'remove-delimiters'
      ? `remove its ownership delimiters from ${plan.artifact.target}`
      : `preserve ${plan.artifact.target} unchanged`;
  logger.info(
    options.dryRun
      ? `Would ${action} and mark ${options.artifact} ejected.`
      : `Ejected ${options.artifact}: ${action}; content is now repository-owned.`,
  );
}

export default workspaceEjectGenerator;
