import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyManagedSkillTemplates,
  ejectManagedSkill,
  hashManagedSkillFiles,
  loadManagedSkillTemplates,
  MANAGED_SKILL_NAMES,
  validateInstalledSkills,
} from './managed-skills';

describe('managed skills', () => {
  it('loads unique portable templates with trigger fixtures', () => {
    const templates = loadManagedSkillTemplates();

    expect(templates.map(({ name }) => name)).toEqual(MANAGED_SKILL_NAMES);
    for (const template of templates) {
      expect(template.description.length).toBeGreaterThan(20);
      expect(template.files['SKILL.md']).toContain(`name: ${template.name}`);
      expect(template.positivePrompts).toHaveLength(5);
      expect(template.negativePrompts).toHaveLength(5);
      expect(template.templateHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it('updates only pristine managed templates', () => {
    const tree = createTreeWithEmptyWorkspace();
    const original = loadManagedSkillTemplates()[0];
    const installed = applyManagedSkillTemplates(tree, [original], '1.0.0');
    expect(installed).toContainEqual(
      expect.objectContaining({ name: original.name, state: 'installed' }),
    );

    const changedFiles = {
      ...original.files,
      'SKILL.md': `${original.files['SKILL.md']}\nManaged update.\n`,
    };
    const changed = {
      ...original,
      files: changedFiles,
      templateHash: hashManagedSkillFiles(changedFiles),
    };
    expect(applyManagedSkillTemplates(tree, [changed], '1.1.0')).toContainEqual(
      expect.objectContaining({ name: original.name, state: 'updated' }),
    );
    expect(
      tree.read(`.agents/skills/${original.name}/SKILL.md`, 'utf8'),
    ).toContain('Managed update.');

    tree.write(
      `.agents/skills/${original.name}/SKILL.md`,
      `${tree.read(`.agents/skills/${original.name}/SKILL.md`, 'utf8')}Repository edit.\n`,
    );
    const source = tree.read(
      `.agents/skills/${original.name}/SKILL.md`,
      'utf8',
    );
    expect(
      applyManagedSkillTemplates(tree, [original], '1.2.0'),
    ).toContainEqual(
      expect.objectContaining({ name: original.name, state: 'modified' }),
    );
    expect(tree.read(`.agents/skills/${original.name}/SKILL.md`, 'utf8')).toBe(
      source,
    );
  });

  it('ejects by removing provenance and never reclaims the skill', () => {
    const tree = createTreeWithEmptyWorkspace();
    const template = loadManagedSkillTemplates()[1];
    applyManagedSkillTemplates(tree, [template], '1.0.0');

    expect(ejectManagedSkill(tree, template.name)).toBe('ejected');
    expect(
      tree.exists(`.agents/skills/${template.name}/.megamono-skill.json`),
    ).toBe(false);
    expect(tree.exists(`.agents/skills/${template.name}/SKILL.md`)).toBe(true);
    expect(
      applyManagedSkillTemplates(tree, [template], '2.0.0'),
    ).toContainEqual(
      expect.objectContaining({ name: template.name, state: 'ejected' }),
    );
    expect(ejectManagedSkill(tree, template.name)).toBe('already-ejected');
  });

  it('validates installed frontmatter and unique skill names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-skills-'));
    try {
      for (const directory of ['alpha', 'beta']) {
        await mkdir(join(root, '.agents', 'skills', directory), {
          recursive: true,
        });
      }
      await writeFile(
        join(root, '.agents', 'skills', 'alpha', 'SKILL.md'),
        '---\nname: alpha\ndescription: Handles alpha work.\n---\n',
      );
      await writeFile(
        join(root, '.agents', 'skills', 'beta', 'SKILL.md'),
        '---\nname: alpha\ndescription: Handles duplicate work.\n---\n',
      );

      expect(validateInstalledSkills(root)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'skill-name' }),
          expect.objectContaining({ code: 'skill-duplicate-name' }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
