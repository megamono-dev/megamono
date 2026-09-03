import { builtinModules } from 'node:module';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const BUILT_INS = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, '')]),
);
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

export type RuntimeDependencyFindingCode =
  | 'runtime-dependency-dev-only'
  | 'runtime-dependency-missing'
  | 'runtime-output-missing';

export interface RuntimeDependencyFinding {
  readonly code: RuntimeDependencyFindingCode;
  readonly package: string | null;
  readonly severity: 'error';
  readonly evidence: readonly string[];
  readonly message: string;
}

export interface RuntimeDependencyReport {
  readonly schemaVersion: 1;
  readonly project: string;
  readonly outputPath: string;
  readonly manifests: readonly string[];
  readonly externalPackages: readonly string[];
  readonly findings: readonly RuntimeDependencyFinding[];
}

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
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

async function filesUnder(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await filesUnder(child)));
    else if (entry.isFile() && JAVASCRIPT_EXTENSIONS.has(extname(entry.name)))
      result.push(child);
  }
  return result.sort(compare);
}

function packageName(specifier: string): string | null {
  if (
    !specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#') ||
    specifier.includes('!') ||
    /^(?:data|file|https?):/.test(specifier)
  )
    return null;
  const normalized = specifier.replace(/^node:/, '');
  if (BUILT_INS.has(normalized)) return null;
  const parts = normalized.split('/');
  return normalized.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function externalSpecifiers(source: string): readonly string[] {
  const found = new Set<string>();
  const patterns = [
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns)
    for (const match of source.matchAll(pattern)) {
      const name = packageName(match[1]);
      if (name) found.add(name);
    }
  return [...found].sort(compare);
}

async function readManifest(path: string): Promise<PackageManifest | null> {
  if (!(await exists(path))) return null;
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest;
}

export async function verifyRuntimeDependencies(options: {
  readonly workspaceRoot: string;
  readonly project: string;
  readonly projectRoot: string;
  readonly outputPath: string;
}): Promise<RuntimeDependencyReport> {
  const output = resolve(options.workspaceRoot, options.outputPath);
  const rootManifestPath = join(options.workspaceRoot, 'package.json');
  const projectManifestPath = join(
    options.workspaceRoot,
    options.projectRoot,
    'package.json',
  );
  const manifestPaths = [rootManifestPath, projectManifestPath].filter(
    (path, index, paths) => paths.indexOf(path) === index,
  );
  const manifests = (
    await Promise.all(
      manifestPaths.map(async (path) => ({
        path,
        value: await readManifest(path),
      })),
    )
  ).filter(
    (entry): entry is { path: string; value: PackageManifest } =>
      entry.value !== null,
  );
  if (!(await exists(output)))
    return {
      schemaVersion: 1,
      project: options.project,
      outputPath: options.outputPath,
      manifests: manifests.map(({ path }) =>
        relative(options.workspaceRoot, path),
      ),
      externalPackages: [],
      findings: [
        {
          code: 'runtime-output-missing',
          package: null,
          severity: 'error',
          evidence: [options.outputPath],
          message: `Built output ${options.outputPath} does not exist. Build ${options.project} before runtime verification.`,
        },
      ],
    };
  const evidence = new Map<string, Set<string>>();
  for (const file of await filesUnder(output)) {
    const source = await readFile(file, 'utf8');
    for (const dependency of externalSpecifiers(source)) {
      const paths = evidence.get(dependency) ?? new Set<string>();
      paths.add(relative(options.workspaceRoot, file));
      evidence.set(dependency, paths);
    }
  }
  const production = new Set<string>();
  const development = new Set<string>();
  for (const { value } of manifests) {
    for (const name of Object.keys(value.dependencies ?? {}))
      production.add(name);
    for (const name of Object.keys(value.optionalDependencies ?? {}))
      production.add(name);
    for (const name of Object.keys(value.devDependencies ?? {}))
      development.add(name);
  }
  const findings = [...evidence.entries()].flatMap(([name, paths]) => {
    if (production.has(name)) return [];
    const devOnly = development.has(name);
    return [
      {
        code: devOnly
          ? ('runtime-dependency-dev-only' as const)
          : ('runtime-dependency-missing' as const),
        package: name,
        severity: 'error' as const,
        evidence: [...paths].sort(compare),
        message: devOnly
          ? `${name} is required by the built output but is declared only in devDependencies.`
          : `${name} is required by the built output but is not a production dependency of the workspace or project.`,
      },
    ];
  });
  return {
    schemaVersion: 1,
    project: options.project,
    outputPath: options.outputPath,
    manifests: manifests.map(({ path }) =>
      relative(options.workspaceRoot, path),
    ),
    externalPackages: [...evidence.keys()].sort(compare),
    findings: findings.sort(
      (left, right) =>
        compare(left.package ?? '', right.package ?? '') ||
        compare(left.code, right.code),
    ),
  };
}

export function serializeRuntimeDependencyReport(
  report: RuntimeDependencyReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
