import type { ProjectGraph } from '@nx/devkit';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { constants } from 'node:fs';
import type { Diagnostic, DiagnosticSeverity } from './diagnostics';

export const PROJECT_PREFLIGHT_METADATA_KEY = 'megamono:preflight';

export interface ProjectPreflightDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface ProjectPreflightTool {
  readonly executable: string;
  readonly reason: string;
}

export interface ProjectPreflightMetadata {
  readonly diagnostics?: readonly ProjectPreflightDiagnostic[];
  readonly requiredTools?: readonly ProjectPreflightTool[];
}

export type ExecutableResolver = (executable: string) => Promise<boolean>;

function isProjectPreflightMetadata(
  value: unknown,
): value is ProjectPreflightMetadata {
  return typeof value === 'object' && value !== null;
}

export async function executableIsAvailable(
  executable: string,
): Promise<boolean> {
  if (!executable || executable.includes('\0')) return false;
  const candidates = isAbsolute(executable)
    ? [executable]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
}

export async function checkProjectPreflights(
  graph: ProjectGraph,
  resolveExecutable: ExecutableResolver = executableIsAvailable,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const availability = new Map<string, Promise<boolean>>();
  for (const projectName of Object.keys(graph.nodes).sort()) {
    const project = graph.nodes[projectName].data;
    const metadata = project.metadata?.[PROJECT_PREFLIGHT_METADATA_KEY];
    if (!isProjectPreflightMetadata(metadata)) continue;

    for (const diagnostic of metadata.diagnostics ?? []) {
      diagnostics.push({
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        path: diagnostic.path ?? project.root,
      });
    }

    const tools = [...(metadata.requiredTools ?? [])].sort((left, right) =>
      left.executable.localeCompare(right.executable),
    );
    for (const tool of tools) {
      let available = availability.get(tool.executable);
      if (!available) {
        available = resolveExecutable(tool.executable);
        availability.set(tool.executable, available);
      }
      if (await available) continue;
      diagnostics.push({
        severity: 'error',
        code: 'missing-toolchain',
        path: project.root,
        message: `${projectName} requires ${tool.executable}: ${tool.reason}`,
      });
    }
  }
  return diagnostics;
}
