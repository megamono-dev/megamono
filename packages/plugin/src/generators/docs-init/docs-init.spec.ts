import { readJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { docsInitGenerator } from './docs-init';

describe('docs-init generator', () => {
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
