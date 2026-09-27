import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { readJson } from '@nx/devkit';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appGenerator } from './app';
import { ANDROID_TOOLCHAIN } from './android';
import { DEFAULT_MEGAMONO_CONFIG, megamonoConfigSchema } from '../../lib/config';

function workspace() {
  const tree = createTreeWithEmptyWorkspace();
  tree.write(
    'package.json',
    JSON.stringify({ name: '@acme/workspace', packageManager: 'npm@11.17.0' }),
  );
  tree.write(
    'megamono.json',
    JSON.stringify({ ...DEFAULT_MEGAMONO_CONFIG, platforms: ['web'] }),
  );
  return tree;
}
const defaults = {
  type: 'android',
  scope: 'acme',
  yes: true,
  interactive: false,
  skipInstall: true,
} as const;

describe('native Android app generator', () => {
  it('creates a Compose application and checksum-pinned wrapper without JS app dependencies', async () => {
    const tree = workspace();
    await appGenerator(tree, defaults);
    const root = 'apps/android';
    const project = readJson(tree, `${root}/project.json`);
    expect(project.name).toBe('acme-android');
    expect(project.tags).toContain('platform:android');
    expect(project.targets.build.options).toEqual({
      command: 'node gradle.mjs :app:assembleDebug',
      cwd: root,
      forwardAllArgs: false,
    });
    expect(Object.keys(project.targets)).toEqual([
      'build',
      'test',
      'lint',
      'install',
    ]);
    for (const target of Object.values(project.targets))
      expect(target).toMatchObject({ cache: false, parallelism: false });
    expect(readJson(tree, 'megamono.json').platforms).toEqual([
      'android',
      'web',
    ]);
    expect(
      megamonoConfigSchema.parse(readJson(tree, 'megamono.json')).platforms,
    ).toContain('android');
    expect(tree.exists(`${root}/package.json`)).toBe(false);
    expect(tree.read(`${root}/app/build.gradle.kts`, 'utf8')).toContain(
      'compose = true',
    );
    expect(
      tree.read(`${root}/app/src/main/AndroidManifest.xml`, 'utf8'),
    ).not.toContain('uses-permission');
    expect(
      tree.read(`${root}/gradle/wrapper/gradle-wrapper.properties`, 'utf8'),
    ).toContain(ANDROID_TOOLCHAIN.distributionSha256);
    expect(
      createHash('sha256')
        .update(
          tree.read(`${root}/gradle/wrapper/gradle-wrapper.jar`) ??
            Buffer.alloc(0),
        )
        .digest('hex'),
    ).toBe(ANDROID_TOOLCHAIN.wrapperSha256);
    expect(tree.read(`${root}/gradle.mjs`, 'utf8')).toContain('shell: false');
    expect(tree.exists(`${root}/gradlew.bat`)).toBe(true);
  });

  it('supports custom names, directories, IDs and safely escaped display names', async () => {
    const tree = workspace();
    await appGenerator(tree, {
      ...defaults,
      name: 'reader',
      directory: 'apps/native reader',
      applicationId: 'com.acme.reader',
      displayName: 'Reader "Pro" & $tools',
    });
    expect(readJson(tree, 'apps/native reader/project.json').name).toBe(
      'acme-reader',
    );
    expect(
      tree.read(
        'apps/native reader/app/src/main/java/com/acme/reader/MainActivity.kt',
        'utf8',
      ),
    ).toContain('Reader \\"Pro\\" & \\$tools');
    expect(
      tree.read('apps/native reader/app/src/main/AndroidManifest.xml', 'utf8'),
    ).toContain('&quot;Pro&quot; &amp; $tools');
  });

  it('does not overwrite a customized app on rerun or write during dry run', async () => {
    const tree = workspace();
    const before = tree.listChanges();
    await appGenerator(tree, { ...defaults, dryRun: true });
    expect(tree.listChanges()).toEqual(before);
    await appGenerator(tree, defaults);
    tree.write('apps/android/app/build.gradle.kts', '// user-owned');
    const generated = tree.listChanges();
    await appGenerator(tree, defaults);
    expect(tree.listChanges()).toEqual(generated);
    await expect(
      appGenerator(tree, {
        ...defaults,
        name: 'second',
        directory: 'apps/android',
      }),
    ).rejects.toThrow('occupied');
  });

  it.each([
    'com.123.app',
    'com.when.app',
    'com.acme.$bad',
    'com.acme.bad-name',
    'invalid',
    '',
  ])(
    'rejects invalid application ID %s before writing',
    async (applicationId) => {
      const tree = workspace();
      const before = tree.listChanges();
      await expect(
        appGenerator(tree, { ...defaults, applicationId }),
      ).rejects.toThrow('applicationId');
      expect(tree.listChanges()).toEqual(before);
    },
  );
});
