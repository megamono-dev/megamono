import {
  getProjects,
  logger,
  normalizePath,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { applyEdits, modify } from 'jsonc-parser';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import {
  parseWranglerConfig,
  type WranglerConfig,
} from '../lib/wrangler-config';

export const CLOUDFLARE_RECOVERY_PATH = 'MEGAMONO-CLOUDFLARE-RECOVERY.md';

export type CloudflareGeneratorErrorKind =
  'options' | 'preflight' | 'conflict' | 'external-command';

const errorDetails = {
  options: { exitCode: 2, code: 'cloudflare-generator-options' },
  preflight: { exitCode: 3, code: 'cloudflare-generator-preflight' },
  conflict: { exitCode: 3, code: 'cloudflare-generator-conflict' },
  'external-command': {
    exitCode: 1,
    code: 'cloudflare-generator-external-command',
  },
} as const;

export class CloudflareGeneratorError extends Error {
  readonly exitCode: number;
  readonly diagnosticCode: string;

  constructor(
    readonly kind: CloudflareGeneratorErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    const details = errorDetails[kind];
    super(`${details.code}: ${message}`, options);
    this.name = 'CloudflareGeneratorError';
    this.exitCode = details.exitCode;
    this.diagnosticCode = details.code;
  }
}

export interface CloudflareGeneratorPlanOperation {
  readonly action: 'add' | 'modify' | 'retain' | 'run-last';
  readonly target: string;
  readonly detail: string;
}

export interface CloudflareGeneratorPlan {
  readonly generator: 'worker' | 'binding' | 'durable-object';
  readonly operations: readonly CloudflareGeneratorPlanOperation[];
}

export function renderCloudflareGeneratorPlan(
  plan: CloudflareGeneratorPlan,
): string {
  return `# @megamono/nx-cloudflare ${plan.generator} plan

${plan.operations.length > 0 ? plan.operations.map((operation, index) => `${index + 1}. **${operation.action} / ${operation.target}** — ${operation.detail}`).join('\n') : '- No changes.'}
`;
}

export function printCloudflareGeneratorPlan(
  plan: CloudflareGeneratorPlan,
): void {
  logger.info(renderCloudflareGeneratorPlan(plan));
}

function workspacePath(path: string): string {
  const normalized = normalizePath(path)
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
  if (
    !normalized ||
    isAbsolute(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    throw new CloudflareGeneratorError(
      'options',
      `Expected a safe workspace-relative path, received ${path}.`,
    );
  }
  return normalized;
}

export function safeWorkspacePath(path: string): string {
  return workspacePath(path);
}

export function readTreeText(tree: Tree, path: string): string | undefined {
  return tree.read(path, 'utf8') ?? undefined;
}

export function assertFileCanWrite(
  tree: Tree,
  path: string,
  content: string,
): 'add' | 'retain' {
  const existing = readTreeText(tree, path);
  if (existing === undefined) return 'add';
  if (existing === content) return 'retain';
  throw new CloudflareGeneratorError(
    'conflict',
    `${path} already exists with different content.`,
  );
}

export interface WorkerConfigDocument {
  readonly project: string;
  readonly root: string;
  readonly configPath: string;
  readonly source: string;
  readonly config: WranglerConfig;
}

export function resolveWorkerConfig(
  tree: Tree,
  projectName: string,
  configuredPath?: string,
): WorkerConfigDocument {
  const project = getProjects(tree).get(projectName);
  if (!project)
    throw new CloudflareGeneratorError(
      'options',
      `Nx project ${projectName} does not exist.`,
    );
  const root = normalizePath(project.root);
  const candidates = [
    `${root}/wrangler.jsonc`,
    `${root}/wrangler.json`,
    `${root}/wrangler.toml`,
  ].filter((path) => tree.exists(path));
  const configPath = configuredPath
    ? workspacePath(configuredPath)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!configPath || !tree.exists(configPath)) {
    throw new CloudflareGeneratorError(
      'preflight',
      candidates.length > 1
        ? `${projectName} has multiple Wrangler configs; pass --configPath.`
        : `${projectName} has no standard Wrangler config.`,
    );
  }
  if (configPath !== root && !configPath.startsWith(`${root}/`)) {
    throw new CloudflareGeneratorError(
      'options',
      `${configPath} is outside project ${projectName}.`,
    );
  }
  const source = readTreeText(tree, configPath);
  if (source === undefined)
    throw new CloudflareGeneratorError(
      'preflight',
      `Cannot read ${configPath}.`,
    );
  const parsed = parseWranglerConfig(source, configPath);
  if (!parsed.config || parsed.diagnostics.length > 0) {
    throw new CloudflareGeneratorError(
      'preflight',
      parsed.diagnostics.map(({ message }) => message).join(' '),
    );
  }
  return {
    project: projectName,
    root,
    configPath,
    source,
    config: parsed.config,
  };
}

function setObjectPath(
  value: Record<string, unknown>,
  path: readonly (string | number)[],
  replacement: unknown,
): void {
  let current: unknown = value;
  for (const [index, segment] of path.entries()) {
    if (index === path.length - 1) {
      if (
        typeof segment !== 'string' ||
        !current ||
        typeof current !== 'object'
      )
        throw new CloudflareGeneratorError(
          'preflight',
          'Unsupported TOML mutation path.',
        );
      (current as Record<string, unknown>)[segment] = replacement;
      return;
    }
    if (typeof segment !== 'string' || !current || typeof current !== 'object')
      throw new CloudflareGeneratorError(
        'preflight',
        'Unsupported TOML mutation path.',
      );
    const record = current as Record<string, unknown>;
    if (!record[segment] || typeof record[segment] !== 'object')
      record[segment] = {};
    current = record[segment];
  }
}

export function updateConfigPath(
  document: WorkerConfigDocument,
  path: readonly (string | number)[],
  value: unknown,
): WorkerConfigDocument {
  const source = document.configPath.endsWith('.toml')
    ? (() => {
        const config = parseToml(document.source) as Record<string, unknown>;
        setObjectPath(config, path, value);
        return `${stringifyToml(config).trimEnd()}\n`;
      })()
    : applyEdits(
        document.source,
        modify(document.source, [...path], value, {
          formattingOptions: {
            insertSpaces: true,
            tabSize: 2,
            eol: '\n',
          },
        }),
      );
  const parsed = parseWranglerConfig(source, document.configPath);
  if (!parsed.config || parsed.diagnostics.length > 0)
    throw new CloudflareGeneratorError(
      'preflight',
      `The planned ${document.configPath} mutation does not produce a valid supported Wrangler config.`,
    );
  return { ...document, source, config: parsed.config };
}

export interface PostFlushTask {
  readonly id: string;
  readonly retry: string;
  readonly run: GeneratorCallback;
}

export type ExternalCommandRunner = (
  executable: string,
  args: readonly string[],
  cwd: string,
) => Promise<void>;

const executeFile = promisify(execFile);

export const runExternalCommand: ExternalCommandRunner = async (
  executable,
  args,
  cwd,
) => {
  await executeFile(executable, [...args], { cwd });
};

export function typegenTask(
  workspaceRoot: string,
  configPath: string,
  runner: ExternalCommandRunner = runExternalCommand,
): PostFlushTask {
  const outputPath = normalizePath(
    join(dirname(configPath), 'worker-configuration.d.ts'),
  );
  return {
    id: 'wrangler-types',
    retry: `npm exec wrangler -- types ${outputPath} --config ${configPath}`,
    run: async () => {
      await runner(
        'npm',
        ['exec', 'wrangler', '--', 'types', outputPath, '--config', configPath],
        workspaceRoot,
      );
    },
  };
}

export function renderCloudflareRecovery(
  completed: readonly string[],
  task: Pick<PostFlushTask, 'id' | 'retry'>,
): string {
  return `# Cloudflare generator recovery

The generator stopped during the post-flush \`${task.id}\` step.

## Completed post-flush steps

${completed.length > 0 ? completed.map((step) => `- ${step}`).join('\n') : '- None'}

## Retry

Run \`${task.retry}\` from the workspace root after resolving the reported error.

Megamono did not deploy, commit, push, or roll back repository-owned changes.
`;
}

export function createPostFlushCallback(
  workspaceRoot: string,
  tasks: readonly PostFlushTask[],
): GeneratorCallback | undefined {
  if (tasks.length === 0) return undefined;
  return async () => {
    const completed: string[] = [];
    for (const task of tasks) {
      try {
        await task.run();
        completed.push(task.id);
      } catch (error) {
        await writeFile(
          join(workspaceRoot, CLOUDFLARE_RECOVERY_PATH),
          renderCloudflareRecovery(completed, task),
          'utf8',
        );
        throw new CloudflareGeneratorError(
          'external-command',
          `${task.id} failed. Recovery guidance was written to ${CLOUDFLARE_RECOVERY_PATH}.`,
          { cause: error },
        );
      }
    }
    await rm(join(workspaceRoot, CLOUDFLARE_RECOVERY_PATH), { force: true });
  };
}

export function relativeModulePath(fromFile: string, toFile: string): string {
  const value = normalizePath(
    relative(dirname(fromFile), toFile).replace(/\.ts$/, ''),
  );
  return value.startsWith('.') ? value : `./${value}`;
}
