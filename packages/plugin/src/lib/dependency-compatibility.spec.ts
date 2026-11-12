import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { workspaceInitGenerator } from '../generators/workspace-init/workspace-init';
import {
  assessDependencyRequirements,
  workspaceInitDependencyRequirements,
} from './dependency-compatibility';

describe('dependency compatibility', () => {
  it('blocks incompatible existing Zod declarations before documentation adoption writes files', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const source = JSON.stringify({
      name: '@fixture/source',
      dependencies: { zod: '>=4.1 <5' },
    });
    tree.write('package.json', source);
    const before = tree.listChanges();
    await expect(
      workspaceInitGenerator(tree, { only: 'docs', yes: true }),
    ).rejects.toThrow('zod');
    expect(tree.read('package.json', 'utf8')).toBe(source);
    expect(tree.listChanges()).toEqual(before);
  });
  it.each([
    ['>=4.1 <5', 'conflict'],
    ['^4.1.12', 'conflict'],
    ['4.4.3', 'conflict'],
    ['^4.6.5', 'retain'],
    ['>=4.6.5 <5', 'retain'],
    ['4.6.7', 'retain'],
  ])(
    'requires the complete generated Zod declaration %s to be compatible: %s',
    (version, action) => {
      const tree = createTreeWithEmptyWorkspace();
      const source = JSON.stringify({ dependencies: { zod: version } });
      tree.write('package.json', source);
      const [assessment] = assessDependencyRequirements(
        tree,
        workspaceInitDependencyRequirements(new Set(['docs'])).filter(
          (item) => item.name === 'zod',
        ),
      );
      expect(assessment.action).toBe(action);
      expect(assessment.range).toBe('^4.6.5');
      expect(tree.read('package.json', 'utf8')).toBe(source);
      if (action === 'conflict')
        expect(assessment.message).toContain(
          'Review and update the declaration explicitly',
        );
    },
  );
  it('adds the shared Zod floor when missing without mutating declarations during assessment', () => {
    const tree = createTreeWithEmptyWorkspace();
    const [assessment] = assessDependencyRequirements(
      tree,
      workspaceInitDependencyRequirements(new Set(['docs'])).filter(
        (item) => item.name === 'zod',
      ),
    );
    expect(assessment).toMatchObject({
      range: '^4.6.5',
      action: 'add',
      requireFullRange: true,
    });
  });
  it.each([
    ['24.0.4', 'retain'],
    ['25.0.0', 'conflict'],
  ])('assesses the Nx %s adoption boundary as %s', (nx, action) => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({ devDependencies: { nx, typescript: '6.0.3' } }),
    );
    const assessed = assessDependencyRequirements(
      tree,
      workspaceInitDependencyRequirements(new Set()),
    );
    expect(
      assessed.find((dependency) => dependency.name === 'nx')?.action,
    ).toBe(action);
  });

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
        range: '0.15.3',
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
