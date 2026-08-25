import { logger, type Tree } from '@nx/devkit';
import {
  ejectManagedSkill,
  MANAGED_SKILL_NAMES,
  type ManagedSkillName,
} from '../../lib/managed-skills';
import type { SkillEjectGeneratorSchema } from './schema';

export async function skillEjectGenerator(
  tree: Tree,
  options: SkillEjectGeneratorSchema,
): Promise<void> {
  if (!MANAGED_SKILL_NAMES.includes(options.name as ManagedSkillName)) {
    throw new Error(`Unknown managed skill ${options.name}.`);
  }
  const entrypoint = `.agents/skills/${options.name}/SKILL.md`;
  if (!tree.exists(entrypoint)) {
    throw new Error(`Managed skill ${options.name} is not installed.`);
  }
  const result = ejectManagedSkill(tree, options.name, {
    dryRun: options.dryRun,
  });
  if (result === 'already-ejected') {
    logger.info(`Skill ${options.name} is already repository-owned.`);
  } else {
    logger.info(
      options.dryRun
        ? `Would mark skill.${options.name} ejected; skill files remain unchanged.`
        : `Marked skill.${options.name} ejected; skill files are now repository-owned.`,
    );
  }
}

export default skillEjectGenerator;
