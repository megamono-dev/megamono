import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectManagedArtifacts,
  parseArtifactRegistry,
  renderArtifactRegistry,
} from './managed-artifacts';
import {
  ensureManagedSkillsProjection,
  SKILLS_PROJECTION_ARTIFACT_ID,
} from './skills-projection';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'megamono-skills-projection-'));
  await mkdir(join(root, '.megamono'));
  await mkdir(join(root, '.agents/skills'), { recursive: true });
  await writeFile(
    join(root, '.megamono/artifacts.json'),
    renderArtifactRegistry({ schemaVersion: 1, artifacts: [] }),
  );
  return root;
}

describe('managed skills projection', () => {
  it('creates and registers the projection as a managed symlink', async () => {
    const root = await fixture();
    expect(ensureManagedSkillsProjection(root, '1.2.3')).toMatchObject({
      state: 'installed',
    });
    expect(await readlink(join(root, '.claude/skills'))).toBe(
      '../.agents/skills',
    );
    const registry = parseArtifactRegistry(
      await readFile(join(root, '.megamono/artifacts.json'), 'utf8'),
    );
    expect(registry.artifacts).toContainEqual(
      expect.objectContaining({
        id: SKILLS_PROJECTION_ARTIFACT_ID,
        mode: 'managed',
        target: '.claude/skills',
        ejectable: true,
      }),
    );
    expect(inspectManagedArtifacts(root, registry)).toContainEqual(
      expect.objectContaining({ state: 'current' }),
    );
  });

  it('does not claim a repository-owned projection', async () => {
    const root = await fixture();
    await mkdir(join(root, '.claude'));
    const { symlink } = await import('node:fs/promises');
    await symlink('../.agents/skills', join(root, '.claude/skills'), 'dir');

    expect(ensureManagedSkillsProjection(root, '1.2.3')).toMatchObject({
      state: 'unmanaged',
    });
    const registry = parseArtifactRegistry(
      await readFile(join(root, '.megamono/artifacts.json'), 'utf8'),
    );
    expect(registry.artifacts).toEqual([]);
  });
});
