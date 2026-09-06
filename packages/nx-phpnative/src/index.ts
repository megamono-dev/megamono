import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CreateNodes } from '@nx/devkit';
import {
  composerProject,
  commandTarget,
  ownedComposer,
  type LaravelOptions,
  type ComposerManifest,
} from '@megamono/nx-laravel';

export function nativeTargets(
  root: string,
  platform: 'desktop' | 'mobile',
  runtime: 'system' | 'herd' = 'system',
) {
  const target = (...args: string[]) =>
    commandTarget(root, 'php', ['artisan', ...args], runtime);
  return {
    'native-install': target('native:install'),
    ...(platform === 'desktop'
      ? {
          'native-run': { ...target('native:run'), continuous: true },
          'native-build': target('native:build'),
        }
      : {
          'native-run-ios': {
            ...target('native:run', 'ios'),
            continuous: true,
          },
          'native-run-android': {
            ...target('native:run', 'android'),
            continuous: true,
          },
          'native-package-ios': target('native:package', 'ios'),
          'native-package-android': target('native:package', 'android'),
        }),
  };
}
export function nativePlatform(
  manifest: ComposerManifest,
): 'desktop' | 'mobile' | undefined {
  const desktop = Boolean(manifest.require?.['nativephp/desktop']),
    mobile = Boolean(manifest.require?.['nativephp/mobile']);
  if (desktop && mobile)
    throw new Error(
      'NativePHP desktop and mobile packages conflict; use separate Laravel application roots.',
    );
  return desktop ? 'desktop' : mobile ? 'mobile' : undefined;
}
export const createNodes: CreateNodes<LaravelOptions> = [
  '**/composer.json',
  async (
    paths: string | readonly string[],
    options: LaravelOptions = {},
    context: { workspaceRoot: string },
  ) => {
    const results = (typeof paths === 'string' ? [paths] : paths)
      .filter(ownedComposer)
      .sort()
      .flatMap((file) => {
        const root = dirname(file).replaceAll('\\', '/');
        const manifest = JSON.parse(
          readFileSync(resolve(context.workspaceRoot, file), 'utf8'),
        ) as ComposerManifest;
        const platform = nativePlatform(manifest);
        if (!platform) return [];
        if (
          !manifest.require?.['laravel/framework'] ||
          !existsSync(resolve(context.workspaceRoot, root, 'artisan'))
        )
          throw new Error(
            `NativePHP requires a complete Laravel application at ${root}.`,
          );
        const base = composerProject(root, manifest, true, options);
        return [
          [
            [file],
            {
              projects: {
                [root]: {
                  ...base,
                  targets: {
                    ...base.targets,
                    ...nativeTargets(root, platform, options.runtime),
                  },
                  metadata: {
                    ...base.metadata,
                    technologies: ['php', 'composer', 'laravel', 'nativephp'],
                    'megamono:nativephp': {
                      platform,
                      runtime: manifest.require[`nativephp/${platform}`],
                      nativeQualification: 'required-separately',
                    },
                  },
                },
              },
            },
          ],
        ];
      });
    return typeof paths === 'string'
      ? {
          projects: Object.assign(
            {},
            ...results.map(
              ([, result]) => (result as { projects: object }).projects,
            ),
          ),
        }
      : results;
  },
] as unknown as CreateNodes<LaravelOptions>;
export const createNodesV2 = createNodes;
export { default as nativeApplicationGenerator } from './generators/application';
