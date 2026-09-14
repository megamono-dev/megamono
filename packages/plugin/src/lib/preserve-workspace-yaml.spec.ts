import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { preserveWorkspaceYaml } from './preserve-workspace-yaml';

const original = `# Workspace policy\npackages:\n  - 'apps/*' # application owners\n  - 'libs/*'\n# Review build scripts individually\nallowBuilds:\n  prisma: true # qualified engine\n  untrusted: false\noverrides:\n  '@example/core': 'file:./vendor/core.tgz' # reviewed archive\nstoreDir: /custom/store # machine setting retained\n`;

describe('pnpm workspace YAML preservation', () => {
  it('retains comments and existing values while applying additions and policy changes', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('pnpm-workspace.yaml', original);
    const restore = preserveWorkspaceYaml(tree);
    const value = parse(original);
    value.packages.push('packages/*');
    value.allowBuilds.untrusted = true;
    value.allowBuilds['@prisma/engines'] = true;
    tree.write('pnpm-workspace.yaml', stringify(value));
    restore();
    const result = tree.read('pnpm-workspace.yaml', 'utf8') ?? '';
    expect(parse(result)).toEqual(value);
    for (const comment of [
      'Workspace policy',
      'application owners',
      'Review build scripts individually',
      'qualified engine',
      'reviewed archive',
      'machine setting retained',
    ])
      expect(result).toContain(`# ${comment}`);
  });
  it('restores byte-identical content after a formatting-only rewrite', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('pnpm-workspace.yaml', original);
    const restore = preserveWorkspaceYaml(tree);
    tree.write('pnpm-workspace.yaml', stringify(parse(original)));
    restore();
    expect(tree.read('pnpm-workspace.yaml', 'utf8')).toBe(original);
  });
  it('rejects invalid input before generation and preserves semantic deletions', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('pnpm-workspace.yaml', 'packages: [');
    expect(() => preserveWorkspaceYaml(tree)).toThrow('valid YAML');
    tree.write('pnpm-workspace.yaml', original);
    const restore = preserveWorkspaceYaml(tree);
    const value = parse(original);
    delete value.allowBuilds.untrusted;
    value.packages.shift();
    tree.write('pnpm-workspace.yaml', stringify(value));
    restore();
    expect(parse(tree.read('pnpm-workspace.yaml', 'utf8') ?? '')).toEqual(
      value,
    );
  });
});
