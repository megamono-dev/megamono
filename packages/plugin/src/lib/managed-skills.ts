import type { Tree } from '@nx/devkit';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import matter = require('gray-matter');
import type { Diagnostic } from './diagnostics';
import {
  ejectManagedArtifact,
  hashArtifactFileSet,
  readArtifactRegistry,
  readArtifactRegistryFromDisk,
  upsertArtifactEntry,
  writeArtifactRegistry,
  type ManagedArtifactEntry,
  type ManagedArtifactRegistry,
} from './managed-artifacts';

export const MANAGED_SKILL_NAMES = [
  'structure-review',
  'plan-sync',
  'drift-check',
  'decision-capture',
  'docs-placement',
  'archive-review',
  'visibility-recheck',
  'dependency-review',
] as const;

export type ManagedSkillName = (typeof MANAGED_SKILL_NAMES)[number];

/** @deprecated Legacy prerelease provenance read only for registry migration. */
export interface ManagedSkillProvenance {
  readonly schemaVersion: 1;
  readonly name: ManagedSkillName;
  readonly pluginVersion: string;
  readonly templateHash: string;
  readonly files: readonly string[];
}

export interface ManagedSkillTemplate {
  readonly name: ManagedSkillName;
  readonly description: string;
  readonly templateHash: string;
  readonly files: Readonly<Record<string, string>>;
  readonly positivePrompts: readonly string[];
  readonly negativePrompts: readonly string[];
}

export type ManagedSkillInstallState =
  | 'installed'
  | 'updated'
  | 'migrated'
  | 'current'
  | 'modified'
  | 'ejected'
  | 'unmanaged'
  | 'invalid-provenance';

export interface ManagedSkillInstallResult {
  readonly name: ManagedSkillName;
  readonly state: ManagedSkillInstallState;
  readonly reason: string;
}

export type ManagedSkillHealthState =
  | 'current'
  | 'missing'
  | 'modified'
  | 'outdated'
  | 'ejected'
  | 'invalid-provenance';

export interface ManagedSkillsHealthState {
  readonly available: boolean;
  readonly skills: Readonly<
    Partial<Record<ManagedSkillName, ManagedSkillHealthState>>
  >;
}

const LEGACY_PROVENANCE_FILE = '.megamono-skill.json';
const TEMPLATE_ROOT = resolve(__dirname, '..', 'skills');
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function listDiskFiles(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => comparePaths(left.name, right.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      if (entry.isFile()) files.push(normalizePath(relative(directory, path)));
    }
  };
  visit(directory);
  return files;
}

export function hashManagedSkillFiles(
  files: Readonly<Record<string, string>>,
): string {
  return hashArtifactFileSet(files);
}

function hashLegacyManagedSkillFiles(
  files: Readonly<Record<string, string>>,
): string {
  const hash = createHash('sha256');
  for (const [path, content] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(path);
    hash.update('\0');
    hash.update(String(Buffer.byteLength(content)));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function parseTriggerPrompts(source: string): {
  readonly positive: readonly string[];
  readonly negative: readonly string[];
} {
  const sections: Record<'positive' | 'negative', string[]> = {
    positive: [],
    negative: [],
  };
  let section: keyof typeof sections | undefined;
  for (const line of source.split(/\r?\n/)) {
    if (/^## Positive prompts\s*$/.test(line)) section = 'positive';
    else if (/^## Negative prompts\s*$/.test(line)) section = 'negative';
    else {
      const prompt = line.match(/^- (.+)$/)?.[1]?.trim();
      if (section && prompt) sections[section].push(prompt);
    }
  }
  return sections;
}

function loadTemplate(name: ManagedSkillName): ManagedSkillTemplate {
  const directory = join(TEMPLATE_ROOT, name);
  if (!existsSync(directory)) {
    throw new Error(`Managed skill template ${name} is missing.`);
  }
  const files = Object.fromEntries(
    listDiskFiles(directory).map((path) => [
      path,
      readFileSync(join(directory, path), 'utf8'),
    ]),
  );
  const entrypoint = files['SKILL.md'];
  if (!entrypoint) throw new Error(`Managed skill ${name} requires SKILL.md.`);
  const parsed = matter(entrypoint);
  if (parsed.data.name !== name) {
    throw new Error(
      `Managed skill ${name} declares invalid name ${String(parsed.data.name)}.`,
    );
  }
  if (
    typeof parsed.data.description !== 'string' ||
    !parsed.data.description.trim()
  ) {
    throw new Error(`Managed skill ${name} requires a description.`);
  }
  const triggerSource = files['references/triggers.md'];
  if (!triggerSource) {
    throw new Error(`Managed skill ${name} requires references/triggers.md.`);
  }
  const prompts = parseTriggerPrompts(triggerSource);
  if (prompts.positive.length < 5 || prompts.negative.length < 5) {
    throw new Error(
      `Managed skill ${name} requires at least five positive and five negative prompts.`,
    );
  }
  return {
    name,
    description: parsed.data.description,
    templateHash: hashManagedSkillFiles(files),
    files,
    positivePrompts: prompts.positive,
    negativePrompts: prompts.negative,
  };
}

export function loadManagedSkillTemplates(): readonly ManagedSkillTemplate[] {
  const templates = MANAGED_SKILL_NAMES.map(loadTemplate);
  const names = new Set(templates.map(({ name }) => name));
  if (names.size !== templates.length) {
    throw new Error('Managed skill template names must be unique.');
  }
  return templates;
}

export function readPluginVersion(): string {
  const manifest = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as { readonly version?: unknown };
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('@megamono/plugin package version is missing.');
  }
  return manifest.version;
}

function skillDirectory(name: ManagedSkillName): string {
  return `.agents/skills/${name}`;
}

function skillArtifactId(name: ManagedSkillName): string {
  return `skill.${name}`;
}

function legacyProvenancePath(name: ManagedSkillName): string {
  return `${skillDirectory(name)}/${LEGACY_PROVENANCE_FILE}`;
}

function listTreeFiles(tree: Tree, directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const child of tree.children(current).sort(comparePaths)) {
      const path = current ? `${current}/${child}` : child;
      if (tree.isFile(path)) files.push(path);
      else visit(path);
    }
  };
  visit(directory);
  return files;
}

function treeSkillFiles(
  tree: Tree,
  name: ManagedSkillName,
  listedFiles?: readonly string[],
): Record<string, string> | undefined {
  const directory = skillDirectory(name);
  const paths =
    listedFiles?.map((path) => `${directory}/${path}`) ??
    listTreeFiles(tree, directory).filter(
      (path) => !path.endsWith(`/${LEGACY_PROVENANCE_FILE}`),
    );
  const files: Record<string, string> = {};
  for (const path of paths) {
    const content = tree.read(path, 'utf8');
    if (content === null) return undefined;
    files[path.slice(directory.length + 1)] = content;
  }
  return files;
}

function parseLegacyProvenance(
  source: string | null,
  name: ManagedSkillName,
): ManagedSkillProvenance | undefined {
  if (!source) return undefined;
  try {
    const value = JSON.parse(source) as Partial<ManagedSkillProvenance>;
    if (
      value.schemaVersion !== 1 ||
      value.name !== name ||
      typeof value.pluginVersion !== 'string' ||
      typeof value.templateHash !== 'string' ||
      !Array.isArray(value.files) ||
      !value.files.every((path) => typeof path === 'string')
    ) {
      return undefined;
    }
    return value as ManagedSkillProvenance;
  } catch {
    return undefined;
  }
}

function validLegacyInstallation(
  tree: Tree,
  name: ManagedSkillName,
  provenance: ManagedSkillProvenance,
): Record<string, string> | undefined {
  const expectedFiles = [...provenance.files].sort(comparePaths);
  const installedFiles = treeSkillFiles(tree, name);
  if (
    !installedFiles ||
    new Set(provenance.files).size !== provenance.files.length ||
    Object.keys(installedFiles).sort(comparePaths).join('\0') !==
      expectedFiles.join('\0') ||
    hashLegacyManagedSkillFiles(installedFiles) !== provenance.templateHash
  ) {
    return undefined;
  }
  return installedFiles;
}

function skillArtifact(
  template: ManagedSkillTemplate,
  sourceVersion: string,
  installedHash = template.templateHash,
): ManagedArtifactEntry {
  return {
    id: skillArtifactId(template.name),
    module: 'skills',
    mode: 'managed',
    target: skillDirectory(template.name),
    sourceVersion,
    templateHash: template.templateHash,
    installedHash,
    state: 'managed',
    ejectable: true,
    files: Object.keys(template.files).sort(comparePaths),
  };
}

function isExpectedSkillArtifact(
  artifact: ManagedArtifactEntry,
  name: ManagedSkillName,
): boolean {
  return (
    artifact.id === skillArtifactId(name) &&
    artifact.module === 'skills' &&
    artifact.mode === 'managed' &&
    artifact.target === skillDirectory(name) &&
    artifact.ejectable &&
    Array.isArray(artifact.files) &&
    artifact.files.includes('SKILL.md')
  );
}

function installTemplate(tree: Tree, template: ManagedSkillTemplate): void {
  for (const [path, content] of Object.entries(template.files)) {
    tree.write(`${skillDirectory(template.name)}/${path}`, content);
  }
}

export function applyManagedSkillTemplates(
  tree: Tree,
  templates = loadManagedSkillTemplates(),
  pluginVersion = readPluginVersion(),
): readonly ManagedSkillInstallResult[] {
  let registry = readArtifactRegistry(tree);
  let registryChanged = false;
  const actions = templates.map((template) => {
    const artifact = registry.artifacts.find(
      ({ id }) => id === skillArtifactId(template.name),
    );
    const legacySource = tree.read(legacyProvenancePath(template.name), 'utf8');
    const allInstalledFiles = treeSkillFiles(tree, template.name);
    const hasInstalledFiles = Boolean(
      allInstalledFiles && Object.keys(allInstalledFiles).length > 0,
    );
    if (artifact) {
      if (legacySource || !isExpectedSkillArtifact(artifact, template.name)) {
        return { template, state: 'invalid-provenance' as const };
      }
      if (artifact.state === 'ejected') {
        return { template, state: 'ejected' as const };
      }
      const installedFiles = treeSkillFiles(
        tree,
        template.name,
        artifact.files,
      );
      if (
        !installedFiles ||
        hashManagedSkillFiles(installedFiles) !== artifact.installedHash
      ) {
        return { template, state: 'modified' as const, artifact };
      }
      if (
        artifact.templateHash !== template.templateHash ||
        artifact.sourceVersion !== pluginVersion ||
        artifact.files?.join('\0') !==
          Object.keys(template.files).sort(comparePaths).join('\0')
      ) {
        return { template, state: 'updated' as const, artifact };
      }
      return { template, state: 'current' as const };
    }
    if (legacySource) {
      const provenance = parseLegacyProvenance(legacySource, template.name);
      const installedFiles =
        provenance && validLegacyInstallation(tree, template.name, provenance);
      if (!provenance || !installedFiles) {
        return { template, state: 'invalid-provenance' as const };
      }
      return {
        template,
        state: 'migrated' as const,
        provenance,
        installedHash: hashManagedSkillFiles(installedFiles),
      };
    }
    if (!hasInstalledFiles) return { template, state: 'installed' as const };
    if (allInstalledFiles?.['SKILL.md']) {
      return { template, state: 'ejected' as const };
    }
    return { template, state: 'unmanaged' as const };
  });

  for (const action of actions) {
    if (action.state === 'updated' && action.artifact.files) {
      for (const path of action.artifact.files) {
        tree.delete(`${skillDirectory(action.template.name)}/${path}`);
      }
    }
    if (action.state === 'installed' || action.state === 'updated') {
      installTemplate(tree, action.template);
      registry = upsertArtifactEntry(
        registry,
        skillArtifact(action.template, pluginVersion),
      );
      registryChanged = true;
    }
    if (action.state === 'migrated') {
      registry = upsertArtifactEntry(
        registry,
        skillArtifact(
          action.template,
          action.provenance.pluginVersion,
          action.installedHash,
        ),
      );
      tree.delete(legacyProvenancePath(action.template.name));
      registryChanged = true;
    }
  }
  if (registryChanged) writeArtifactRegistry(tree, registry);

  return actions.map(({ template, state }) => ({
    name: template.name,
    state,
    reason:
      state === 'installed'
        ? 'installed managed template and registered its artifact'
        : state === 'updated'
          ? 'updated pristine managed template and registry hashes'
          : state === 'migrated'
            ? 'migrated validated legacy provenance into the artifact registry'
            : state === 'current'
              ? 'managed template is current'
              : state === 'modified'
                ? 'managed files differ from their recorded installed hash'
                : state === 'ejected'
                  ? 'skill is repository-owned and will not be reclaimed'
                  : state === 'unmanaged'
                    ? 'skill directory contains unowned files'
                    : 'managed provenance is invalid or conflicting',
  }));
}

export function ejectManagedSkill(
  tree: Tree,
  name: ManagedSkillName,
  options: { readonly dryRun?: boolean } = {},
): 'ejected' | 'already-ejected' {
  const entrypoint = `${skillDirectory(name)}/SKILL.md`;
  if (!tree.exists(entrypoint)) {
    throw new Error(`Managed skill ${name} is not installed.`);
  }
  let registry = readArtifactRegistry(tree);
  let artifact = registry.artifacts.find(
    ({ id }) => id === skillArtifactId(name),
  );
  if (!artifact) {
    const legacySource = tree.read(legacyProvenancePath(name), 'utf8');
    if (!legacySource) return 'already-ejected';
    const provenance = parseLegacyProvenance(legacySource, name);
    const installedFiles =
      provenance && validLegacyInstallation(tree, name, provenance);
    if (!provenance || !installedFiles) {
      throw new Error(
        `Managed skill ${name} has invalid legacy provenance; repair it before ejection.`,
      );
    }
    if (options.dryRun) return 'ejected';
    const template = loadManagedSkillTemplates().find(
      (candidate) => candidate.name === name,
    );
    if (!template)
      throw new Error(`Managed skill template ${name} is missing.`);
    artifact = skillArtifact(
      template,
      provenance.pluginVersion,
      hashManagedSkillFiles(installedFiles),
    );
    registry = upsertArtifactEntry(registry, artifact);
    writeArtifactRegistry(tree, registry);
    tree.delete(legacyProvenancePath(name));
  }
  if (!isExpectedSkillArtifact(artifact, name)) {
    throw new Error(
      `Managed skill ${name} has conflicting artifact provenance; repair it before ejection.`,
    );
  }
  return ejectManagedArtifact(tree, skillArtifactId(name), options).state ===
    'already-ejected'
    ? 'already-ejected'
    : 'ejected';
}

function diskSkillFiles(
  directory: string,
  listedFiles?: readonly string[],
): Record<string, string> | undefined {
  if (!existsSync(directory)) return undefined;
  const paths =
    listedFiles ??
    listDiskFiles(directory).filter((path) => path !== LEGACY_PROVENANCE_FILE);
  const files: Record<string, string> = {};
  for (const path of paths) {
    const absolutePath = join(directory, path);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      return undefined;
    }
    files[path] = readFileSync(absolutePath, 'utf8');
  }
  return files;
}

function inspectLegacySkill(
  directory: string,
  template: ManagedSkillTemplate,
): ManagedSkillHealthState {
  const entrypoint = join(directory, 'SKILL.md');
  const provenanceFile = join(directory, LEGACY_PROVENANCE_FILE);
  if (!existsSync(entrypoint) && !existsSync(provenanceFile)) return 'missing';
  if (!existsSync(provenanceFile)) return 'ejected';
  const provenance = parseLegacyProvenance(
    readFileSync(provenanceFile, 'utf8'),
    template.name,
  );
  const installedFiles = diskSkillFiles(directory);
  if (
    !provenance ||
    !installedFiles ||
    Object.keys(installedFiles).sort(comparePaths).join('\0') !==
      [...(provenance?.files ?? [])].sort(comparePaths).join('\0')
  ) {
    return 'invalid-provenance';
  }
  if (hashLegacyManagedSkillFiles(installedFiles) !== provenance.templateHash) {
    return 'modified';
  }
  return hashLegacyManagedSkillFiles(template.files) === provenance.templateHash
    ? 'current'
    : 'outdated';
}

export function inspectManagedSkills(
  workspaceRoot: string,
  templates = loadManagedSkillTemplates(),
): ManagedSkillsHealthState {
  const root = join(workspaceRoot, '.agents', 'skills');
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { available: false, skills: {} };
  }
  let registry: ManagedArtifactRegistry;
  try {
    registry = readArtifactRegistryFromDisk(workspaceRoot);
  } catch {
    return {
      available: true,
      skills: Object.fromEntries(
        templates.map(({ name }) => [name, 'invalid-provenance']),
      ),
    };
  }
  const skills = {} as Record<ManagedSkillName, ManagedSkillHealthState>;
  for (const template of templates) {
    const directory = join(root, template.name);
    const artifact = registry.artifacts.find(
      ({ id }) => id === skillArtifactId(template.name),
    );
    if (!artifact) {
      skills[template.name] = inspectLegacySkill(directory, template);
      continue;
    }
    if (!isExpectedSkillArtifact(artifact, template.name)) {
      skills[template.name] = 'invalid-provenance';
      continue;
    }
    if (artifact.state === 'ejected') {
      skills[template.name] = 'ejected';
      continue;
    }
    const installedFiles = diskSkillFiles(directory, artifact.files);
    if (!installedFiles) {
      skills[template.name] = 'missing';
      continue;
    }
    if (hashManagedSkillFiles(installedFiles) !== artifact.installedHash) {
      skills[template.name] = 'modified';
      continue;
    }
    skills[template.name] =
      artifact.templateHash === template.templateHash ? 'current' : 'outdated';
  }
  return { available: true, skills };
}

export function validateInstalledSkills(workspaceRoot: string): Diagnostic[] {
  const root = join(workspaceRoot, '.agents', 'skills');
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const diagnostics: Diagnostic[] = [];
  const names = new Map<string, string>();
  for (const entry of readdirSync(root, { withFileTypes: true }).sort(
    (left, right) => comparePaths(left.name, right.name),
  )) {
    if (!entry.isDirectory()) continue;
    const relativePath = `.agents/skills/${entry.name}/SKILL.md`;
    const entrypoint = join(root, entry.name, 'SKILL.md');
    if (!existsSync(entrypoint)) continue;
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(readFileSync(entrypoint, 'utf8'));
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'skill-front-matter',
        path: relativePath,
        message: `Unable to parse skill front matter: ${(error as Error).message}`,
      });
      continue;
    }
    const name = parsed.data.name;
    const description = parsed.data.description;
    if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      diagnostics.push({
        severity: 'error',
        code: 'skill-name',
        path: relativePath,
        message: 'Skill name must be a lowercase hyphenated string.',
      });
      continue;
    }
    if (name !== entry.name) {
      diagnostics.push({
        severity: 'error',
        code: 'skill-name',
        path: relativePath,
        message: `Skill name ${name} must match directory ${entry.name}.`,
      });
    }
    if (typeof description !== 'string' || !description.trim()) {
      diagnostics.push({
        severity: 'error',
        code: 'skill-description',
        path: relativePath,
        message: 'Skill description must be a non-empty string.',
      });
    }
    const duplicate = names.get(name);
    if (duplicate) {
      diagnostics.push({
        severity: 'error',
        code: 'skill-duplicate-name',
        path: relativePath,
        message: `Skill name ${name} is also declared by ${duplicate}.`,
      });
    } else {
      names.set(name, relativePath);
    }
  }
  return diagnostics;
}
