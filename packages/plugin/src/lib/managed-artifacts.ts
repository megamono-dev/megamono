import type { Tree } from '@nx/devkit';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import type { Diagnostic } from './diagnostics';

export const ARTIFACT_REGISTRY_PATH = '.megamono/artifacts.json';
export const ARTIFACT_REGISTRY_SCHEMA_VERSION = 1;
export const ARTIFACT_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;
export const ARTIFACT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const RESERVED_ARTIFACT_IDS = [
  'agents.instructions',
  'agents.claude-pointer',
  'ci.affected',
  'health.workflow',
  'docs.loader',
  'docs.index',
  'docs.archive-index',
] as const;

export type ArtifactMode = 'managed' | 'managed-section' | 'seeded' | 'derived';
export type ArtifactState = 'managed' | 'seeded' | 'derived' | 'ejected';

export interface ManagedArtifactEntry {
  readonly id: string;
  readonly module: string;
  readonly mode: ArtifactMode;
  readonly target: string;
  readonly sourceVersion: string;
  readonly templateHash: string;
  readonly installedHash: string;
  readonly state: ArtifactState;
  readonly ejectable: boolean;
  readonly startDelimiter?: string;
  readonly endDelimiter?: string;
  readonly files?: readonly string[];
}

export interface ManagedArtifactRegistry {
  readonly schemaVersion: 1;
  readonly artifacts: readonly ManagedArtifactEntry[];
}

export type ManagedArtifactInspectionState =
  'current' | 'modified' | 'missing' | 'ejected';

export interface ManagedArtifactInspection {
  readonly artifact: ManagedArtifactEntry;
  readonly state: ManagedArtifactInspectionState;
  readonly actualHash?: string;
  readonly reason: string;
}

export interface ManagedArtifactEjectionPlan {
  readonly artifact: ManagedArtifactEntry;
  readonly state: 'eject' | 'already-ejected';
  readonly targetAction: 'preserve' | 'remove-delimiters' | 'none';
  readonly registryAction: 'mark-ejected' | 'none';
}

export class ArtifactRegistryError extends Error {
  readonly code = 'megamono-artifact-registry-invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ArtifactRegistryError';
  }
}

function normalizePath(path: string): string {
  return posix.normalize(path.split(sep).join('/'));
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isSafeArtifactPath(path: string): boolean {
  if (!path || path.includes('\\') || path.startsWith('/')) return false;
  const normalized = posix.normalize(path);
  return (
    normalized === path &&
    normalized !== '.' &&
    normalized !== '..' &&
    !normalized.startsWith('../')
  );
}

export function hashArtifactBytes(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export function hashArtifactFileSet(
  files: Readonly<Record<string, string | Buffer>>,
): string {
  const hash = createHash('sha256');
  for (const [path, content] of Object.entries(files).sort(([left], [right]) =>
    comparePaths(left, right),
  )) {
    if (!isSafeArtifactPath(path)) {
      throw new ArtifactRegistryError(
        `Managed artifact file path ${JSON.stringify(path)} is not workspace-relative.`,
      );
    }
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    hash.update(path);
    hash.update('\0');
    hash.update(String(bytes.byteLength));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function hashArtifactSymlinkTarget(target: string): string {
  return hashArtifactBytes(normalizePath(target));
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArtifactRegistryError(`${label} must be an object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ArtifactRegistryError(
      `${label} contains unknown ${unknown.length === 1 ? 'key' : 'keys'}: ${unknown.join(', ')}.`,
    );
  }
}

function parseArtifactEntry(
  value: unknown,
  index: number,
): ManagedArtifactEntry {
  const label = `artifacts[${index}]`;
  assertPlainObject(value, label);
  assertExactKeys(
    value,
    [
      'id',
      'module',
      'mode',
      'target',
      'sourceVersion',
      'templateHash',
      'installedHash',
      'state',
      'ejectable',
      'startDelimiter',
      'endDelimiter',
      'files',
    ],
    label,
  );
  const requiredStrings = [
    'id',
    'module',
    'mode',
    'target',
    'sourceVersion',
    'templateHash',
    'installedHash',
    'state',
  ] as const;
  for (const key of requiredStrings) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new ArtifactRegistryError(
        `${label}.${key} must be a non-empty string.`,
      );
    }
  }
  if (typeof value.ejectable !== 'boolean') {
    throw new ArtifactRegistryError(`${label}.ejectable must be a boolean.`);
  }
  const entry = value as unknown as ManagedArtifactEntry;
  if (!ARTIFACT_ID_PATTERN.test(entry.id)) {
    throw new ArtifactRegistryError(`${label}.id is not a valid artifact ID.`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(entry.module)) {
    throw new ArtifactRegistryError(
      `${label}.module must be a lowercase hyphenated name.`,
    );
  }
  if (
    !['managed', 'managed-section', 'seeded', 'derived'].includes(entry.mode)
  ) {
    throw new ArtifactRegistryError(`${label}.mode is not supported.`);
  }
  if (!['managed', 'seeded', 'derived', 'ejected'].includes(entry.state)) {
    throw new ArtifactRegistryError(`${label}.state is not supported.`);
  }
  if (!isSafeArtifactPath(entry.target)) {
    throw new ArtifactRegistryError(
      `${label}.target must be a normalized workspace-relative path.`,
    );
  }
  if (entry.target === ARTIFACT_REGISTRY_PATH) {
    throw new ArtifactRegistryError('The artifact registry cannot own itself.');
  }
  if (
    entry.id.startsWith('playstack.') ||
    entry.target === 'playstack.json' ||
    entry.target === 'playstack.artifacts.json' ||
    entry.target.startsWith('.playstack/')
  ) {
    throw new ArtifactRegistryError(
      `${label} attempts to register Playstack-owned artifact state.`,
    );
  }
  if (
    !ARTIFACT_HASH_PATTERN.test(entry.templateHash) ||
    !ARTIFACT_HASH_PATTERN.test(entry.installedHash)
  ) {
    throw new ArtifactRegistryError(
      `${label} templateHash and installedHash must be SHA-256 hashes.`,
    );
  }
  const expectedState =
    entry.mode === 'seeded'
      ? 'seeded'
      : entry.mode === 'derived'
        ? 'derived'
        : 'managed';
  if (entry.state !== expectedState && entry.state !== 'ejected') {
    throw new ArtifactRegistryError(
      `${label}.state must be ${expectedState} or ejected for mode ${entry.mode}.`,
    );
  }
  if (entry.mode === 'managed-section') {
    if (
      typeof entry.startDelimiter !== 'string' ||
      !entry.startDelimiter ||
      typeof entry.endDelimiter !== 'string' ||
      !entry.endDelimiter ||
      entry.startDelimiter === entry.endDelimiter
    ) {
      throw new ArtifactRegistryError(
        `${label} must define distinct startDelimiter and endDelimiter values.`,
      );
    }
  } else if (
    entry.startDelimiter !== undefined ||
    entry.endDelimiter !== undefined
  ) {
    throw new ArtifactRegistryError(
      `${label} delimiters are allowed only for managed-section artifacts.`,
    );
  }
  if (entry.files !== undefined) {
    if (
      entry.mode !== 'managed' ||
      !Array.isArray(entry.files) ||
      entry.files.length === 0 ||
      !entry.files.every(
        (path) => typeof path === 'string' && isSafeArtifactPath(path),
      )
    ) {
      throw new ArtifactRegistryError(
        `${label}.files must be a non-empty managed file-set of relative paths.`,
      );
    }
    const sorted = [...entry.files].sort(comparePaths);
    if (
      new Set(entry.files).size !== entry.files.length ||
      entry.files.some((path, fileIndex) => path !== sorted[fileIndex])
    ) {
      throw new ArtifactRegistryError(
        `${label}.files must contain unique paths in lexical order.`,
      );
    }
  }
  return entry;
}

export function parseArtifactRegistry(source: string): ManagedArtifactRegistry {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ArtifactRegistryError(
      `Unable to parse ${ARTIFACT_REGISTRY_PATH}: ${(error as Error).message}`,
    );
  }
  assertPlainObject(value, 'Artifact registry');
  assertExactKeys(value, ['schemaVersion', 'artifacts'], 'Artifact registry');
  if (value.schemaVersion !== ARTIFACT_REGISTRY_SCHEMA_VERSION) {
    throw new ArtifactRegistryError(
      `Unsupported artifact registry schema version ${String(value.schemaVersion)}; expected ${ARTIFACT_REGISTRY_SCHEMA_VERSION}.`,
    );
  }
  if (!Array.isArray(value.artifacts)) {
    throw new ArtifactRegistryError(
      'Artifact registry artifacts must be an array.',
    );
  }
  const artifacts = value.artifacts.map(parseArtifactEntry);
  const ids = new Set<string>();
  for (const [index, artifact] of artifacts.entries()) {
    if (ids.has(artifact.id)) {
      throw new ArtifactRegistryError(`Duplicate artifact ID ${artifact.id}.`);
    }
    ids.add(artifact.id);
    if (index > 0 && artifacts[index - 1].id.localeCompare(artifact.id) >= 0) {
      throw new ArtifactRegistryError(
        'Artifact registry entries must be sorted by ID.',
      );
    }
  }
  return { schemaVersion: 1, artifacts };
}

export function renderArtifactRegistry(
  registry: ManagedArtifactRegistry,
): string {
  const artifacts = [...registry.artifacts].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const normalized = parseArtifactRegistry(
    JSON.stringify({ schemaVersion: 1, artifacts }),
  );
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function readArtifactRegistry(tree: Tree): ManagedArtifactRegistry {
  const source = tree.read(ARTIFACT_REGISTRY_PATH, 'utf8');
  if (source === null) return { schemaVersion: 1, artifacts: [] };
  return parseArtifactRegistry(source);
}

export function readArtifactRegistryFromDisk(
  workspaceRoot: string,
): ManagedArtifactRegistry {
  const path = resolve(workspaceRoot, ARTIFACT_REGISTRY_PATH);
  if (!existsSync(path)) return { schemaVersion: 1, artifacts: [] };
  return parseArtifactRegistry(readFileSync(path, 'utf8'));
}

export function writeArtifactRegistry(
  tree: Tree,
  registry: ManagedArtifactRegistry,
): void {
  tree.write(ARTIFACT_REGISTRY_PATH, renderArtifactRegistry(registry));
}

export function writeArtifactRegistryToDisk(
  workspaceRoot: string,
  registry: ManagedArtifactRegistry,
): void {
  writeFileSync(
    resolve(workspaceRoot, ARTIFACT_REGISTRY_PATH),
    renderArtifactRegistry(registry),
    'utf8',
  );
}

export function upsertArtifactEntry(
  registry: ManagedArtifactRegistry,
  artifact: ManagedArtifactEntry,
): ManagedArtifactRegistry {
  return parseArtifactRegistry(
    JSON.stringify({
      schemaVersion: 1,
      artifacts: [
        ...registry.artifacts.filter(({ id }) => id !== artifact.id),
        artifact,
      ].sort((left, right) => left.id.localeCompare(right.id)),
    }),
  );
}

export function planManagedArtifactEjection(
  tree: Tree,
  artifactId: string,
): ManagedArtifactEjectionPlan {
  const registry = readArtifactRegistry(tree);
  const artifact = registry.artifacts.find(({ id }) => id === artifactId);
  if (!artifact) {
    throw new ArtifactRegistryError(`Unknown managed artifact ${artifactId}.`);
  }
  if (!artifact.ejectable) {
    throw new ArtifactRegistryError(
      `Managed artifact ${artifactId} is not ejectable.`,
    );
  }
  if (artifact.state === 'ejected') {
    return {
      artifact,
      state: 'already-ejected',
      targetAction: 'none',
      registryAction: 'none',
    };
  }
  if (artifact.mode === 'managed-section') {
    const source = tree.read(artifact.target, 'utf8');
    if (
      source === null ||
      !artifact.startDelimiter ||
      !artifact.endDelimiter ||
      extractManagedSection(
        source,
        artifact.startDelimiter,
        artifact.endDelimiter,
      ) === undefined
    ) {
      throw new ArtifactRegistryError(
        `Managed section ${artifactId} does not contain its exact delimiters.`,
      );
    }
  }
  return {
    artifact,
    state: 'eject',
    targetAction:
      artifact.mode === 'managed-section' ? 'remove-delimiters' : 'preserve',
    registryAction: 'mark-ejected',
  };
}

export function applyManagedArtifactEjection(
  tree: Tree,
  plan: ManagedArtifactEjectionPlan,
): void {
  if (plan.state === 'already-ejected') return;
  const { artifact } = plan;
  if (plan.targetAction === 'remove-delimiters') {
    const source = tree.read(artifact.target, 'utf8');
    if (source === null || !artifact.startDelimiter || !artifact.endDelimiter) {
      throw new ArtifactRegistryError(
        `Managed section ${artifact.id} changed after its ejection plan was created.`,
      );
    }
    const start = source.indexOf(artifact.startDelimiter);
    const end = source.indexOf(
      artifact.endDelimiter,
      start + artifact.startDelimiter.length,
    );
    if (start < 0 || end < 0) {
      throw new ArtifactRegistryError(
        `Managed section ${artifact.id} changed after its ejection plan was created.`,
      );
    }
    tree.write(
      artifact.target,
      `${source.slice(0, start)}${source.slice(
        start + artifact.startDelimiter.length,
        end,
      )}${source.slice(end + artifact.endDelimiter.length)}`,
    );
  }
  const registry = readArtifactRegistry(tree);
  const current = registry.artifacts.find(({ id }) => id === artifact.id);
  if (!current || current.state === 'ejected') return;
  writeArtifactRegistry(
    tree,
    upsertArtifactEntry(registry, { ...current, state: 'ejected' }),
  );
}

export function ejectManagedArtifact(
  tree: Tree,
  artifactId: string,
  options: { readonly dryRun?: boolean } = {},
): ManagedArtifactEjectionPlan {
  const plan = planManagedArtifactEjection(tree, artifactId);
  if (!options.dryRun) applyManagedArtifactEjection(tree, plan);
  return plan;
}

export function extractManagedSection(
  content: string,
  startDelimiter: string,
  endDelimiter: string,
): string | undefined {
  const start = content.indexOf(startDelimiter);
  if (
    start < 0 ||
    content.indexOf(startDelimiter, start + startDelimiter.length) >= 0
  ) {
    return undefined;
  }
  const bodyStart = start + startDelimiter.length;
  const end = content.indexOf(endDelimiter, bodyStart);
  if (
    end < 0 ||
    content.indexOf(endDelimiter, end + endDelimiter.length) >= 0
  ) {
    return undefined;
  }
  return content.slice(bodyStart, end);
}

function diskFileSet(
  workspaceRoot: string,
  artifact: ManagedArtifactEntry,
): Record<string, Buffer> | undefined {
  if (!artifact.files) return undefined;
  const directory = resolve(workspaceRoot, artifact.target);
  const files: Record<string, Buffer> = {};
  for (const path of artifact.files) {
    const absolutePath = resolve(directory, path);
    if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile())
      return undefined;
    files[path] = readFileSync(absolutePath);
  }
  return files;
}

export function computeDiskArtifactHash(
  workspaceRoot: string,
  artifact: ManagedArtifactEntry,
): string | undefined {
  const absolutePath = resolve(workspaceRoot, artifact.target);
  if (artifact.files) {
    const files = diskFileSet(workspaceRoot, artifact);
    return files ? hashArtifactFileSet(files) : undefined;
  }
  if (!existsSync(absolutePath)) return undefined;
  const status = lstatSync(absolutePath);
  if (status.isSymbolicLink()) {
    return hashArtifactSymlinkTarget(readlinkSync(absolutePath));
  }
  if (!status.isFile()) return undefined;
  const content = readFileSync(absolutePath);
  if (artifact.mode !== 'managed-section') return hashArtifactBytes(content);
  if (!artifact.startDelimiter || !artifact.endDelimiter) return undefined;
  const section = extractManagedSection(
    content.toString('utf8'),
    artifact.startDelimiter,
    artifact.endDelimiter,
  );
  return section === undefined ? undefined : hashArtifactBytes(section);
}

export function inspectManagedArtifacts(
  workspaceRoot: string,
  registry: ManagedArtifactRegistry,
): readonly ManagedArtifactInspection[] {
  return registry.artifacts.map((artifact) => {
    if (artifact.state === 'ejected') {
      return {
        artifact,
        state: 'ejected' as const,
        reason: 'artifact is repository-owned after ejection',
      };
    }
    const actualHash = computeDiskArtifactHash(workspaceRoot, artifact);
    if (actualHash === undefined) {
      return {
        artifact,
        state: 'missing' as const,
        reason: 'artifact target or a listed file is missing',
      };
    }
    if (actualHash !== artifact.installedHash) {
      return {
        artifact,
        state: 'modified' as const,
        actualHash,
        reason: 'artifact bytes differ from the installed hash',
      };
    }
    return {
      artifact,
      state: 'current' as const,
      actualHash,
      reason: 'artifact matches its installed hash',
    };
  });
}

export function validateManagedArtifactRegistry(
  workspaceRoot: string,
): Diagnostic[] {
  const path = resolve(workspaceRoot, ARTIFACT_REGISTRY_PATH);
  if (!existsSync(path)) {
    return [
      {
        severity: 'error',
        code: 'artifact-registry-missing',
        path: ARTIFACT_REGISTRY_PATH,
        message:
          'Megamono artifact registry is missing; rerun workspace-init to restore ownership metadata.',
      },
    ];
  }
  let registry: ManagedArtifactRegistry;
  try {
    registry = readArtifactRegistryFromDisk(workspaceRoot);
  } catch (error) {
    return [
      {
        severity: 'error',
        code: 'artifact-registry-invalid',
        path: ARTIFACT_REGISTRY_PATH,
        message: (error as Error).message,
      },
    ];
  }
  return inspectManagedArtifacts(workspaceRoot, registry).flatMap(
    ({ artifact, state, actualHash }) => {
      if (
        state === 'current' ||
        state === 'ejected' ||
        artifact.mode === 'seeded'
      ) {
        return [];
      }
      return [
        {
          severity: 'error' as const,
          code: `managed-artifact-${state}`,
          path: artifact.target,
          message:
            state === 'missing'
              ? `Megamono artifact ${artifact.id} is missing.`
              : `Megamono artifact ${artifact.id} differs from installed hash ${artifact.installedHash}${actualHash ? ` (actual ${actualHash})` : ''}. Eject it to retain the customization or restore the managed artifact.`,
        },
      ];
    },
  );
}

export function listUnregisteredArtifactFiles(
  workspaceRoot: string,
  artifact: ManagedArtifactEntry,
): readonly string[] {
  if (!artifact.files) return [];
  const root = resolve(workspaceRoot, artifact.target);
  if (!existsSync(root)) return [];
  const registered = new Set(artifact.files);
  const unregistered: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else {
        const path = normalizePath(relative(root, absolutePath));
        if (!registered.has(path)) unregistered.push(path);
      }
    }
  };
  visit(root);
  return unregistered;
}
