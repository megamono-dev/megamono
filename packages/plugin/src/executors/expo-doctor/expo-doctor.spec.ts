import { logger, type ExecutorContext } from '@nx/devkit';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import runExecutor from './expo-doctor';

let root: string;
let appRoot: string;
let context: ExecutorContext;
const marker = 'doctor-ran.json';

async function json(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function doctor(
  updates: Record<string, unknown> = {},
  program = `require('node:fs').writeFileSync('${marker}', JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2)}));`,
): Promise<string> {
  const packageRoot = join(root, 'node_modules/expo-doctor');
  await json(join(packageRoot, 'package.json'), {
    name: 'expo-doctor',
    version: '1.0.0',
    bin: { 'expo-doctor': 'build/index.js' },
    engines: { node: '>=18' },
    ...updates,
  });
  await mkdir(join(packageRoot, 'build'), { recursive: true });
  await writeFile(join(packageRoot, 'build/index.js'), program);
  return packageRoot;
}

beforeEach(async () => {
  vi.spyOn(childProcess, 'spawn');
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  root = await realpath(await mkdtemp(join(tmpdir(), 'megamono-expo-doctor-')));
  appRoot = join(root, 'apps/mobile');
  await json(join(appRoot, 'package.json'), {
    name: '@test/mobile',
    dependencies: { expo: '~54.0.0' },
  });
  await json(join(root, 'node_modules/expo/package.json'), {
    name: 'expo',
    version: '54.0.0',
  });
  context = {
    root,
    projectName: 'mobile',
    projectsConfigurations: {
      version: 2,
      projects: { mobile: { root: 'apps/mobile', targets: {} } },
    },
  } as ExecutorContext;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('local Expo Doctor executor', () => {
  it('runs the installed binary with the active Node executable and app cwd', async () => {
    const packageRoot = await doctor();
    expect(await runExecutor({}, context)).toEqual({ success: true });
    expect(childProcess.spawn).toHaveBeenCalledWith(
      process.execPath,
      [join(packageRoot, 'build/index.js')],
      { cwd: appRoot, shell: false, stdio: 'inherit' },
    );
    expect(JSON.parse(await readFile(join(appRoot, marker), 'utf8'))).toEqual({
      cwd: appRoot,
      argv: [],
    });
  });

  it('resolves the app-local Doctor before a hoisted workspace installation', async () => {
    await doctor({}, 'process.exit(7);');
    await json(join(appRoot, 'node_modules/expo-doctor/package.json'), {
      name: 'expo-doctor',
      version: '2.0.0',
      bin: 'doctor.js',
    });
    await writeFile(
      join(appRoot, 'node_modules/expo-doctor/doctor.js'),
      'process.exit(0);',
    );
    expect(await runExecutor({}, context)).toEqual({ success: true });
    expect(childProcess.spawn).toHaveBeenCalledWith(
      process.execPath,
      [join(appRoot, 'node_modules/expo-doctor/doctor.js')],
      expect.objectContaining({ cwd: appRoot }),
    );
  });

  it('does not download or install Doctor when it is missing', async () => {
    expect(await runExecutor({}, context)).toEqual({ success: false });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Add an explicit expo-doctor development dependency',
      ),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('never downloads or installs tools'),
    );
    await expect(
      readFile(join(root, 'node_modules/expo-doctor/package.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['<1', 'not-a-semver-range'])(
    'rejects an incompatible or invalid Doctor Node engine %s before execution',
    async (node) => {
      await doctor({ engines: { node } });
      expect(await runExecutor({}, context)).toEqual({ success: false });
      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(`requires Node ${node}`),
      );
    },
  );

  it('returns failure when Doctor exits unsuccessfully', async () => {
    await doctor({}, 'process.exit(3);');
    expect(await runExecutor({}, context)).toEqual({ success: false });
    expect(logger.error).toHaveBeenCalledWith(
      'Expo Doctor failed for mobile (exit 3).',
    );
  });

  it('returns failure when the subprocess cannot start', async () => {
    await doctor();
    vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('spawn unavailable')));
      return child as ReturnType<typeof childProcess.spawn>;
    });
    expect(await runExecutor({}, context)).toEqual({ success: false });
    expect(logger.error).toHaveBeenCalledWith('spawn unavailable');
  });

  it.each(['../outside.js', '/outside.js'])(
    'rejects a binary path escaping the installed package: %s',
    async (bin) => {
      await doctor({ bin });
      expect(await runExecutor({}, context)).toEqual({ success: false });
      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Expo Doctor must declare a binary inside its package.',
      );
    },
  );

  it('rejects a binary symlink escaping the installed package', async () => {
    const packageRoot = await doctor({ bin: 'escape.js' });
    await writeFile(join(root, 'outside.js'), 'process.exit(0);');
    await symlink(join(root, 'outside.js'), join(packageRoot, 'escape.js'));
    expect(await runExecutor({}, context)).toEqual({ success: false });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Expo Doctor binary must be a file inside its package.',
    );
  });

  it('rejects a missing binary rather than falling back to a global command', async () => {
    await doctor({ bin: 'missing.js' });
    expect(await runExecutor({}, context)).toEqual({ success: false });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('requires an installed Expo SDK', async () => {
    await doctor();
    await rm(join(root, 'node_modules/expo'), { recursive: true });
    expect(await runExecutor({}, context)).toEqual({ success: false });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('No installed Expo SDK resolves from mobile'),
    );
  });

  it('does not treat a different app’s hoisted Expo SDK as project configuration', async () => {
    await doctor();
    await json(join(appRoot, 'package.json'), { name: '@test/node-app' });
    expect(await runExecutor({}, context)).toEqual({ success: false });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'mobile has no Expo application configuration.',
    );
  });

  it('accepts an Expo app.json without a project-level SDK declaration', async () => {
    await doctor();
    await json(join(appRoot, 'package.json'), { name: '@test/mobile' });
    await json(join(appRoot, 'app.json'), { expo: {} });
    expect(await runExecutor({}, context)).toEqual({ success: true });
  });

  it('does not execute dynamic app configuration while identifying Expo', async () => {
    await doctor();
    await json(join(appRoot, 'package.json'), { name: '@test/mobile' });
    await writeFile(
      join(appRoot, 'app.config.js'),
      'throw new Error("configuration must not be loaded by the executor");',
    );
    expect(await runExecutor({}, context)).toEqual({ success: true });
  });

  it('requires a registered target project', async () => {
    context.projectName = 'missing';
    expect(await runExecutor({}, context)).toEqual({ success: false });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('rejects project roots outside the workspace', async () => {
    context.projectsConfigurations.projects.mobile.root = '../outside';
    expect(await runExecutor({}, context)).toEqual({ success: false });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Expo project root must remain inside the workspace.',
    );
  });

  it('rejects a project symlink outside the workspace', async () => {
    await symlink(tmpdir(), join(root, 'external-app'));
    context.projectsConfigurations.projects.mobile.root = 'external-app';
    expect(await runExecutor({}, context)).toEqual({ success: false });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Expo project root must not link outside the workspace.',
    );
  });

  it('rejects command or path options rather than executing arbitrary commands', async () => {
    await doctor();
    expect(
      await runExecutor(
        { command: 'npm install expo-doctor' } as never,
        context,
      ),
    ).toEqual({ success: false });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
