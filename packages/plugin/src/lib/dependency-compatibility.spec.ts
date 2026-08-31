import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { assessDependencyRequirements } from './dependency-compatibility';

describe('dependency compatibility', () => {
  it('distinguishes compatible retention, additions, and conflicts', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({
        dependencies: { zod: '^4.1.12' },
        devDependencies: { eslint: '^7.32.0' },
      }),
    );
    const assessed = assessDependencyRequirements(tree, [
      { name: 'zod', range: '>=4.1 <5', reason: 'schema validation' },
      { name: 'eslint', range: '>=8 <11', reason: 'lint integration' },
      {
        name: '@content-collections/core',
        range: '0.15.2',
        installIfMissing: true,
        reason: 'docs loader',
      },
    ]);

    expect(assessed.map(({ name, action }) => [name, action])).toEqual([
      ['zod', 'retain'],
      ['eslint', 'conflict'],
      ['@content-collections/core', 'add'],
    ]);
  });

  it('refuses ambiguous duplicate declarations and non-semver protocols', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({
        dependencies: { zod: '^4.1.12' },
        devDependencies: { zod: 'file:../zod' },
      }),
    );
    const [assessment] = assessDependencyRequirements(tree, [
      { name: 'zod', range: '>=4.1 <5', reason: 'schema validation' },
    ]);

    expect(assessment.action).toBe('conflict');
    expect(assessment.message).toContain('multiple dependency sections');
  });
});
