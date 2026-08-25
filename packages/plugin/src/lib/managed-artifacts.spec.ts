import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTIFACT_REGISTRY_PATH,
  ArtifactRegistryError,
  computeDiskArtifactHash,
  extractManagedSection,
  hashArtifactBytes,
  hashArtifactFileSet,
  hashArtifactSymlinkTarget,
  inspectManagedArtifacts,
  parseArtifactRegistry,
  readArtifactRegistry,
  renderArtifactRegistry,
  upsertArtifactEntry,
  writeArtifactRegistry,
  type ManagedArtifactEntry,
} from './managed-artifacts';

const HASH = hashArtifactBytes('template');

function artifact(
  overrides: Partial<ManagedArtifactEntry> = {},
): ManagedArtifactEntry {
  return {
    id: 'ci.affected',
    module: 'ci',
    mode: 'managed',
    target: '.github/workflows/megamono-ci.yml',
    sourceVersion: '1.0.0',
    templateHash: HASH,
    installedHash: HASH,
    state: 'managed',
    ejectable: true,
    ...overrides,
  };
}

describe('managed artifacts', () => {
  it('renders a strict, stable, ID-sorted registry', () => {
    const registry = upsertArtifactEntry(
      upsertArtifactEntry(
        { schemaVersion: 1, artifacts: [] },
        artifact({ id: 'health.workflow', module: 'health' }),
      ),
      artifact(),
    );
    const rendered = renderArtifactRegistry(registry);

    expect(rendered.endsWith('\n')).toBe(true);
    expect(
      parseArtifactRegistry(rendered).artifacts.map(({ id }) => id),
    ).toEqual(['ci.affected', 'health.workflow']);
    expect(() =>
      parseArtifactRegistry(
        JSON.stringify({
          schemaVersion: 1,
          artifacts: [artifact({ target: '../outside' })],
        }),
      ),
    ).toThrow(ArtifactRegistryError);
    expect(() =>
      parseArtifactRegistry(
        JSON.stringify({
          schemaVersion: 1,
          artifacts: [artifact({ target: ARTIFACT_REGISTRY_PATH })],
        }),
      ),
    ).toThrow(/cannot own itself/);
  });

  it('requires exact section delimiters and sorted explicit file sets', () => {
    expect(() =>
      parseArtifactRegistry(
        JSON.stringify({
          schemaVersion: 1,
          artifacts: [artifact({ mode: 'managed-section' })],
        }),
      ),
    ).toThrow(/distinct startDelimiter/);
    expect(() =>
      parseArtifactRegistry(
        JSON.stringify({
          schemaVersion: 1,
          artifacts: [
            artifact({
              id: 'skill.test',
              module: 'skills',
              target: '.agents/skills/test',
              files: ['SKILL.md', 'references/a.md'],
            }),
          ],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      parseArtifactRegistry(
        JSON.stringify({
          schemaVersion: 1,
          artifacts: [artifact({ files: ['z.md', 'a.md'] })],
        }),
      ),
    ).toThrow(/lexical order/);
  });

  it('hashes exact bytes, normalized symlinks, sections, and sorted file sets', () => {
    expect(hashArtifactBytes('a')).not.toBe(hashArtifactBytes('a\n'));
    expect(hashArtifactSymlinkTarget('docs/../AGENTS.md')).toBe(
      hashArtifactSymlinkTarget('AGENTS.md'),
    );
    expect(hashArtifactFileSet({ 'b.md': 'two', 'a.md': 'one' })).toBe(
      hashArtifactFileSet({ 'a.md': 'one', 'b.md': 'two' }),
    );
    expect(
      extractManagedSection('before<start>body<end>after', '<start>', '<end>'),
    ).toBe('body');
    expect(
      extractManagedSection(
        '<start>one<end><start>two<end>',
        '<start>',
        '<end>',
      ),
    ).toBeUndefined();
  });

  it('reads and writes registries through an Nx tree', () => {
    const tree = createTreeWithEmptyWorkspace();
    expect(readArtifactRegistry(tree)).toEqual({
      schemaVersion: 1,
      artifacts: [],
    });
    writeArtifactRegistry(tree, {
      schemaVersion: 1,
      artifacts: [artifact()],
    });
    expect(readArtifactRegistry(tree).artifacts[0].id).toBe('ci.affected');
  });

  it('inspects files, symlinks, sections, and explicit file sets on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-artifacts-'));
    try {
      await mkdir(join(root, 'skills', 'review'), { recursive: true });
      await writeFile(join(root, 'managed.txt'), 'managed');
      await writeFile(
        join(root, 'section.md'),
        'before\n<!-- start -->owned\n<!-- end -->\nafter\n',
      );
      await writeFile(join(root, 'skills', 'review', 'SKILL.md'), 'skill');
      await writeFile(join(root, 'target.md'), 'target');
      await symlink('target.md', join(root, 'pointer.md'));
      const entries: ManagedArtifactEntry[] = [
        artifact({
          id: 'agents.claude-pointer',
          module: 'agents',
          target: 'pointer.md',
          installedHash: hashArtifactSymlinkTarget('target.md'),
        }),
        artifact({
          id: 'agents.instructions',
          module: 'agents',
          mode: 'managed-section',
          target: 'section.md',
          startDelimiter: '<!-- start -->',
          endDelimiter: '<!-- end -->',
          installedHash: hashArtifactBytes('owned\n'),
        }),
        artifact({
          id: 'ci.affected',
          target: 'managed.txt',
          installedHash: hashArtifactBytes('managed'),
        }),
        artifact({
          id: 'skill.review',
          module: 'skills',
          target: 'skills/review',
          files: ['SKILL.md'],
          installedHash: hashArtifactFileSet({ 'SKILL.md': 'skill' }),
        }),
      ];

      expect(
        entries.map((entry) => computeDiskArtifactHash(root, entry)),
      ).toEqual(entries.map(({ installedHash }) => installedHash));
      expect(
        inspectManagedArtifacts(root, {
          schemaVersion: 1,
          artifacts: entries,
        }).map(({ state }) => state),
      ).toEqual(['current', 'current', 'current', 'current']);
      await writeFile(join(root, 'managed.txt'), 'repository edit');
      expect(
        inspectManagedArtifacts(root, {
          schemaVersion: 1,
          artifacts: [entries[2]],
        })[0].state,
      ).toBe('modified');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
