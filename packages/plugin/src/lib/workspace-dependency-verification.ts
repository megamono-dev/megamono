import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { satisfies, valid } from 'semver';
import { parse } from 'yaml';

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.nx',
  '.yalc',
  '.next',
  '.build',
  'coverage',
  'dist',
  'node_modules',
]);
const KNOWN_EXECUTABLES: Readonly<Record<string, string>> = {
  eslint: 'eslint',
  jest: 'jest',
  nest: '@nestjs/cli',
  next: 'next',
  nx: 'nx',
  playwright: '@playwright/test',
  prisma: 'prisma',
  tsc: 'typescript',
  'ts-node': 'ts-node',
  tsx: 'tsx',
  vite: 'vite',
  vitest: 'vitest',
  webpack: 'webpack',
  wrangler: 'wrangler',
};

export type WorkspaceDependencyFindingCode =
  | 'active-node-mismatch'
  | 'active-pnpm-mismatch'
  | 'package-manager-unpinned'
  | 'pnpm-lockfile-missing'
  | 'script-dependency-missing'
  | 'script-dependency-sibling-only'
  | 'workspace-package-omitted';

export interface WorkspaceDependencyFinding {
  readonly code: WorkspaceDependencyFindingCode;
  readonly severity: 'error';
  readonly manifest: string;
  readonly dependency?: string;
  readonly script?: string;
  readonly message: string;
}

export interface WorkspaceDependencyReport {
  readonly schemaVersion: 1;
  readonly packageManager: string | null;
  readonly manifests: readonly string[];
  readonly findings: readonly WorkspaceDependencyFinding[];
}

interface Manifest {
  readonly name?: string;
  readonly packageManager?: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

interface ManifestRecord {
  readonly path: string;
  readonly directory: string;
  readonly manifest: Manifest;
  readonly dependencies: ReadonlySet<string>;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function packageManifests(
  root: string,
  directory = root,
): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      result.push(...(await packageManifests(root, path)));
    else if (entry.isFile() && entry.name === 'package.json') result.push(path);
  }
  return result.sort(compare);
}

function dependencies(manifest: Manifest): ReadonlySet<string> {
  return new Set(
    [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ].flatMap((field) => Object.keys(field ?? {})),
  );
}

function dependencyName(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/'))
    return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function scriptRequirements(source: string): readonly string[] {
  const required = new Set<string>();
  for (const match of source.matchAll(
    /(?:^|&&|\|\||;)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:(?:pnpm|npm|yarn|bun)\s+(?:exec\s+)?|npx\s+)?([A-Za-z0-9@._-]+)/g,
  )) {
    const dependency = KNOWN_EXECUTABLES[match[1]];
    if (dependency) required.add(dependency);
  }
  for (const match of source.matchAll(
    /(?:^|\s)(?:--require|-r)\s+(?:=\s*)?['"]?([^\s'"]+)/g,
  )) {
    const dependency = dependencyName(match[1]);
    if (dependency) required.add(dependency);
  }
  return [...required].sort(compare);
}

function globPattern(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (character === '*') source += '[^/]*';
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function includedByWorkspace(
  directory: string,
  patterns: readonly string[],
): boolean {
  let included = false;
  for (const raw of patterns) {
    const excluded = raw.startsWith('!');
    const pattern = excluded ? raw.slice(1) : raw;
    if (globPattern(pattern).test(directory)) included = !excluded;
  }
  return included;
}

export async function verifyWorkspaceDependencies(options: {
  readonly workspaceRoot: string;
  readonly activeNode?: string;
  readonly activePnpm?: string;
}): Promise<WorkspaceDependencyReport> {
  const paths = await packageManifests(options.workspaceRoot);
  const records: ManifestRecord[] = await Promise.all(
    paths.map(async (path) => {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest;
      return {
        path: relative(options.workspaceRoot, path) || 'package.json',
        directory: relative(options.workspaceRoot, dirname(path)) || '.',
        dependencies: dependencies(manifest),
        manifest,
      };
    }),
  );
  const root = records.find(({ path }) => path === 'package.json');
  if (!root)
    throw new Error('Workspace dependency verification requires package.json.');
  const manager = root.manifest.packageManager ?? null;
  const findings: WorkspaceDependencyFinding[] = [];
  if (manager?.startsWith('pnpm@')) {
    const requested = manager.slice('pnpm@'.length);
    if (!valid(requested))
      findings.push({
        code: 'package-manager-unpinned',
        severity: 'error',
        manifest: 'package.json',
        message: `packageManager must pin an exact pnpm version; received ${manager}.`,
      });
    if (!(await exists(join(options.workspaceRoot, 'pnpm-lock.yaml'))))
      findings.push({
        code: 'pnpm-lockfile-missing',
        severity: 'error',
        manifest: 'package.json',
        message: 'packageManager selects pnpm but pnpm-lock.yaml is missing.',
      });
    const pnpmRange = root.manifest.engines?.pnpm;
    if (
      options.activePnpm &&
      ((valid(requested) && options.activePnpm !== requested) ||
        (pnpmRange && !satisfies(options.activePnpm, pnpmRange)))
    )
      findings.push({
        code: 'active-pnpm-mismatch',
        severity: 'error',
        manifest: 'package.json',
        message: `Active pnpm ${options.activePnpm} does not satisfy the committed ${manager}${pnpmRange ? ` and engines.pnpm ${pnpmRange}` : ''}.`,
      });
  }
  const nodeRange = root.manifest.engines?.node;
  if (
    options.activeNode &&
    nodeRange &&
    !satisfies(options.activeNode, nodeRange)
  )
    findings.push({
      code: 'active-node-mismatch',
      severity: 'error',
      manifest: 'package.json',
      message: `Active Node ${options.activeNode} does not satisfy engines.node ${nodeRange}.`,
    });

  const owners = new Map<string, string[]>();
  for (const record of records)
    for (const dependency of record.dependencies) {
      const paths = owners.get(dependency) ?? [];
      paths.push(record.path);
      owners.set(dependency, paths);
    }
  for (const record of records)
    for (const [script, source] of Object.entries(
      record.manifest.scripts ?? {},
    ))
      for (const dependency of scriptRequirements(source)) {
        if (
          record.dependencies.has(dependency) ||
          root.dependencies.has(dependency)
        )
          continue;
        const siblingOwners = owners.get(dependency) ?? [];
        findings.push({
          code:
            siblingOwners.length > 0
              ? 'script-dependency-sibling-only'
              : 'script-dependency-missing',
          severity: 'error',
          manifest: record.path,
          dependency,
          script,
          message:
            siblingOwners.length > 0
              ? `${record.path} script ${script} uses ${dependency}, which is declared only by ${siblingOwners.sort(compare).join(', ')}.`
              : `${record.path} script ${script} uses undeclared dependency ${dependency}.`,
        });
      }

  if (manager?.startsWith('pnpm@')) {
    const workspacePath = join(options.workspaceRoot, 'pnpm-workspace.yaml');
    if (await exists(workspacePath)) {
      const workspace = parse(await readFile(workspacePath, 'utf8')) as unknown;
      const patterns =
        workspace &&
        typeof workspace === 'object' &&
        !Array.isArray(workspace) &&
        Array.isArray((workspace as Record<string, unknown>).packages)
          ? (
              (workspace as Record<string, unknown>).packages as unknown[]
            ).filter((value): value is string => typeof value === 'string')
          : [];
      for (const record of records.filter(({ directory }) => directory !== '.'))
        if (!includedByWorkspace(record.directory, patterns))
          findings.push({
            code: 'workspace-package-omitted',
            severity: 'error',
            manifest: record.path,
            message: `${record.path} is not included by pnpm-workspace.yaml packages.`,
          });
    }
  }
  return {
    schemaVersion: 1,
    packageManager: manager,
    manifests: records.map(({ path }) => path),
    findings: findings.sort(
      (left, right) =>
        compare(left.manifest, right.manifest) ||
        compare(left.code, right.code) ||
        compare(left.dependency ?? '', right.dependency ?? ''),
    ),
  };
}

export function serializeWorkspaceDependencyReport(
  report: WorkspaceDependencyReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
