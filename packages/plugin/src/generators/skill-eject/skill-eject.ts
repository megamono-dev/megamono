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
  const provenance = `.agents/skills/${options.name}/.megamono-skill.json`;
  const entrypoint = `.agents/skills/${options.name}/SKILL.md`;
  if (!tree.exists(entrypoint)) {
    throw new Error(`Managed skill ${options.name} is not installed.`);
  }
  if (!tree.exists(provenance)) {
    logger.info(`Skill ${options.name} is already repository-owned.`);
    return;
  }
  if (options.dryRun) {
    logger.info(`Would remove ${provenance}; skill files remain unchanged.`);
    return;
  }
  ejectManagedSkill(tree, options.name);
  logger.info(`Removed ${provenance}; skill files are now repository-owned.`);
}

export default skillEjectGenerator;
