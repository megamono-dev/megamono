import { logger, type PromiseExecutor } from '@nx/devkit';
import childProcess from 'node:child_process';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { satisfies, validRange } from 'semver';
import type { ExpoDoctorExecutorSchema } from './schema';

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly engines?: { readonly node?: string };
  readonly expo?: unknown;
}

function isWithin(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return (
    remainder !== '..' &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder)
  );
}

async function manifest(path: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot read package/configuration manifest ${path}.`, {
      cause: error,
    });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const runExecutor: PromiseExecutor<ExpoDoctorExecutorSchema> = async (
  options,
  context,
) => {
  if (Object.keys(options).length) {
    logger.error('expo-doctor accepts no command, path, or tool options.');
    return { success: false };
  }
  const projectName = context.projectName;
  const project = projectName
    ? context.projectsConfigurations?.projects[projectName]
    : undefined;
  if (!projectName || !project || typeof project.root !== 'string') {
    logger.error('expo-doctor requires a registered Nx target project.');
    return { success: false };
  }

  try {
    const workspace = await realpath(context.root);
    const configuredRoot = resolve(workspace, project.root);
    if (!isWithin(workspace, configuredRoot))
      throw new Error('Expo project root must remain inside the workspace.');
    const projectRoot = await realpath(configuredRoot);
    if (!isWithin(workspace, projectRoot))
      throw new Error('Expo project root must not link outside the workspace.');
    const app = await manifest(join(projectRoot, 'package.json'));
    const appConfig = await manifest(join(projectRoot, 'app.json'));
    const dynamicConfig = (
      await Promise.all(
        ['app.config.js', 'app.config.ts'].map((name) =>
          exists(join(projectRoot, name)),
        ),
      )
    ).some(Boolean);
    const isExpo =
      typeof app?.dependencies?.expo === 'string' ||
      typeof app?.devDependencies?.expo === 'string' ||
      (appConfig?.expo !== null && typeof appConfig?.expo === 'object') ||
      dynamicConfig ||
      Object.values(project.targets ?? {}).some((target) =>
        target.executor?.startsWith('@nx/expo:'),
      );
    if (!isExpo)
      throw new Error(`${projectName} has no Expo application configuration.`);
    const localRequire = createRequire(join(projectRoot, 'package.json'));
    let expoPath: string;
    try {
      expoPath = localRequire.resolve('expo/package.json');
    } catch {
      throw new Error(
        `No installed Expo SDK resolves from ${projectName}. Install the workspace's committed dependencies before running Expo Doctor.`,
      );
    }
    if ((await manifest(expoPath))?.name !== 'expo')
      throw new Error('The resolved Expo SDK package manifest is invalid.');
    let doctorPath: string;
    try {
      doctorPath = localRequire.resolve('expo-doctor/package.json');
    } catch {
      throw new Error(
        `No locally installed expo-doctor resolves from ${projectName}. Add an explicit expo-doctor development dependency compatible with this app's Expo SDK and Node version, install it with the workspace package manager, and commit the lockfile. This executor never downloads or installs tools.`,
      );
    }
    const doctor = await manifest(doctorPath);
    if (doctor?.name !== 'expo-doctor')
      throw new Error('The resolved Expo Doctor package manifest is invalid.');
    const nodeRange = doctor.engines?.node;
    if (
      nodeRange !== undefined &&
      (typeof nodeRange !== 'string' ||
        !validRange(nodeRange) ||
        !satisfies(process.version, nodeRange))
    )
      throw new Error(
        `Installed expo-doctor ${doctor.version ?? '(unknown version)'} requires Node ${String(nodeRange)}; the active Node version is ${process.version}. Use a supported Node version or explicitly select a compatible Expo Doctor version for this app.`,
      );
    const bin =
      typeof doctor.bin === 'string' ? doctor.bin : doctor.bin?.['expo-doctor'];
    const packageRoot = await realpath(dirname(doctorPath));
    if (
      typeof bin !== 'string' ||
      !bin ||
      isAbsolute(bin) ||
      !isWithin(packageRoot, resolve(packageRoot, bin))
    )
      throw new Error('Expo Doctor must declare a binary inside its package.');
    const binary = await realpath(resolve(packageRoot, bin));
    if (!isWithin(packageRoot, binary) || !(await stat(binary)).isFile())
      throw new Error('Expo Doctor binary must be a file inside its package.');
    logger.info(
      `Running locally installed expo-doctor ${doctor.version ?? '(unknown version)'} for ${projectName}.`,
    );
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      const child = childProcess.spawn(process.execPath, [binary], {
        cwd: projectRoot,
        shell: false,
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('close', (code) => resolveExit(code ?? 1));
    });
    if (exitCode !== 0)
      logger.error(`Expo Doctor failed for ${projectName} (exit ${exitCode}).`);
    return { success: exitCode === 0 };
  } catch (error) {
    logger.error(
      error instanceof Error ? error.message : 'Expo Doctor could not run.',
    );
    return { success: false };
  }
};

export default runExecutor;
