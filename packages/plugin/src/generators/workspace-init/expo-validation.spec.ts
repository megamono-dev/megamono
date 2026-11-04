import {
  addProjectConfiguration,
  readJson,
  readProjectConfiguration,
} from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { workspaceInitGenerator } from './workspace-init';
import { createWorkspaceInitPlan } from '../../lib/workspace-init-plan';

function workspace() {
  const tree = createTreeWithEmptyWorkspace();
  tree.write(
    'apps/mobile/package.json',
    '{"dependencies":{"expo":"~54.0.38","react":"19.1.0"}}',
  );
  tree.write(
    'apps/mobile/app.json',
    '{"expo":{"name":"Mobile","slug":"mobile"}}',
  );
  tree.write(
    'apps/mobile/metro.config.js',
    "module.exports=require('expo/metro-config').getDefaultConfig(__dirname);\n",
  );
  addProjectConfiguration(tree, 'mobile', {
    root: 'apps/mobile',
    projectType: 'application',
    targets: { build: { command: 'eas build', dependsOn: ['^build'] } },
  });
  return tree;
}

describe('Expo CI adoption', () => {
  it('previews Doctor and build prerequisites, preserves app ownership and never adds an implicit tool version', async () => {
    const tree = workspace();
    const before = tree.listChanges();
    const plan = createWorkspaceInitPlan(tree, { only: 'ci', yes: true });
    expect(tree.listChanges()).toEqual(before);
    expect(
      plan.operations.some(
        (operation) => operation.target === 'apps/mobile#targets.expo-doctor',
      ),
    ).toBe(true);
    const metro = tree.read('apps/mobile/metro.config.js', 'utf8');
    const app = tree.read('apps/mobile/package.json', 'utf8');
    await workspaceInitGenerator(tree, { only: 'ci', yes: true });
    const project = readProjectConfiguration(tree, 'mobile');
    expect(project.targets?.['expo-doctor']).toEqual({
      executor: '@megamono/plugin:expo-doctor',
      cache: false,
    });
    expect(project.targets?.build).toMatchObject({
      command: 'eas build',
      dependsOn: ['^build', 'expo-doctor'],
    });
    expect(tree.read('apps/mobile/metro.config.js', 'utf8')).toBe(metro);
    expect(readJson(tree, 'apps/mobile/package.json')).toEqual(
      JSON.parse(app ?? '{}'),
    );
    expect(
      readJson(tree, 'package.json').devDependencies?.['expo-doctor'],
    ).toBeUndefined();
    const workflow =
      tree.read('.github/workflows/megamono-ci.yml', 'utf8') ?? '';
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('nrwl/nx-set-shas@v5');
    expect(workflow.indexOf('affected -t expo-doctor')).toBeLessThan(
      workflow.indexOf('affected -t lint test build'),
    );
    const once = tree.read('apps/mobile/project.json', 'utf8');
    await workspaceInitGenerator(tree, { only: 'ci', yes: true });
    expect(tree.read('apps/mobile/project.json', 'utf8')).toBe(once);
  });

  it('does not wire build checks for health-only adoption', async () => {
    const tree = workspace();
    await workspaceInitGenerator(tree, { only: 'health', yes: true });
    expect(
      readProjectConfiguration(tree, 'mobile').targets?.['expo-doctor'],
    ).toBeUndefined();
  });

  it('includes resolved scoped inference in the preview and its cycle conflicts', () => {
    const tree = workspace();
    const project = readProjectConfiguration(tree, 'mobile');
    project.targets = {};
    tree.write('apps/mobile/project.json', JSON.stringify(project));
    tree.write(
      'nx.json',
      JSON.stringify({
        plugins: [{ plugin: '@nx/expo/plugin', include: ['apps/mobile/**'] }],
      }),
    );
    const resolvedExpoProjects = {
      mobile: {
        ...project,
        targets: { bundle: { command: 'expo export', dependsOn: ['^bundle'] } },
      },
    };
    const plan = createWorkspaceInitPlan(tree, {
      only: 'ci',
      resolvedExpoProjects,
    });
    expect(
      plan.operations.some(
        (operation) =>
          operation.target === 'apps/mobile#targets.bundle.dependsOn',
      ),
    ).toBe(true);
    const conflict = createWorkspaceInitPlan(tree, {
      only: 'ci',
      resolvedExpoProjects: {
        mobile: {
          ...resolvedExpoProjects.mobile,
          targets: {
            ...resolvedExpoProjects.mobile.targets,
            'expo-doctor': { command: 'expo-doctor', dependsOn: ['bundle'] },
          },
        },
      },
    });
    expect(conflict.conflicts.join('\n')).toContain('cycle');
  });

  it('retains equivalent repository CI while guarding existing mobile build entrypoints', async () => {
    const tree = workspace();
    const workflow =
      'name: Existing\non: [push]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: nrwl/nx-set-shas@v5\n      - run: npm exec nx -- affected -t lint test build\n';
    tree.write('.github/workflows/ci.yml', workflow);
    await workspaceInitGenerator(tree, {
      only: 'ci',
      ciMode: 'auto',
      yes: true,
    });
    expect(tree.read('.github/workflows/ci.yml', 'utf8')).toBe(workflow);
    expect(tree.exists('.github/workflows/megamono-ci.yml')).toBe(false);
    expect(
      readProjectConfiguration(tree, 'mobile').targets?.build?.dependsOn,
    ).toContain('expo-doctor');
  });
});
