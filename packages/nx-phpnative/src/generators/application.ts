import {
  readProjectConfiguration,
  updateProjectConfiguration,
  updateJson,
  type Tree,
} from '@nx/devkit';
import {
  applicationPlan,
  registerLaravelProject,
  type ApplicationOptions,
} from '@megamono/nx-laravel';
import { nativeTargets } from '../index';

export interface NativeApplicationOptions extends ApplicationOptions {
  platform: 'desktop' | 'mobile';
  appId: string;
}
export default async function nativeApplicationGenerator(
  tree: Tree,
  options: NativeApplicationOptions,
) {
  if (!['desktop', 'mobile'].includes(options.platform))
    throw new Error(
      'Select desktop or mobile explicitly; each gets a separate Laravel app.',
    );
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}$/.test(options.appId))
    throw new Error(
      'appId must be a reverse-domain application identifier, such as com.example.reader.',
    );
  const base = applicationPlan(options);
  if (options.platform === 'mobile' && options.phpVersion === '8.3')
    throw new Error('NativePHP Mobile 4 requires PHP 8.4 or newer.');
  registerLaravelProject(tree, options, {
    ...base,
    native: {
      platform: options.platform,
      version: options.platform === 'desktop' ? '^2.0' : '^4.0',
      appId: options.appId,
    },
  });
  const project = readProjectConfiguration(tree, options.name);
  updateProjectConfiguration(tree, options.name, {
    ...project,
    targets: {
      ...project.targets,
      ...nativeTargets(base.root, options.platform, base.runtime),
    },
  });
  updateJson(tree, 'nx.json', (value) => ({
    ...value,
    plugins: [
      ...value.plugins,
      ...(value.plugins.some(
        (entry: string | { plugin: string }) =>
          (typeof entry === 'string' ? entry : entry.plugin) ===
          '@megamono/nx-phpnative',
      )
        ? []
        : ['@megamono/nx-phpnative']),
    ],
  }));
  console.log(
    `Run nx run ${options.name}:setup, review/install Composer dependencies and .env, then explicitly run ${options.name}:native-install. No signing, native builds, devices, or Herd settings were changed.`,
  );
}
