import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  applyManagedSkillTemplates,
  loadManagedSkillTemplates,
} from '../../lib/managed-skills';
import { readArtifactRegistry } from '../../lib/managed-artifacts';
import { skillEjectGenerator } from './skill-eject';

describe('skill-eject generator', () => {
  it('supports dry-run, execution, and idempotent reruns', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const template = loadManagedSkillTemplates()[0];
    applyManagedSkillTemplates(tree, [template], '1.0.0');

    await skillEjectGenerator(tree, { name: template.name, dryRun: true });
    expect(readArtifactRegistry(tree).artifacts[0].state).toBe('managed');

    await skillEjectGenerator(tree, { name: template.name });
    expect(readArtifactRegistry(tree).artifacts[0].state).toBe('ejected');
    expect(tree.exists(`.agents/skills/${template.name}/SKILL.md`)).toBe(true);

    await skillEjectGenerator(tree, { name: template.name });
    expect(readArtifactRegistry(tree).artifacts[0].state).toBe('ejected');
  });

  it('refuses a missing skill before mutation', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const changes = tree.listChanges();
    await expect(
      skillEjectGenerator(tree, { name: 'dependency-review' }),
    ).rejects.toThrow('is not installed');
    expect(tree.listChanges()).toEqual(changes);
  });
});
