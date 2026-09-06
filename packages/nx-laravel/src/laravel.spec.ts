import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { readProjectConfiguration } from '@nx/devkit';
import {
  mkdtemp,
  writeFile,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applicationPlan,
  registerLaravelProject,
} from './generators/application';
import { composerEdges, composerProject, ownedComposer } from './lib/laravel';
import { materializeLaravel } from './executors/setup';

describe('Laravel workspace support', () => {
  it('plans multiple isolated applications without invoking Composer or Herd', () => {
    const tree = createTreeWithEmptyWorkspace();
    for (const name of ['portal', 'admin'])
      registerLaravelProject(tree, {
        name,
        runtime: 'herd',
        herdDomain: `acme-${name}`,
      });
    const project = readProjectConfiguration(tree, 'portal');
    expect(project.targets?.setup.cache).toBe(false);
    expect(project.targets?.['herd-link'].options?.args).toEqual([
      'link',
      'acme-portal',
    ]);
    expect(tree.exists('apps/portal/composer.json')).toBe(false);
    const before = tree.listChanges();
    expect(() => registerLaravelProject(tree, { name: 'portal' })).toThrow(
      'occupied',
    );
    expect(tree.listChanges()).toEqual(before);
  });
  it.each([
    '../outside',
    '/absolute',
    '.',
    'apps/../../escape',
    'apps/a;bad',
    'vendor/app',
    'apps/nativephp/ignored',
    'dist/app',
  ])('rejects unsafe destination %s before mutation', (directory) => {
    const tree = createTreeWithEmptyWorkspace(),
      before = tree.listChanges();
    expect(() =>
      registerLaravelProject(tree, { name: 'app', directory }),
    ).toThrow();
    expect(tree.listChanges()).toEqual(before);
  });
  it('distinguishes Laravel applications and Composer libraries with safe, non-cached targets', () => {
    expect(
      composerProject(
        'apps/api',
        { require: { 'laravel/framework': '^13' } },
        true,
      ).projectType,
    ).toBe('application');
    const lib = composerProject('libs/domain', { name: 'acme/domain' }, false);
    expect(lib.projectType).toBe('library');
    expect(lib.tags).toContain('type:util');
    expect(lib.targets?.test).toBeUndefined();
    for (const root of [
      'apps/api/vendor/pkg/composer.json',
      'node_modules/test/composer.json',
      'apps/mobile/nativephp/ios/composer.json',
      '.yalc/package/composer.json',
      'apps/.megamono-laravel-temp/composer.json',
    ])
      expect(ownedComposer(root)).toBe(false);
  });
  it('creates only declared Composer path dependency edges, including nested wildcard packages', () => {
    const records = [
      {
        project: 'api',
        root: 'apps/api',
        manifest: {
          require: { 'acme/domain': '*' },
          repositories: [{ type: 'path', url: '../../libs/php/*' }],
        },
      },
      {
        project: 'domain',
        root: 'libs/php/domain',
        manifest: { name: 'acme/domain' },
      },
      {
        project: 'unused',
        root: 'libs/php/unused',
        manifest: { name: 'acme/unused' },
      },
    ];
    expect(composerEdges(records, '/workspace')).toEqual([
      {
        source: 'api',
        target: 'domain',
        sourceFile: 'apps/api/composer.json',
        type: 'static',
      },
    ]);
    expect(
      composerEdges(
        records.map((record) => ({
          ...record,
          manifest: { ...record.manifest, repositories: [] },
        })),
        '/workspace',
      ),
    ).toEqual([]);
  });
});

describe('staged Laravel materialization', () => {
  it.each([
    'success',
    'composer-failure',
    'concurrent-edit',
    'source-symlink',
    'metadata-symlink',
  ])('preserves application data during %s', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-laravel-test-'));
    const app = join(root, 'apps/portal');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'project.json'), '{}');
    const plan = applicationPlan({ name: 'portal' });
    await writeFile(join(app, 'megamono-laravel.json'), JSON.stringify(plan));
    if (scenario === 'metadata-symlink') {
      await rm(join(app, 'project.json'));
      await writeFile(join(root, 'outside.json'), '{}');
      await symlink(join(root, 'outside.json'), join(app, 'project.json'));
    }
    const commands: string[][] = [];
    const runner = async (_tool: string, args: readonly string[]) => {
      commands.push([...args]);
      if (scenario === 'composer-failure') throw new Error('Composer failed');
      const source = args[2];
      await mkdir(source);
      await writeFile(
        join(source, 'composer.json'),
        '{"require":{"laravel/framework":"^13.0"}}',
      );
      await writeFile(join(source, 'artisan'), '<?php');
      if (scenario === 'concurrent-edit')
        await writeFile(join(app, 'keep.txt'), 'user data');
      if (scenario === 'source-symlink')
        await symlink(join(root, 'apps'), join(source, 'unsafe'));
    };
    try {
      if (scenario === 'success') {
        await materializeLaravel(root, 'apps/portal', runner);
        await materializeLaravel(root, 'apps/portal', runner);
        expect(commands).toHaveLength(1);
        expect(commands[0]).toEqual(
          expect.arrayContaining([
            '--no-install',
            '--no-scripts',
            '--no-plugins',
          ]),
        );
        expect(await readFile(join(app, 'artisan'), 'utf8')).toBe('<?php');
      } else {
        await expect(
          materializeLaravel(root, 'apps/portal', runner),
        ).rejects.toThrow();
        expect(await readFile(join(app, 'megamono-laravel.json'), 'utf8')).toBe(
          JSON.stringify(plan),
        );
        await expect(readFile(join(app, 'artisan'))).rejects.toThrow();
        if (scenario === 'concurrent-edit')
          expect(await readFile(join(app, 'keep.txt'), 'utf8')).toBe(
            'user data',
          );
      }
      expect((await readdir(app)).includes('.megamono-setup.lock')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
