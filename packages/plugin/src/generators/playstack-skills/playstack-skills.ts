import { execFile } from 'node:child_process';
import {
  addDependenciesToPackageJson,
  formatFiles,
  logger,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { compatiblePlaystackPackageVersion } from '../../lib/emissions';
import { isSafeWorkspaceRelativePath } from '../../lib/config';
import {
  PlaystackWorkspaceIntegrationError,
  assertPlaystackProductInstalled,
  assertPlaystackWorkspaceCompatibility,
  readInitializedMegamonoWorkspace,
  retainedLocalPackageVersion,
} from '../playstack-workspace';
import type { PlaystackSkillsGeneratorSchema } from './schema';
import {
  packageManagerAdapter,
  type PackageManager,
} from '../../lib/package-manager';

const executeFile = promisify(execFile);
const recoveryHeading = '# Megamono Playstack skills recovery\n';

export interface PlaystackSkillsCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export type PlaystackSkillsCommandRunner = (
  command: PlaystackSkillsCommand,
  workspaceRoot: string,
) => Promise<void>;

const runPlaystackSkillsCommand: PlaystackSkillsCommandRunner = async (
  command,
  workspaceRoot,
) => {
  await executeFile(command.command, [...command.args], {
    cwd: workspaceRoot,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
};

function playstackCommand(
  packageManager: PackageManager,
): PlaystackSkillsCommand {
  const [command, args] =
    packageManager === 'bun'
      ? (['bunx', ['playstack', 'skills', 'sync']] as const)
      : packageManager === 'yarn'
        ? (['yarn', ['playstack', 'skills', 'sync']] as const)
        : packageManager === 'npm'
          ? (['npm', ['exec', 'playstack', '--', 'skills', 'sync']] as const)
          : (['pnpm', ['exec', 'playstack', 'skills', 'sync']] as const);
  return { command, args };
}

function displayCommand(command: PlaystackSkillsCommand): string {
  return [command.command, ...command.args].join(' ');
}

export function createPlaystackSkillsPostFlushCallback(
  workspaceRoot: string,
  packageManager: PackageManager,
  install: GeneratorCallback,
  runner: PlaystackSkillsCommandRunner = runPlaystackSkillsCommand,
): GeneratorCallback {
  const command = playstackCommand(packageManager);
  return async () => {
    let phase = 'install';
    try {
      await install();
      phase = 'skills-sync';
      await runner(command, workspaceRoot);
      try {
        const recoveryPath = `${workspaceRoot}/MEGAMONO-RECOVERY.md`;
        if (
          (await readFile(recoveryPath, 'utf8')).startsWith(recoveryHeading)
        ) {
          await rm(recoveryPath, { force: true });
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
    } catch (cause) {
      await writeFile(
        `${workspaceRoot}/MEGAMONO-RECOVERY.md`,
        `${recoveryHeading}

Playstack skill synchronization stopped during the \`${phase}\` phase.

- Retry install: \`${packageManagerAdapter(packageManager).install}\`
- Retry sync: \`${displayCommand(command)}\`

Megamono did not copy, overwrite, register, or eject any Playstack-owned skill file. Resolve the package or Playstack CLI diagnostic, then rerun the failed command.
`,
        'utf8',
      );
      throw cause;
    }
  };
}

interface PlaystackConfiguration {
  readonly $schema?: unknown;
  readonly skills?: unknown;
  readonly [key: string]: unknown;
}

function plannedPlaystackConfiguration(tree: Tree): {
  readonly content?: string;
  readonly targets: readonly string[];
} {
  const path = 'playstack.json';
  if (!tree.exists(path)) {
    return {
      content: `${JSON.stringify(
        {
          $schema: './node_modules/@playstack/cli/playstack.schema.json',
          skills: { targets: ['.agents/skills'] },
        },
        null,
        2,
      )}\n`,
      targets: ['.agents/skills'],
    };
  }
  let config: PlaystackConfiguration;
  try {
    config = JSON.parse(
      tree.read(path, 'utf8') ?? '',
    ) as PlaystackConfiguration;
  } catch (cause) {
    throw new PlaystackWorkspaceIntegrationError(
      'playstack.json must be valid JSON before synchronizing skills.',
      { cause },
    );
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new PlaystackWorkspaceIntegrationError(
      'playstack.json must contain an object before synchronizing skills.',
    );
  }
  if (config.skills === undefined) {
    return {
      content: `${JSON.stringify(
        { ...config, skills: { targets: ['.agents/skills'] } },
        null,
        2,
      )}\n`,
      targets: ['.agents/skills'],
    };
  }
  if (
    typeof config.skills !== 'object' ||
    config.skills === null ||
    Array.isArray(config.skills)
  ) {
    throw new PlaystackWorkspaceIntegrationError(
      'playstack.json skills must be an object.',
    );
  }
  const targets = (config.skills as { targets?: unknown }).targets;
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    targets.some((target) => typeof target !== 'string')
  ) {
    throw new PlaystackWorkspaceIntegrationError(
      'playstack.json skills.targets must be a non-empty string array.',
    );
  }
  const normalizedTargets = targets as string[];
  if (
    new Set(normalizedTargets).size !== normalizedTargets.length ||
    normalizedTargets.some((target) => !isSafeWorkspaceRelativePath(target))
  ) {
    throw new PlaystackWorkspaceIntegrationError(
      'playstack.json skills.targets must be unique safe workspace-relative paths.',
    );
  }
  return { targets: normalizedTargets };
}

export async function playstackSkillsGenerator(
  tree: Tree,
  options: PlaystackSkillsGeneratorSchema,
): Promise<GeneratorCallback | void> {
  const workspace = readInitializedMegamonoWorkspace(tree);
  assertPlaystackWorkspaceCompatibility(tree);
  const products = assertPlaystackProductInstalled(tree);
  const config = plannedPlaystackConfiguration(tree);
  logger.info(`# Playstack skills plan

- Products: ${products.join(', ')}
- Packages: @playstack/cli, @playstack/skills
- Targets: ${config.targets.join(', ')}
- Sync: ${displayCommand(playstackCommand(workspace.conventions.packageManager))}
- Ownership: Playstack
`);
  if (options.dryRun === true || process.env.NX_DRY_RUN === 'true') return;

  if (config.content !== undefined)
    tree.write('playstack.json', config.content);
  const cliVersion = compatiblePlaystackPackageVersion(
    'playstack-skills',
    '@playstack/cli',
  );
  const skillsVersion = compatiblePlaystackPackageVersion(
    'playstack-skills',
    '@playstack/skills',
  );
  const install = addDependenciesToPackageJson(
    tree,
    {},
    {
      '@playstack/cli': retainedLocalPackageVersion(
        tree,
        '@playstack/cli',
        cliVersion,
      ),
      '@playstack/skills': retainedLocalPackageVersion(
        tree,
        '@playstack/skills',
        skillsVersion,
      ),
    },
  );
  await formatFiles(tree);
  return createPlaystackSkillsPostFlushCallback(
    tree.root,
    workspace.conventions.packageManager,
    install,
  );
}

export default playstackSkillsGenerator;
