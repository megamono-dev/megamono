import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { dirname, join, posix, sep } from 'node:path';
import {
  hashArtifactSymlinkTarget,
  readArtifactRegistryFromDisk,
  upsertArtifactEntry,
  writeArtifactRegistryToDisk,
  type ManagedArtifactEntry,
} from './managed-artifacts';

export const SKILLS_PROJECTION_ARTIFACT_ID = 'agents.skills-projection';
export const SKILLS_PROJECTION_PATH = '.claude/skills';
export const SKILLS_PROJECTION_TARGET = '../.agents/skills';

export type SkillsProjectionState =
  'installed' | 'current' | 'missing' | 'ejected' | 'unmanaged' | 'conflict';

export interface SkillsProjectionResult {
  readonly state: SkillsProjectionState;
  readonly reason: string;
}

function normalizedTarget(target: string): string {
  return posix.normalize(target.split(sep).join('/'));
}

function status(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function projectionArtifact(sourceVersion: string): ManagedArtifactEntry {
  const hash = hashArtifactSymlinkTarget(SKILLS_PROJECTION_TARGET);
  return {
    id: SKILLS_PROJECTION_ARTIFACT_ID,
    module: 'skills',
    mode: 'managed',
    target: SKILLS_PROJECTION_PATH,
    sourceVersion,
    templateHash: hash,
    installedHash: hash,
    state: 'managed',
    ejectable: true,
  };
}

export function ensureManagedSkillsProjection(
  workspaceRoot: string,
  sourceVersion: string,
  options: { readonly allowRecreate?: boolean } = {},
): SkillsProjectionResult {
  const registry = readArtifactRegistryFromDisk(workspaceRoot);
  const recorded = registry.artifacts.find(
    ({ id }) => id === SKILLS_PROJECTION_ARTIFACT_ID,
  );
  if (recorded?.state === 'ejected') {
    return {
      state: 'ejected',
      reason: 'the skills projection is repository-owned after ejection',
    };
  }

  const linkPath = join(workspaceRoot, SKILLS_PROJECTION_PATH);
  const current = status(linkPath);
  if (current) {
    if (!current.isSymbolicLink()) {
      return {
        state: 'conflict',
        reason: `${SKILLS_PROJECTION_PATH} exists and is not a symlink`,
      };
    }
    const target = normalizedTarget(readlinkSync(linkPath));
    if (target !== SKILLS_PROJECTION_TARGET) {
      return {
        state: 'conflict',
        reason: `${SKILLS_PROJECTION_PATH} points to ${target}`,
      };
    }
    if (!recorded) {
      return {
        state: 'unmanaged',
        reason: 'the existing projection has no Megamono ownership record',
      };
    }
    return { state: 'current', reason: 'the managed projection is current' };
  }

  if (recorded && !options.allowRecreate) {
    return {
      state: 'missing',
      reason:
        'the managed projection is missing and recreation was not confirmed',
    };
  }

  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(SKILLS_PROJECTION_TARGET, linkPath, 'dir');
  writeArtifactRegistryToDisk(
    workspaceRoot,
    upsertArtifactEntry(registry, projectionArtifact(sourceVersion)),
  );
  return {
    state: 'installed',
    reason: recorded
      ? 'the missing managed projection was recreated'
      : 'the managed projection was created and registered',
  };
}
