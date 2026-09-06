import type { ExecutorContext } from '@nx/devkit';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  unlink,
  lstat,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { applicationPlan, type ScaffoldPlan } from '../generators/application';
import { runTool, safeRoot } from './command';

export async function materializeLaravel(
  workspace: string,
  directory: string,
  run = runTool,
) {
  const root = safeRoot(workspace, directory);
  const planFile = join(root, 'megamono-laravel.json');
  for (const file of [planFile, join(root, 'project.json')])
    if (!(await lstat(file)).isFile())
      throw new Error('Scaffold metadata must be regular files, not symlinks.');
  const bytes = await readFile(planFile, 'utf8');
  const plan = JSON.parse(bytes) as ScaffoldPlan;
  applicationPlan({
    name: plan.name,
    directory: plan.root,
    laravelVersion: plan.laravelVersion,
    runtime: plan.runtime,
  });
  if (plan.schemaVersion !== 1 || plan.root !== directory)
    throw new Error('Scaffold plan does not match this project.');
  if (
    plan.native &&
    (!['desktop', 'mobile'].includes(plan.native.platform) ||
      !/^\^[24]\.0$/.test(plan.native.version) ||
      !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}$/.test(plan.native.appId))
  )
    throw new Error('Invalid NativePHP scaffold plan.');
  if (
    plan.native &&
    plan.native.version !==
      (plan.native.platform === 'desktop' ? '^2.0' : '^4.0')
  )
    throw new Error('NativePHP platform and major version disagree.');
  if (plan.completed) {
    await readFile(join(root, 'composer.json'));
    await readFile(join(root, 'artisan'));
    return;
  }
  const lock = join(root, '.megamono-setup.lock');
  await writeFile(lock, String(process.pid), { flag: 'wx' });
  let staging: string | undefined;
  let copying = false;
  try {
    const initial = await readFile(join(root, 'project.json'), 'utf8');
    const assertUnchanged = async () => {
      const extra = (await readdir(root)).filter(
        (name) =>
          ![
            'project.json',
            'megamono-laravel.json',
            '.megamono-setup.lock',
          ].includes(name),
      );
      if (
        extra.length ||
        (await readFile(planFile, 'utf8')) !== bytes ||
        (await readFile(join(root, 'project.json'), 'utf8')) !== initial
      )
        throw new Error(
          'Scaffold destination changed or contains application files; no files will be overwritten.',
        );
    };
    await assertUnchanged();
    staging = await mkdtemp(join(dirname(root), '.megamono-laravel-'));
    const source = join(staging, 'application');
    const args = [
      'create-project',
      'laravel/laravel',
      source,
      plan.laravelVersion,
      '--no-install',
      '--no-scripts',
      '--no-plugins',
      '--no-interaction',
      '--prefer-dist',
    ];
    await run(
      plan.runtime === 'herd' ? 'herd' : 'composer',
      plan.runtime === 'herd' ? ['composer', ...args] : args,
      root,
    );
    const composer = JSON.parse(
      await readFile(join(source, 'composer.json'), 'utf8'),
    );
    if (!composer.require?.['laravel/framework'])
      throw new Error('Upstream skeleton is not a Laravel application.');
    await readFile(join(source, 'artisan'));
    async function validateFiles(path: string): Promise<void> {
      for (const name of await readdir(path)) {
        const file = join(path, name),
          info = await lstat(file);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
          throw new Error('Scaffold contains an unsupported filesystem entry.');
        if (info.isDirectory()) await validateFiles(file);
      }
    }
    await validateFiles(source);
    const names = await readdir(source);
    if (
      names.some((name) =>
        [
          'project.json',
          'megamono-laravel.json',
          '.megamono-setup.lock',
          '.git',
          '.env',
          'vendor',
          'node_modules',
        ].includes(name),
      )
    )
      throw new Error(
        'Upstream skeleton contains reserved or installed content.',
      );
    if (plan.native) {
      const other = plan.native.platform === 'desktop' ? 'mobile' : 'desktop';
      if (composer.require[`nativephp/${other}`])
        throw new Error('Desktop and mobile must use separate Laravel roots.');
      composer.require[`nativephp/${plan.native.platform}`] =
        plan.native.version;
      await writeFile(
        join(source, 'composer.json'),
        JSON.stringify(composer, null, 4) + '\n',
      );
      const example = await readFile(join(source, '.env.example'), 'utf8');
      await writeFile(
        join(source, '.env.example'),
        `${example.trimEnd()}\n\nNATIVEPHP_APP_ID=${plan.native.appId}\n`,
      );
    }
    await assertUnchanged();
    copying = true;
    for (const name of names)
      await cp(join(source, name), join(root, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    if ((await readFile(planFile, 'utf8')) !== bytes)
      throw new Error('Scaffold metadata changed during materialization.');
    await writeFile(
      planFile,
      JSON.stringify({ ...plan, completed: true }, null, 2) + '\n',
    );
    copying = false;
    console.log(
      `Laravel scaffold ready at ${directory}. No dependencies installed, credentials generated, databases migrated, or native tools launched.`,
    );
  } catch (error) {
    if (copying)
      console.error(
        `Scaffold copy interrupted; preserve/review ${root} and staged source ${staging}. No application files were removed. Do not force a retry over these files.`,
      );
    throw error;
  } finally {
    await unlink(lock);
    if (staging && !copying)
      await rm(staging, { recursive: true, force: true });
  }
}
export default async function setup(
  options: { root: string },
  context: ExecutorContext,
) {
  await materializeLaravel(context.root, options.root);
  return { success: true };
}
