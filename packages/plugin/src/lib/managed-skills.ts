import type { Tree } from '@nx/devkit';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import matter = require('gray-matter');
import type { Diagnostic } from './diagnostics';

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

const PROVENANCE_FILE = '.megamono-skill.json';
const TEMPLATE_ROOT = resolve(__dirname, '..', 'skills');
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}

function listDiskFiles(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
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

function provenancePath(name: ManagedSkillName): string {
  return `${skillDirectory(name)}/${PROVENANCE_FILE}`;
}

function listTreeFiles(tree: Tree, directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const child of tree.children(current).sort()) {
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
): Record<string, string> {
  const directory = skillDirectory(name);
  return Object.fromEntries(
    listTreeFiles(tree, directory)
      .filter((path) => !path.endsWith(`/${PROVENANCE_FILE}`))
      .map((path) => [
        path.slice(directory.length + 1),
        tree.read(path, 'utf8') ?? '',
      ]),
  );
}

function parseProvenance(
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

function renderProvenance(
  template: ManagedSkillTemplate,
  pluginVersion: string,
): string {
  return `${[
    '{',
    '  "schemaVersion": 1,',
    `  "name": ${JSON.stringify(template.name)},`,
    `  "pluginVersion": ${JSON.stringify(pluginVersion)},`,
    `  "templateHash": ${JSON.stringify(template.templateHash)},`,
    `  "files": ${JSON.stringify(Object.keys(template.files).sort())}`,
    '}',
  ].join('\n')}\n`;
}

export function applyManagedSkillTemplates(
  tree: Tree,
  templates = loadManagedSkillTemplates(),
  pluginVersion = readPluginVersion(),
): readonly ManagedSkillInstallResult[] {
  const actions = templates.map((template) => {
    const installedFiles = treeSkillFiles(tree, template.name);
    const hasInstalledFiles = Object.keys(installedFiles).length > 0;
    const provenanceSource = tree.read(provenancePath(template.name), 'utf8');
    const provenance = parseProvenance(provenanceSource, template.name);
    if (!provenanceSource && !hasInstalledFiles) {
      return { template, state: 'installed' as const };
    }
    if (!provenanceSource && installedFiles['SKILL.md']) {
      return { template, state: 'ejected' as const };
    }
    if (!provenanceSource) {
      return { template, state: 'unmanaged' as const };
    }
    if (!provenance) {
      return { template, state: 'invalid-provenance' as const };
    }
    if (hashManagedSkillFiles(installedFiles) !== provenance.templateHash) {
      return { template, state: 'modified' as const };
    }
    if (
      provenance.templateHash !== template.templateHash ||
      provenance.pluginVersion !== pluginVersion
    ) {
      return { template, state: 'updated' as const };
    }
    return { template, state: 'current' as const };
  });

  for (const action of actions) {
    const directory = skillDirectory(action.template.name);
    if (action.state === 'updated') {
      for (const path of listTreeFiles(tree, directory)) {
        if (!path.endsWith(`/${PROVENANCE_FILE}`)) tree.delete(path);
      }
    }
    if (action.state === 'installed' || action.state === 'updated') {
      for (const [path, content] of Object.entries(action.template.files)) {
        tree.write(`${directory}/${path}`, content);
      }
      tree.write(
        provenancePath(action.template.name),
        renderProvenance(action.template, pluginVersion),
      );
    }
  }

  return actions.map(({ template, state }) => ({
    name: template.name,
    state,
    reason:
      state === 'installed'
        ? 'installed managed template'
        : state === 'updated'
          ? 'updated pristine managed template'
          : state === 'current'
            ? 'managed template is current'
            : state === 'modified'
              ? 'managed files differ from their recorded template hash'
              : state === 'ejected'
                ? 'skill has no managed provenance'
                : state === 'unmanaged'
                  ? 'skill directory contains unowned files'
                  : 'managed provenance is invalid',
  }));
}

export function ejectManagedSkill(
  tree: Tree,
  name: ManagedSkillName,
): 'ejected' | 'already-ejected' {
  const entrypoint = `${skillDirectory(name)}/SKILL.md`;
  if (!tree.exists(entrypoint)) {
    throw new Error(`Managed skill ${name} is not installed.`);
  }
  const path = provenancePath(name);
  if (!tree.exists(path)) return 'already-ejected';
  const provenance = parseProvenance(tree.read(path, 'utf8'), name);
  if (!provenance) {
    throw new Error(
      `Managed skill ${name} has invalid provenance; repair it before ejection.`,
    );
  }
  tree.delete(path);
  return 'ejected';
}

function diskSkillFiles(directory: string): Record<string, string> {
  if (!existsSync(directory)) return {};
  return Object.fromEntries(
    listDiskFiles(directory)
      .filter((path) => path !== PROVENANCE_FILE)
      .map((path) => [path, readFileSync(join(directory, path), 'utf8')]),
  );
}

export function inspectManagedSkills(
  workspaceRoot: string,
  templates = loadManagedSkillTemplates(),
): ManagedSkillsHealthState {
  const root = join(workspaceRoot, '.agents', 'skills');
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { available: false, skills: {} };
  }
  const skills = {} as Record<ManagedSkillName, ManagedSkillHealthState>;
  for (const template of templates) {
    const directory = join(root, template.name);
    const entrypoint = join(directory, 'SKILL.md');
    const provenanceFile = join(directory, PROVENANCE_FILE);
    if (!existsSync(entrypoint) && !existsSync(provenanceFile)) {
      skills[template.name] = 'missing';
      continue;
    }
    if (!existsSync(provenanceFile)) {
      skills[template.name] = 'ejected';
      continue;
    }
    const provenance = parseProvenance(
      readFileSync(provenanceFile, 'utf8'),
      template.name,
    );
    if (!provenance) {
      skills[template.name] = 'invalid-provenance';
      continue;
    }
    if (
      hashManagedSkillFiles(diskSkillFiles(directory)) !==
      provenance.templateHash
    ) {
      skills[template.name] = 'modified';
      continue;
    }
    skills[template.name] =
      provenance.templateHash === template.templateHash
        ? 'current'
        : 'outdated';
  }
  return { available: true, skills };
}

export function validateInstalledSkills(workspaceRoot: string): Diagnostic[] {
  const root = join(workspaceRoot, '.agents', 'skills');
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const diagnostics: Diagnostic[] = [];
  const names = new Map<string, string>();
  for (const entry of readdirSync(root, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
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
