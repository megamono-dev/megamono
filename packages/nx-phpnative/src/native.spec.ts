import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { readJson, readProjectConfiguration } from '@nx/devkit';
import generator from './generators/application';
import { nativePlatform, nativeTargets } from './index';

describe('NativePHP projects', () => {
  it.each(['desktop', 'mobile'] as const)(
    'generates a separate %s Laravel scaffold plan without launching native tools',
    async (platform) => {
      const tree = createTreeWithEmptyWorkspace();
      await generator(tree, {
        name: platform,
        platform,
        appId: `com.example.${platform}`,
        runtime: 'herd',
      });
      const plan = readJson(tree, `apps/${platform}/megamono-laravel.json`);
      expect(plan.native).toEqual({
        platform,
        version: platform === 'desktop' ? '^2.0' : '^4.0',
        appId: `com.example.${platform}`,
      });
      const project = readProjectConfiguration(tree, platform);
      expect(project.targets?.['native-install']).toMatchObject({
        cache: false,
        options: { args: ['artisan', 'native:install'], runtime: 'herd' },
      });
      expect(tree.exists(`apps/${platform}/nativephp`)).toBe(false);
      expect(readJson(tree, 'nx.json').plugins).toEqual([
        '@megamono/nx-laravel',
        '@megamono/nx-phpnative',
      ]);
    },
  );
  it('rejects invalid application IDs and mutually exclusive runtime packages', async () => {
    const tree = createTreeWithEmptyWorkspace(),
      before = tree.listChanges();
    await expect(
      generator(tree, { name: 'app', platform: 'mobile', appId: 'invalid' }),
    ).rejects.toThrow('reverse-domain');
    expect(tree.listChanges()).toEqual(before);
    await expect(
      generator(tree, {
        name: 'mobile',
        platform: 'mobile',
        appId: 'com.example.mobile',
        phpVersion: '8.3',
      }),
    ).rejects.toThrow('PHP 8.4');
    expect(tree.listChanges()).toEqual(before);
    expect(() =>
      nativePlatform({
        require: { 'nativephp/desktop': '^2', 'nativephp/mobile': '^4' },
      }),
    ).toThrow('conflict');
  });
  it('keeps native builds and installs explicit, uncached, and non-destructive', () => {
    for (const platform of ['desktop', 'mobile'] as const)
      for (const target of Object.values(
        nativeTargets('apps/native', platform),
      )) {
        expect(target.cache).toBe(false);
        expect(target.options.args).not.toContain('--force');
        expect(target.options.args).not.toContain('native:release');
      }
  });
});
