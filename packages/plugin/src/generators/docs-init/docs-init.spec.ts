import { readJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { docsInitGenerator } from './docs-init';

describe('docs-init generator', () => {
  it.each(['docs', 'handbook'])(
    'seeds a repository-owned design handoff under %s without replacing assets',
    async (docsRoot) => {
      const tree = createTreeWithEmptyWorkspace();
      await docsInitGenerator(tree, { yes: true, docsRoot });
      for (const path of [
        'README.md',
        'manifest.md',
        'boards/.gitkeep',
        'screenshots/.gitkeep',
      ]) {
        expect(tree.exists(`${docsRoot}/design/${path}`)).toBe(true);
      }
      expect(tree.exists(`${docsRoot}/design/tokens.json`)).toBe(false);
      expect(tree.read('AGENTS.md', 'utf8')).toContain(`${docsRoot}/design/`);
      expect(readJson(tree, '.megamono/artifacts.json').artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'docs.design-readme',
            mode: 'seeded',
            target: `${docsRoot}/design/README.md`,
          }),
        ]),
      );
      const assets = {
        'README.md': '# Our handoff\n',
        'manifest.md': '# Our mapping\n',
        'tokens.json': '{"color":"owned"}\n',
        'boards/.gitkeep': 'owned placeholder\n',
        'boards/sign-in.html': '<main>Owned board</main>\n',
        'screenshots/sign-in.png': Buffer.from([137, 80, 78, 71, 0, 255]),
      };
      for (const [path, bytes] of Object.entries(assets))
        tree.write(`${docsRoot}/design/${path}`, bytes);
      await docsInitGenerator(tree, { yes: true, docsRoot });
      for (const [path, bytes] of Object.entries(assets)) {
        expect(tree.read(`${docsRoot}/design/${path}`)).toEqual(
          Buffer.from(bytes),
        );
      }
    },
  );

  it('does not claim an existing design handoff on adoption', async () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('docs/design/README.md', '# Existing handoff\n');
    await docsInitGenerator(tree, { yes: true });
    expect(tree.read('docs/design/README.md', 'utf8')).toBe(
      '# Existing handoff\n',
    );
    expect(
      readJson(tree, '.megamono/artifacts.json').artifacts.some(
        (entry: { id: string }) => entry.id === 'docs.design-readme',
      ),
    ).toBe(false);
  });

  it('reuses only the docs, agents, and skills module primitives', async () => {
    const tree = createTreeWithEmptyWorkspace();

    await docsInitGenerator(tree, { yes: true });

    expect(tree.exists('content-collections.ts')).toBe(true);
    expect(tree.exists('docs/project.json')).toBe(true);
    expect(tree.exists('AGENTS.md')).toBe(true);
    expect(tree.exists('CLAUDE.md')).toBe(true);
    expect(tree.exists('.agents/skills/structure-review/SKILL.md')).toBe(true);
    expect(tree.exists('eslint.config.mjs')).toBe(false);
    expect(tree.exists('.github/workflows/megamono-ci.yml')).toBe(false);
    expect(tree.exists('.github/workflows/megamono-health.yml')).toBe(false);
    expect(readJson(tree, 'megamono.json').adoption.modules).toEqual([
      'docs',
      'agents',
      'skills',
    ]);
  });
});
