import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { createHash } from 'node:crypto';
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
import { readArtifactRegistry } from './managed-artifacts';

function legacyHash(files: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256');
  for (const [path, content] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(path);
    hash.update('\0');
    hash.update(String(Buffer.byteLength(content)));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

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
    expect(
      readArtifactRegistry(tree).artifacts.find(
        ({ id }) => id === `skill.${original.name}`,
      ),
    ).toMatchObject({ mode: 'managed', module: 'skills' });
    expect(
      tree.exists(`.agents/skills/${original.name}/.megamono-skill.json`),
    ).toBe(false);

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

  it('ejects through the artifact registry and never reclaims the skill', () => {
    const tree = createTreeWithEmptyWorkspace();
    const template = loadManagedSkillTemplates()[1];
    applyManagedSkillTemplates(tree, [template], '1.0.0');

    expect(ejectManagedSkill(tree, template.name)).toBe('ejected');
    expect(
      readArtifactRegistry(tree).artifacts.find(
        ({ id }) => id === `skill.${template.name}`,
      )?.state,
    ).toBe('ejected');
    expect(tree.exists(`.agents/skills/${template.name}/SKILL.md`)).toBe(true);
    expect(
      applyManagedSkillTemplates(tree, [template], '2.0.0'),
    ).toContainEqual(
      expect.objectContaining({ name: template.name, state: 'ejected' }),
    );
    expect(ejectManagedSkill(tree, template.name)).toBe('already-ejected');
  });

  it('migrates only valid legacy sidecars without changing skill content', () => {
    const tree = createTreeWithEmptyWorkspace();
    const template = loadManagedSkillTemplates()[2];
    const directory = `.agents/skills/${template.name}`;
    for (const [path, content] of Object.entries(template.files)) {
      tree.write(`${directory}/${path}`, content);
    }
    const legacyPath = `${directory}/.megamono-skill.json`;
    tree.write(
      legacyPath,
      JSON.stringify({
        schemaVersion: 1,
        name: template.name,
        pluginVersion: '0.0.1-beta.1',
        templateHash: legacyHash(template.files),
        files: Object.keys(template.files).sort(),
      }),
    );
    const entrypoint = tree.read(`${directory}/SKILL.md`, 'utf8');

    expect(
      applyManagedSkillTemplates(tree, [template], '1.0.0'),
    ).toContainEqual(
      expect.objectContaining({ name: template.name, state: 'migrated' }),
    );
    expect(tree.read(`${directory}/SKILL.md`, 'utf8')).toBe(entrypoint);
    expect(tree.exists(legacyPath)).toBe(false);
    expect(readArtifactRegistry(tree).artifacts[0]).toMatchObject({
      id: `skill.${template.name}`,
      sourceVersion: '0.0.1-beta.1',
      state: 'managed',
    });
  });

  it('preserves invalid legacy provenance for explicit repair', () => {
    const tree = createTreeWithEmptyWorkspace();
    const template = loadManagedSkillTemplates()[3];
    const directory = `.agents/skills/${template.name}`;
    tree.write(`${directory}/SKILL.md`, template.files['SKILL.md']);
    const legacyPath = `${directory}/.megamono-skill.json`;
    tree.write(legacyPath, '{"schemaVersion":1,"name":"wrong"}');

    expect(
      applyManagedSkillTemplates(tree, [template], '1.0.0'),
    ).toContainEqual(
      expect.objectContaining({
        name: template.name,
        state: 'invalid-provenance',
      }),
    );
    expect(tree.exists(legacyPath)).toBe(true);
    expect(readArtifactRegistry(tree).artifacts).toEqual([]);
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
