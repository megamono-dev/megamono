import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { planIntegrationVerification } from './integration-verification';

const requirement = '@playstack/auth:nest-auth:refresh-reuse';
const projects = new Map([
  [
    'api',
    {
      root: 'apps/api',
      targets: {
        test: {
          executor: 'nx:run-commands',
          options: { command: 'node --test' },
        },
      },
    },
  ],
]);
const options = {
  verificationProject: 'api',
  verification: JSON.stringify({ [requirement]: 'api:test' }),
};

describe('reviewed integration verification', () => {
  it('plans a target and appends a bounded CI step, preserving existing jobs and comments', () => {
    const tree = createTreeWithEmptyWorkspace();
    const path = '.github/workflows/ci.yml';
    const content = `# application-owned CI\nname: CI\non: [push]\njobs:\n  quality:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n  release:\n    runs-on: macos-latest\n    steps:\n      - run: ./sign-and-release.sh\n`;
    tree.write(path, content);
    const before = tree.listChanges();
    const plan = planIntegrationVerification(tree, projects, [requirement], {
      ...options,
      ciWorkflow: path,
      ciJob: 'quality',
    })!;
    expect(tree.listChanges()).toEqual(before);
    expect(plan.configuration.dependsOn).toEqual([
      { projects: ['api'], target: 'test' },
    ]);
    const updated = parse(plan.workflow!.content);
    expect(updated.jobs.release).toEqual(parse(content).jobs.release);
    expect(updated.jobs.quality.steps.slice(0, 2)).toEqual(
      parse(content).jobs.quality.steps,
    );
    expect(plan.workflow!.content).toContain('# application-owned CI');
    expect(updated.jobs.quality.steps[2].run).toContain(
      "require.resolve('nx/package.json')",
    );
    tree.write(path, plan.workflow!.content);
    expect(
      planIntegrationVerification(tree, projects, [requirement], {
        ...options,
        ciWorkflow: path,
        ciJob: 'quality',
      })?.workflow?.content,
    ).toBe(plan.workflow!.content);
  });

  it.each([
    {},
    { [requirement]: 'api:missing' },
    { [requirement]: 'npm test; echo unsafe' },
    { [requirement]: 'api:playstack-verify' },
    { [requirement]: 'api:test', unknown: 'api:test' },
  ])('rejects incomplete, unsafe or unknown target mappings: %j', (mapping) => {
    expect(() =>
      planIntegrationVerification(
        createTreeWithEmptyWorkspace(),
        projects,
        [requirement],
        { ...options, verification: JSON.stringify(mapping) },
      ),
    ).toThrow();
  });

  it('refuses existing target ownership and missing or reusable CI jobs', () => {
    const tree = createTreeWithEmptyWorkspace();
    const occupied = new Map([
      [
        'api',
        {
          root: 'apps/api',
          targets: {
            test: {},
            'playstack-verify': { executor: 'custom:test' },
          },
        },
      ],
    ]);
    expect(() =>
      planIntegrationVerification(tree, occupied, [requirement], options),
    ).toThrow('already exists');
    tree.write(
      '.github/workflows/ci.yml',
      'jobs:\n  quality:\n    uses: org/repo/.github/workflows/reusable.yml@main\n',
    );
    expect(() =>
      planIntegrationVerification(tree, projects, [requirement], {
        ...options,
        ciWorkflow: '.github/workflows/ci.yml',
        ciJob: 'quality',
      }),
    ).toThrow('explicit steps');
    expect(() =>
      planIntegrationVerification(tree, projects, [requirement], {
        ...options,
        ciWorkflow: '.github/workflows/missing.yml',
        ciJob: 'quality',
      }),
    ).toThrow('does not exist');
  });
});
