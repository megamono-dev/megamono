import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import {
  hashArtifactBytes,
  readArtifactRegistry,
  writeArtifactRegistry,
  type ManagedArtifactEntry,
} from '../../lib/managed-artifacts';
import { workspaceEjectGenerator } from './workspace-eject';

const SECTION_START = '<!-- megamono affected start -->';
const SECTION_END = '<!-- megamono affected end -->';

function installArtifact(
  target: string,
  overrides: Partial<ManagedArtifactEntry> = {},
) {
  const body = '\nManaged instructions.\n';
  const artifact: ManagedArtifactEntry = {
    id: 'agents.instructions',
    module: 'agents',
    mode: 'managed-section',
    target,
    sourceVersion: '1.0.0',
    templateHash: hashArtifactBytes(body),
    installedHash: hashArtifactBytes(body),
    state: 'managed',
    ejectable: true,
    startDelimiter: SECTION_START,
    endDelimiter: SECTION_END,
    ...overrides,
  };
  return { artifact, body };
}

describe('workspace-eject generator', () => {
  it('previews without mutation, then retains a managed section body', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const before = 'Repository instructions.\n';
    const after = '\nRepository footer.\n';
    const { artifact, body } = installArtifact('AGENTS.md');
    tree.write(
      'AGENTS.md',
      `${before}${SECTION_START}${body}${SECTION_END}${after}`,
    );
    writeArtifactRegistry(tree, { schemaVersion: 1, artifacts: [artifact] });
    const original = tree.read('AGENTS.md', 'utf8');
    const originalRegistry = tree.read('.megamono/artifacts.json', 'utf8');

    await workspaceEjectGenerator(tree, {
      artifact: artifact.id,
      dryRun: true,
    });
    expect(tree.read('AGENTS.md', 'utf8')).toBe(original);
    expect(tree.read('.megamono/artifacts.json', 'utf8')).toBe(
      originalRegistry,
    );

    await workspaceEjectGenerator(tree, { artifact: artifact.id });
    expect(tree.read('AGENTS.md', 'utf8')).toBe(`${before}${body}${after}`);
    expect(readArtifactRegistry(tree).artifacts[0].state).toBe('ejected');

    const changes = tree.listChanges();
    await workspaceEjectGenerator(tree, { artifact: artifact.id });
    expect(tree.listChanges()).toEqual(changes);
  });

  it('keeps whole files and managed file sets byte-for-byte unchanged', async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('workflow.yml', 'repository-modified workflow\n');
    tree.write('.agents/skills/review/SKILL.md', 'repository-modified skill\n');
    const workflow = installArtifact('workflow.yml', {
      id: 'ci.affected',
      module: 'ci',
      mode: 'managed',
      startDelimiter: undefined,
      endDelimiter: undefined,
    }).artifact;
    const skill = installArtifact('.agents/skills/review', {
      id: 'skill.review',
      module: 'skills',
      mode: 'managed',
      startDelimiter: undefined,
      endDelimiter: undefined,
      files: ['SKILL.md'],
    }).artifact;
    writeArtifactRegistry(tree, {
      schemaVersion: 1,
      artifacts: [workflow, skill],
    });

    await workspaceEjectGenerator(tree, { artifact: workflow.id });
    await workspaceEjectGenerator(tree, { artifact: skill.id });
    expect(tree.read('workflow.yml', 'utf8')).toBe(
      'repository-modified workflow\n',
    );
    expect(tree.read('.agents/skills/review/SKILL.md', 'utf8')).toBe(
      'repository-modified skill\n',
    );
    expect(
      readArtifactRegistry(tree).artifacts.map(({ state }) => state),
    ).toEqual(['ejected', 'ejected']);
  });

  it('refuses unknown, non-ejectable, and malformed sections before mutation', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const { artifact } = installArtifact('AGENTS.md');
    tree.write('AGENTS.md', 'Repository instructions without delimiters.\n');
    writeArtifactRegistry(tree, { schemaVersion: 1, artifacts: [artifact] });
    const changes = tree.listChanges();

    await expect(
      workspaceEjectGenerator(tree, { artifact: 'ci.affected' }),
    ).rejects.toThrow(/Unknown managed artifact/);
    await expect(
      workspaceEjectGenerator(tree, { artifact: artifact.id }),
    ).rejects.toThrow(/does not contain its exact delimiters/);
    expect(tree.listChanges()).toEqual(changes);

    writeArtifactRegistry(tree, {
      schemaVersion: 1,
      artifacts: [{ ...artifact, ejectable: false }],
    });
    await expect(
      workspaceEjectGenerator(tree, { artifact: artifact.id }),
    ).rejects.toThrow(/is not ejectable/);
  });
});
