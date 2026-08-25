import type { GeneratorCallback } from '@nx/devkit';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceInitError } from './workspace-init-plan';

export const WORKSPACE_INIT_RECOVERY_PATH = 'MEGAMONO-RECOVERY.md';

export interface WorkspaceInitPostFlushTask {
  readonly id: string;
  readonly retry: string;
  readonly run: GeneratorCallback;
}

export function renderWorkspaceInitRecovery(
  completed: readonly string[],
  failed: Pick<WorkspaceInitPostFlushTask, 'id' | 'retry'>,
): string {
  return `# Megamono workspace initialization recovery

Workspace initialization stopped during the post-flush \`${failed.id}\` step.

## Completed post-flush steps

${completed.length > 0 ? completed.map((step) => `- ${step}`).join('\n') : '- None'}

## Retry

Run \`${failed.retry}\` from the workspace root after resolving the reported error.

Megamono did not commit, push, revert, or roll back repository-owned changes.
`;
}

export function createWorkspaceInitPostFlushCallback(
  workspaceRoot: string,
  tasks: readonly WorkspaceInitPostFlushTask[],
): GeneratorCallback {
  return async () => {
    if (tasks.length === 0) return;
    const completed: string[] = [];
    for (const task of tasks) {
      try {
        await task.run();
        completed.push(task.id);
      } catch (error) {
        await writeFile(
          join(workspaceRoot, WORKSPACE_INIT_RECOVERY_PATH),
          renderWorkspaceInitRecovery(completed, task),
          'utf8',
        );
        throw new WorkspaceInitError(
          'external-command',
          `${task.id} failed. Recovery guidance was written to ${WORKSPACE_INIT_RECOVERY_PATH}.`,
          { cause: error },
        );
      }
    }
    await rm(join(workspaceRoot, WORKSPACE_INIT_RECOVERY_PATH), {
      force: true,
    });
  };
}
