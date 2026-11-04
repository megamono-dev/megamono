import {
  addProjectConfiguration,
  readProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { planExpoValidation, wireExpoValidation } from './expo-validation';

function app(tree: Tree) {
  tree.write(
    'apps/mobile/package.json',
    JSON.stringify({ dependencies: { expo: '~54.0.38', react: '19.1.0' } }),
  );
  tree.write('apps/mobile/app.json', '{"expo":{"name":"Mobile"}}');
  tree.write(
    'apps/mobile/metro.config.js',
    "module.exports = require('expo/metro-config').getDefaultConfig(__dirname);\n",
  );
  addProjectConfiguration(tree, 'mobile', {
    root: 'apps/mobile',
    projectType: 'application',
    targets: {
      build: {
        command: 'eas build',
        dependsOn: ['^build', 'prepare'],
        options: { cwd: 'apps/mobile' },
      },
      export: { executor: '@nx/expo:export', cache: true },
      test: { command: 'node test.mjs' },
    },
  });
}

describe('Expo validation wiring', () => {
  it('plans without mutations and preserves SDK, Metro and unrelated projects/targets', () => {
    const tree = createTreeWithEmptyWorkspace();
    app(tree);
    addProjectConfiguration(tree, 'web', {
      root: 'apps/web',
      targets: { build: { command: 'next build' } },
    });
    const before = tree.listChanges();
    const plan = planExpoValidation(tree);
    expect(tree.listChanges()).toEqual(before);
    expect(plan.map((p) => p.name)).toEqual(['mobile']);
    const metro = tree.read('apps/mobile/metro.config.js', 'utf8');
    const pkg = tree.read('apps/mobile/package.json', 'utf8');
    const web = readProjectConfiguration(tree, 'web');
    wireExpoValidation(tree);
    const targets = readProjectConfiguration(tree, 'mobile').targets;
    expect(targets?.build).toMatchObject({
      command: 'eas build',
      dependsOn: ['^build', 'prepare', 'expo-doctor'],
      options: { cwd: 'apps/mobile' },
    });
    expect(targets?.export).toMatchObject({
      executor: '@nx/expo:export',
      cache: true,
      dependsOn: ['expo-doctor'],
    });
    expect(targets?.test).toEqual({ command: 'node test.mjs' });
    expect(targets?.['expo-doctor']).toEqual({
      executor: '@megamono/plugin:expo-doctor',
      cache: false,
    });
    expect(readProjectConfiguration(tree, 'web')).toEqual(web);
    expect(tree.read('apps/mobile/metro.config.js', 'utf8')).toBe(metro);
    expect(tree.read('apps/mobile/package.json', 'utf8')).toBe(pkg);
    const first = tree.listChanges();
    wireExpoValidation(tree);
    expect(tree.listChanges()).toEqual(first);
  });

  it('retains a custom Doctor target and existing prerequisites', () => {
    const tree = createTreeWithEmptyWorkspace();
    app(tree);
    const project = readProjectConfiguration(tree, 'mobile');
    const doctor = {
      command: 'node tools/doctor.mjs',
      cache: false,
    };
    project.targets = { ...project.targets, 'expo-doctor': doctor };
    tree.write('apps/mobile/project.json', JSON.stringify(project));
    wireExpoValidation(tree);
    expect(
      readProjectConfiguration(tree, 'mobile').targets?.['expo-doctor'],
    ).toEqual(doctor);
  });

  it('rejects a custom Doctor/build cycle before writes', () => {
    const tree = createTreeWithEmptyWorkspace();
    app(tree);
    const project = readProjectConfiguration(tree, 'mobile');
    project.targets = {
      ...project.targets,
      'expo-doctor': { command: 'expo-doctor', dependsOn: ['prepare'] },
      prepare: { command: 'node prepare.mjs', dependsOn: ['build'] },
    };
    tree.write('apps/mobile/project.json', JSON.stringify(project));
    const before = tree.listChanges();
    expect(() => wireExpoValidation(tree)).toThrow('would create a cycle');
    expect(tree.listChanges()).toEqual(before);
  });

  it('overlays renamed inferred Expo targets without replacing their commands', () => {
    const tree = createTreeWithEmptyWorkspace();
    app(tree);
    const project = readProjectConfiguration(tree, 'mobile');
    project.targets = {};
    tree.write('apps/mobile/project.json', JSON.stringify(project));
    tree.write(
      'nx.json',
      JSON.stringify({
        plugins: [
          {
            plugin: '@nx/expo/plugin',
            options: {
              buildTargetName: 'cloud-build',
              exportTargetName: 'bundle',
            },
          },
        ],
      }),
    );
    wireExpoValidation(tree);
    const targets = readProjectConfiguration(tree, 'mobile').targets;
    expect(targets?.['cloud-build']).toEqual({ dependsOn: ['expo-doctor'] });
    expect(targets?.bundle).toEqual({ dependsOn: ['^bundle', 'expo-doctor'] });
    expect(targets?.build).toBeUndefined();
  });

  it('uses resolved scoped inference and preserves inferred export prerequisites', () => {
    const tree = createTreeWithEmptyWorkspace();
    app(tree);
    const project = readProjectConfiguration(tree, 'mobile');
    project.targets = {};
    tree.write('apps/mobile/project.json', JSON.stringify(project));
    tree.write(
      'nx.json',
      JSON.stringify({
        plugins: [{ plugin: '@nx/expo/plugin', include: ['apps/mobile/**'] }],
      }),
    );
    wireExpoValidation(tree, {
      mobile: {
        ...project,
        targets: {
          bundle: { command: 'expo export', dependsOn: ['^bundle'] },
          serve: { command: 'expo start' },
        },
      },
    });
    const targets = readProjectConfiguration(tree, 'mobile').targets;
    expect(targets?.bundle).toEqual({ dependsOn: ['^bundle', 'expo-doctor'] });
    expect(targets?.serve).toBeUndefined();
  });

  it('does not mistake the root toolchain or an Expo library for an app', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'package.json',
      JSON.stringify({
        name: 'toolchain',
        devDependencies: { expo: '~54.0.38' },
        workspaces: ['packages/*'],
      }),
    );
    addProjectConfiguration(tree, 'toolchain', {
      root: '.',
      targets: { build: { command: 'nx run-many -t build' } },
    });
    tree.write(
      'packages/native/package.json',
      JSON.stringify({ dependencies: { expo: '~54.0.38' } }),
    );
    addProjectConfiguration(tree, 'native', {
      root: 'packages/native',
      projectType: 'library',
    });
    expect(planExpoValidation(tree)).toEqual([]);
  });

  it('keeps inferred prerequisites when the local target is only a partial overlay', () => {
    const tree = createTreeWithEmptyWorkspace();
    app(tree);
    const project = readProjectConfiguration(tree, 'mobile');
    project.targets = { build: { cache: true } };
    tree.write('apps/mobile/project.json', JSON.stringify(project));
    wireExpoValidation(tree, {
      mobile: {
        ...project,
        targets: {
          build: {
            executor: '@nx/expo:build',
            dependsOn: ['^build', 'prepare'],
          },
        },
      },
    });
    expect(readProjectConfiguration(tree, 'mobile').targets?.build).toEqual({
      cache: true,
      dependsOn: ['^build', 'prepare', 'expo-doctor'],
    });
  });

  it('limits application generation to the new app instead of migrating other apps', () => {
    const tree = createTreeWithEmptyWorkspace();
    app(tree);
    const before = readProjectConfiguration(tree, 'mobile');
    tree.write('apps/new/package.json', '{"dependencies":{"expo":"~54.0.38"}}');
    addProjectConfiguration(tree, 'new', {
      root: 'apps/new',
      targets: { build: { command: 'eas build' } },
    });
    wireExpoValidation(tree, undefined, ['new']);
    expect(readProjectConfiguration(tree, 'mobile')).toEqual(before);
    expect(
      readProjectConfiguration(tree, 'new').targets?.build.dependsOn,
    ).toContain('expo-doctor');
  });

  it('preserves target defaults when adding overlays to static inferred targets', () => {
    const tree = createTreeWithEmptyWorkspace();
    app(tree);
    const project = readProjectConfiguration(tree, 'mobile');
    project.targets = {};
    tree.write('apps/mobile/project.json', JSON.stringify(project));
    tree.write(
      'nx.json',
      JSON.stringify({
        plugins: [
          {
            plugin: '@nx/expo/plugin',
            options: { exportTargetName: 'bundle' },
          },
        ],
        targetDefaults: {
          bundle: { dependsOn: ['prepare', '^bundle'] },
          '@nx/expo:build': { dependsOn: ['prebuild'] },
        },
      }),
    );
    wireExpoValidation(tree);
    const targets = readProjectConfiguration(tree, 'mobile').targets;
    expect(targets?.bundle).toEqual({
      dependsOn: ['prepare', '^bundle', 'expo-doctor'],
    });
    expect(targets?.build).toEqual({ dependsOn: ['prebuild', 'expo-doctor'] });
  });

  it('keeps explicit project dependencies above target defaults', () => {
    const tree = createTreeWithEmptyWorkspace();
    app(tree);
    tree.write(
      'nx.json',
      JSON.stringify({
        targetDefaults: { build: { dependsOn: ['global-prepare'] } },
      }),
    );
    wireExpoValidation(tree);
    expect(
      readProjectConfiguration(tree, 'mobile').targets?.build.dependsOn,
    ).toEqual(['^build', 'prepare', 'expo-doctor']);
  });

  it('reads JSONC Nx defaults without dropping inferred export ordering', () => {
    const tree = createTreeWithEmptyWorkspace();
    app(tree);
    const project = readProjectConfiguration(tree, 'mobile');
    project.targets = {};
    tree.write('apps/mobile/project.json', JSON.stringify(project));
    tree.write(
      'nx.json',
      `{
      // Preserve Nx's supported configuration format.
      "plugins": ["@nx/expo/plugin"],
      "targetDefaults": {"build": {"dependsOn": ["prepare"]}},
    }`,
    );
    wireExpoValidation(tree);
    const targets = readProjectConfiguration(tree, 'mobile').targets;
    expect(targets?.export.dependsOn).toEqual(['^export', 'expo-doctor']);
    expect(targets?.build.dependsOn).toEqual(['prepare', 'expo-doctor']);
  });

  it.each([
    'mobile:build',
    { projects: ['mobile'], target: 'build' },
    { projects: 'self', target: 'build' },
  ])(
    'rejects an explicit same-project Doctor cycle through %j',
    (dependency) => {
      const tree = createTreeWithEmptyWorkspace();
      app(tree);
      const project = readProjectConfiguration(tree, 'mobile');
      project.targets = {
        ...project.targets,
        'expo-doctor': { command: 'expo-doctor', dependsOn: [dependency] },
      };
      tree.write('apps/mobile/project.json', JSON.stringify(project));
      const before = tree.listChanges();
      expect(() => wireExpoValidation(tree)).toThrow('would create a cycle');
      expect(tree.listChanges()).toEqual(before);
    },
  );

  it.each([{ target: 'build*' }, { projects: ['mob*'], target: 'build' }])(
    'rejects ambiguous Doctor prerequisite selectors before mutations: %j',
    (dependency) => {
      const tree = createTreeWithEmptyWorkspace();
      app(tree);
      const project = readProjectConfiguration(tree, 'mobile');
      project.targets = {
        ...project.targets,
        'expo-doctor': { command: 'expo-doctor', dependsOn: [dependency] },
      };
      tree.write('apps/mobile/project.json', JSON.stringify(project));
      const before = tree.listChanges();
      expect(() => wireExpoValidation(tree)).toThrow(
        /cannot be checked safely|may create a cycle/,
      );
      expect(tree.listChanges()).toEqual(before);
    },
  );

  it.each(['expo-doctor', '@megamono/plugin:expo-doctor', 'expo-*'])(
    'rejects cycles inherited by a newly added Doctor through defaults %s',
    (key) => {
      const tree = createTreeWithEmptyWorkspace();
      app(tree);
      tree.write(
        'nx.json',
        JSON.stringify({ targetDefaults: { [key]: { dependsOn: ['build'] } } }),
      );
      const before = tree.listChanges();
      expect(() => wireExpoValidation(tree)).toThrow('would create a cycle');
      expect(tree.listChanges()).toEqual(before);
    },
  );

  it('recognizes a root-SDK dynamic Expo app from resolved targets', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('package.json', '{"dependencies":{"expo":"~54.0.38"}}');
    tree.write('apps/dynamic/package.json', '{"name":"dynamic"}');
    tree.write(
      'apps/dynamic/app.config.ts',
      'throw new Error("must not execute");',
    );
    addProjectConfiguration(tree, 'dynamic', {
      root: 'apps/dynamic',
      targets: { build: { cache: true } },
    });
    wireExpoValidation(tree, {
      dynamic: {
        root: 'apps/dynamic',
        targets: { build: { executor: '@nx/expo:build' } },
      },
    });
    expect(
      readProjectConfiguration(tree, 'dynamic').targets?.build.dependsOn,
    ).toContain('expo-doctor');
  });

  it.each(['buildTargetName', 'exportTargetName'])(
    'rejects an inferred %s that collides with the Doctor target',
    (option) => {
      const tree = createTreeWithEmptyWorkspace();
      app(tree);
      tree.write(
        'nx.json',
        JSON.stringify({
          plugins: [
            { plugin: '@nx/expo/plugin', options: { [option]: 'expo-doctor' } },
          ],
        }),
      );
      expect(() => wireExpoValidation(tree)).toThrow(
        'Choose a different Expo target name',
      );
    },
  );

  it('rejects a resolved build target occupying the reserved Doctor name', () => {
    const tree = createTreeWithEmptyWorkspace();
    app(tree);
    expect(() =>
      wireExpoValidation(tree, {
        mobile: {
          root: 'apps/mobile',
          targets: { 'expo-doctor': { command: 'expo export' } },
        },
      }),
    ).toThrow('Rename it before configuring');
  });
});
