import type { ManagedSkillName } from '../../lib/managed-skills';

export interface SkillEjectGeneratorSchema {
  readonly name: ManagedSkillName;
  readonly dryRun?: boolean;
}
