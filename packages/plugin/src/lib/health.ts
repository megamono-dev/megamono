import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProjectGraph } from '@nx/devkit';
import { valid as validVersion } from 'semver';
import { repositoryOwnedGraph } from './repository-graph';
import type { MegamonoConfig } from './config';
import type { RepositoryDocument } from './docs';
import { inspectManagedSkills } from './managed-skills';
import {
  inspectManagedArtifacts,
  readArtifactRegistryFromDisk,
} from './managed-artifacts';

export const HEALTH_CHECKS = [
  'dependency-alignment',
  'spec-drift',
  'stale-plans',
  'orphaned-libraries',
  'integration-template-drift',
] as const;
export type HealthCheck = (typeof HEALTH_CHECKS)[number];
export type HealthConfidence = 'complete' | 'reduced';

export interface HealthFinding {
  readonly check: HealthCheck;
  readonly fingerprint: string;
  readonly state: string;
  readonly confidence: HealthConfidence;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly recommendation?: string;
}

export interface HealthSuppressionResult {
  readonly check: HealthCheck;
  readonly fingerprint: string;
  readonly decision: string;
  readonly expires_at?: string;
  readonly matched: boolean;
}

export interface RepositoryHealthReport {
  readonly schemaVersion: 1;
  readonly reductions?: readonly string[];
  readonly findings: readonly HealthFinding[];
  readonly intentional: readonly HealthSuppressionResult[];
  readonly summary: {
    readonly findings: number;
    readonly intentional: number;
    readonly checks: Readonly<Record<HealthCheck, number>>;
  };
}

export class HealthConfigurationError extends Error {
  readonly exitCode = 2;
}

export class HealthGraphError extends Error {
  readonly exitCode = 3;
}

export interface HealthGitState {
  readonly available: boolean;
  readonly branches: Readonly<Record<string, 'active' | 'merged' | 'missing'>>;
  readonly lastChanged: Readonly<Record<string, string>>;
}

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly publishConfig?: Readonly<Record<string, unknown>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

interface ExpoConfig {
  readonly expo?: { readonly sdkVersion?: string };
}

interface PlaystackDatabaseTarget {
  readonly adapter?: unknown;
  readonly dialect?: unknown;
  readonly target?: unknown;
}

interface PlaystackConfig {
  readonly databases?: Readonly<Record<string, PlaystackDatabaseTarget>>;
}

type DependencyEcosystem = 'npm' | 'expo' | 'swiftpm' | 'cargo';

interface DependencyDeclaration {
  readonly ecosystem: DependencyEcosystem;
  readonly name: string;
  readonly project: string;
  readonly range: string;
  readonly kind?:
    'dependency' | 'devDependency' | 'peerDependency' | 'optionalDependency';
}

interface IntegrationProvenance {
  readonly integration: string;
  readonly sdk: string;
  readonly sdkRange: string;
  readonly templateRevision: number;
}

interface CloudflareWorkerReferenceMetadata {
  readonly kind: string;
  readonly worker: string;
  readonly binding?: string;
}

interface CloudflareEnvironmentHealthMetadata {
  readonly name: string;
  readonly bindingFamilies: readonly string[];
}

interface CloudflareHealthMetadata {
  readonly schemaVersion: 1;
  readonly inferenceStatus: 'ready' | 'blocked';
  readonly configPath: string;
  readonly workerName?: string;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags: readonly string[];
  readonly unresolvedWorkers: readonly CloudflareWorkerReferenceMetadata[];
  readonly topLevelBindingFamilies: readonly string[];
  readonly unknownBindingFamilies: readonly string[];
  readonly environments: readonly CloudflareEnvironmentHealthMetadata[];
}

interface CloudflareCompatibilityRegistry {
  readonly wrangler: string;
  readonly compatibilityDate: string;
  readonly nodeCompatibilityDefaultDate: string;
}

interface RenderPreflightDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly service?: string;
}

const cloudflareCompatibility = (
  JSON.parse(
    readFileSync(join(__dirname, '../../compatibility.json'), 'utf8'),
  ) as { cloudflare: CloudflareCompatibilityRegistry }
).cloudflare;

const executeFile = promisify(execFile);

async function gitOutput(
  workspaceRoot: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly code: number }> {
  try {
    const result = await executeFile('git', [...args], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    });
    return { stdout: result.stdout.trim(), code: 0 };
  } catch (error) {
    const failure = error as {
      readonly code?: unknown;
      readonly stdout?: unknown;
    };
    return {
      stdout: typeof failure.stdout === 'string' ? failure.stdout.trim() : '',
      code: typeof failure.code === 'number' ? failure.code : 1,
    };
  }
}

export async function collectHealthGitState(
  workspaceRoot: string,
  documents: readonly RepositoryDocument[],
): Promise<HealthGitState> {
  const repository = await gitOutput(workspaceRoot, [
    'rev-parse',
    '--is-inside-work-tree',
  ]);
  if (repository.code !== 0 || repository.stdout !== 'true') {
    return { available: false, branches: {}, lastChanged: {} };
  }
  const branches: Record<string, 'active' | 'merged' | 'missing'> = {};
  const lastChanged: Record<string, string> = {};
  const plans = documents.filter(
    ({ archived, data }) => data.type === 'plan' && !archived,
  );
  for (const plan of plans) {
    const path = relative(workspaceRoot, plan.absolutePath);
    if (path && !path.startsWith('..')) {
      const changed = await gitOutput(workspaceRoot, [
        'log',
        '-1',
        '--format=%cI',
        '--',
        path,
      ]);
      if (changed.code === 0 && changed.stdout) {
        lastChanged[plan.data.id] = changed.stdout;
      }
    }
    const branch = plan.data.branch;
    if (!branch || branches[branch]) continue;
    let reference: string | undefined;
    for (const candidate of [
      `refs/heads/${branch}`,
      `refs/remotes/origin/${branch}`,
    ]) {
      const resolved = await gitOutput(workspaceRoot, [
        'rev-parse',
        '--verify',
        '--quiet',
        candidate,
      ]);
      if (resolved.code === 0) {
        reference = candidate;
        break;
      }
    }
    if (!reference) {
      branches[branch] = 'missing';
      continue;
    }
    const merged = await gitOutput(workspaceRoot, [
      'merge-base',
      '--is-ancestor',
      reference,
      'HEAD',
    ]);
    branches[branch] = merged.code === 0 ? 'merged' : 'active';
  }
  return { available: true, branches, lastChanged };
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function normalizeVersion(value: string): string | undefined {
  const match = value.match(/^([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?$/);
  if (!match) return undefined;
  return `${match[1]}.${match[2] ?? '0'}.${match[3] ?? '0'}`;
}

function parsedBase(range: string): string | undefined {
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === 'latest') return '0.0.0';
  const simple = trimmed.match(/^[~^]?([0-9]+(?:\.[0-9]+){0,2})$/)?.[1];
  if (simple) return normalizeVersion(simple);
  const lowerBound = trimmed
    .split(/\s+/)
    .map((token) => token.match(/^>=?([0-9]+(?:\.[0-9]+){0,2})$/))
    .find((match) => match !== null);
  if (lowerBound) return normalizeVersion(lowerBound[1]);
  return trimmed
    .split(/\s+/)
    .every((token) => /^<=?[0-9]+(?:\.[0-9]+){0,2}$/.test(token))
    ? '0.0.0'
    : undefined;
}

function satisfies(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '*' || trimmed === 'latest') return true;
  if (/[<>]/.test(trimmed)) {
    return trimmed.split(/\s+/).every((token) => {
      const match = token.match(/^(>=|>|<=|<)([0-9]+(?:\.[0-9]+){0,2})$/);
      if (!match) return false;
      const boundary = normalizeVersion(match[2]);
      if (!boundary) return false;
      const comparison = compareVersions(version, boundary);
      if (match[1] === '>=') return comparison >= 0;
      if (match[1] === '>') return comparison > 0;
      if (match[1] === '<=') return comparison <= 0;
      return comparison < 0;
    });
  }
  const base = parsedBase(trimmed);
  if (!base || compareVersions(version, base) < 0) return false;
  const [major, minor] = base.split('.').map(Number);
  const [candidateMajor, candidateMinor, candidatePatch] = version
    .split('.')
    .map(Number);
  if (trimmed.startsWith('^')) {
    if (major > 0) return candidateMajor === major;
    if (minor > 0) return candidateMajor === major && candidateMinor === minor;
    return (
      candidateMajor === major &&
      candidateMinor === minor &&
      candidatePatch === Number(base.split('.')[2])
    );
  }
  if (trimmed.startsWith('~'))
    return candidateMajor === major && candidateMinor === minor;
  const components = trimmed.split('.').length;
  if (components < 3) {
    return (
      candidateMajor === major && (components === 1 || candidateMinor === minor)
    );
  }
  return version === base;
}

function enabled(config: MegamonoConfig, check: HealthCheck): boolean {
  return config.health.checks[check] !== false;
}

export function healthUsesDocs(config: MegamonoConfig): boolean {
  // Empty adoption metadata predates profiles: preserve its full-health behavior.
  return (
    config.adoption.modules.length === 0 ||
    config.adoption.modules.includes('docs')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCloudflareMetadata(
  value: unknown,
): value is CloudflareHealthMetadata {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    (value.inferenceStatus === 'ready' ||
      value.inferenceStatus === 'blocked') &&
    typeof value.configPath === 'string' &&
    Array.isArray(value.compatibilityFlags) &&
    Array.isArray(value.unresolvedWorkers) &&
    Array.isArray(value.topLevelBindingFamilies) &&
    Array.isArray(value.unknownBindingFamilies) &&
    Array.isArray(value.environments)
  );
}

function validCompatibilityDate(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function effectiveNodeCompatibility(
  metadata: CloudflareHealthMetadata,
): boolean {
  const flags = new Set(metadata.compatibilityFlags);
  if (flags.has('no_nodejs_compat')) return false;
  if (flags.has('nodejs_compat')) return true;
  return Boolean(
    validCompatibilityDate(metadata.compatibilityDate) &&
    metadata.compatibilityDate >=
      cloudflareCompatibility.nodeCompatibilityDefaultDate,
  );
}

async function projectUsesCloudflareVitest(
  workspaceRoot: string,
  projectRoot: string,
): Promise<boolean> {
  const manifest = await readJson<PackageManifest>(
    join(workspaceRoot, projectRoot, 'package.json'),
  );
  const dependencies = {
    ...manifest?.dependencies,
    ...manifest?.devDependencies,
  };
  return Boolean(
    dependencies['@cloudflare/vitest-plugin'] ??
    dependencies['@cloudflare/vitest-pool-workers'],
  );
}

async function cloudflareHealthFindings(
  workspaceRoot: string,
  graph: ProjectGraph,
): Promise<{
  dependencyAlignment: HealthFinding[];
  specDrift: HealthFinding[];
}> {
  const projects = Object.entries(graph.nodes)
    .flatMap(([project, node]) => {
      const metadata = node.data.metadata?.['megamono:cloudflare'];
      return isCloudflareMetadata(metadata) &&
        metadata.inferenceStatus === 'ready'
        ? [{ project, root: node.data.root, metadata }]
        : [];
    })
    .sort((left, right) => left.project.localeCompare(right.project));
  const dependencyAlignment: HealthFinding[] = [];
  const specDrift: HealthFinding[] = [];
  if (projects.length === 0) return { dependencyAlignment, specDrift };

  const wranglerInstalls = new Map<string, string>();
  for (const root of [
    '.',
    ...new Set(projects.map((project) => project.root)),
  ]) {
    const manifest = await readJson<{ version?: string }>(
      join(workspaceRoot, root, 'node_modules/wrangler/package.json'),
    );
    if (manifest?.version) wranglerInstalls.set(root, manifest.version);
  }
  for (const [root, version] of [...wranglerInstalls].sort()) {
    if (satisfies(version, cloudflareCompatibility.wrangler)) continue;
    dependencyAlignment.push({
      check: 'dependency-alignment',
      fingerprint: `cloudflare:wrangler-range:${root}:${version}`,
      state: 'constrained',
      confidence: 'complete',
      summary: `Wrangler ${version} is outside @megamono/nx-cloudflare's tested range.`,
      evidence: [
        `${root}/node_modules/wrangler/package.json`,
        `tested range: ${cloudflareCompatibility.wrangler}`,
      ],
      recommendation:
        'Install a tested Wrangler version or update the compatibility registry and fixtures.',
    });
  }

  const identities = new Map<string, string[]>();
  for (const { project, metadata } of projects) {
    if (!metadata.workerName) continue;
    identities.set(metadata.workerName, [
      ...(identities.get(metadata.workerName) ?? []),
      project,
    ]);
  }
  for (const [worker, owners] of [...identities].sort()) {
    if (owners.length < 2) continue;
    specDrift.push({
      check: 'spec-drift',
      fingerprint: `cloudflare:duplicate-worker:${worker}`,
      state: 'alignable',
      confidence: 'complete',
      summary: `Worker binding identity ${worker} is declared by multiple projects.`,
      evidence: owners.sort(),
      recommendation: 'Assign a unique top-level Wrangler name to each Worker.',
    });
  }

  const newestDate = projects
    .map(({ metadata }) => metadata.compatibilityDate)
    .filter(validCompatibilityDate)
    .sort()
    .at(-1);
  const targetDate = [
    cloudflareCompatibility.compatibilityDate,
    ...(newestDate ? [newestDate] : []),
  ]
    .sort()
    .at(-1) as string;

  for (const { project, root, metadata } of projects) {
    for (const reference of metadata.unresolvedWorkers) {
      specDrift.push({
        check: 'spec-drift',
        fingerprint: `cloudflare:unresolved-worker:${project}:${reference.kind}:${reference.worker}`,
        state: 'constrained',
        confidence: 'complete',
        summary: `${project} has an unresolved ${reference.kind} reference to ${reference.worker}.`,
        evidence: [
          metadata.configPath,
          ...(reference.binding ? [`binding: ${reference.binding}`] : []),
        ],
        recommendation:
          'Correct the Worker name or declare it in the nx-cloudflare externalWorkers allowlist.',
      });
    }

    if (
      !validCompatibilityDate(metadata.compatibilityDate) ||
      metadata.compatibilityDate < targetDate
    ) {
      specDrift.push({
        check: 'spec-drift',
        fingerprint: `cloudflare:compatibility-date:${project}`,
        state: 'alignable',
        confidence: 'complete',
        summary: `${project} is behind the repository's Cloudflare compatibility date.`,
        evidence: [
          metadata.configPath,
          `project date: ${metadata.compatibilityDate ?? 'missing'}`,
          `repository date: ${targetDate}`,
        ],
        recommendation: `Review runtime changes, then align compatibility_date to ${targetDate}.`,
      });
    }

    const flags = new Set(metadata.compatibilityFlags);
    if (flags.has('nodejs_compat') && flags.has('no_nodejs_compat')) {
      specDrift.push({
        check: 'spec-drift',
        fingerprint: `cloudflare:node-compat-flags:${project}`,
        state: 'alignable',
        confidence: 'complete',
        summary: `${project} declares conflicting Node compatibility flags.`,
        evidence: [metadata.configPath, 'nodejs_compat', 'no_nodejs_compat'],
        recommendation: 'Retain only the intended Node compatibility flag.',
      });
    }
    if (
      (await projectUsesCloudflareVitest(workspaceRoot, root)) &&
      !effectiveNodeCompatibility(metadata)
    ) {
      specDrift.push({
        check: 'spec-drift',
        fingerprint: `cloudflare:node-compat:${project}`,
        state: 'alignable',
        confidence: 'complete',
        summary: `${project}'s Cloudflare Vitest runtime enables Node compatibility that production disables.`,
        evidence: [
          metadata.configPath,
          `compatibility date: ${metadata.compatibilityDate ?? 'missing'}`,
          `flags: ${metadata.compatibilityFlags.join(', ') || 'none'}`,
        ],
        recommendation:
          'Align the production compatibility date or flags with the test runtime.',
      });
    }

    const topLevelFamilies = new Set(metadata.topLevelBindingFamilies);
    for (const environment of metadata.environments) {
      for (const family of environment.bindingFamilies) {
        if (topLevelFamilies.has(family)) continue;
        specDrift.push({
          check: 'spec-drift',
          fingerprint: `cloudflare:environment-binding:${project}:${environment.name}:${family}`,
          state: 'constrained',
          confidence: 'complete',
          summary: `${project} declares ${family} only in Wrangler environment ${environment.name}.`,
          evidence: [metadata.configPath],
          recommendation:
            'Review whether the binding belongs at the top level; environment-only bindings do not contribute Nx graph edges.',
        });
      }
    }
    for (const family of metadata.unknownBindingFamilies) {
      specDrift.push({
        check: 'spec-drift',
        fingerprint: `cloudflare:binding-shape:${project}:${family}`,
        state: 'constrained',
        confidence: 'reduced',
        summary: `${project} uses unrecognized Wrangler binding family ${family}.`,
        evidence: [metadata.configPath],
        recommendation:
          'Update the compatibility registry, normalized metadata contract, and fixtures before inferring this binding family.',
      });
    }
  }
  return { dependencyAlignment, specDrift };
}

function renderPreflightFindings(graph: ProjectGraph): HealthFinding[] {
  return Object.entries(graph.nodes)
    .flatMap(([project, node]) => {
      if (!node.data.metadata?.['megamono:render']) return [];
      const preflight = node.data.metadata?.['megamono:preflight'];
      if (!preflight || typeof preflight !== 'object') return [];
      const candidates = (preflight as { diagnostics?: unknown }).diagnostics;
      if (!Array.isArray(candidates)) return [];
      return candidates.flatMap((candidate) => {
        if (
          !candidate ||
          typeof candidate !== 'object' ||
          !('severity' in candidate) ||
          !('code' in candidate) ||
          !('message' in candidate) ||
          !('path' in candidate)
        )
          return [];
        const value = candidate as Partial<RenderPreflightDiagnostic>;
        if (
          (value.severity !== 'error' && value.severity !== 'warning') ||
          typeof value.code !== 'string' ||
          typeof value.message !== 'string' ||
          typeof value.path !== 'string'
        )
          return [];
        return [
          {
            check: 'spec-drift' as const,
            fingerprint: `render:${value.code}:${project}:${value.service ?? value.path}`,
            state: value.severity === 'error' ? 'constrained' : 'alignable',
            confidence: 'complete' as const,
            summary: value.message,
            evidence: [
              value.path,
              `Nx project: ${project}`,
              ...(value.service ? [`Render service: ${value.service}`] : []),
            ],
            recommendation:
              'Review the repository-owned Render Blueprint and rerun the Nx graph preflight.',
          },
        ];
      });
    })
    .sort(findingSort);
}

function findingSort(left: HealthFinding, right: HealthFinding): number {
  return (
    left.check.localeCompare(right.check) ||
    left.fingerprint.localeCompare(right.fingerprint)
  );
}

async function dependencyAlignmentFindings(
  workspaceRoot: string,
  graph: ProjectGraph,
): Promise<HealthFinding[]> {
  const declarations = new Map<string, DependencyDeclaration[]>();
  const workspacePackages = new Map<string, (string | undefined)[]>();
  const roots = new Map<string, string>([['.', 'root']]);
  for (const [name, node] of Object.entries(graph.nodes)) {
    roots.set(node.data.root, name);
  }
  const add = (key: string, declaration: DependencyDeclaration) => {
    const current = declarations.get(key) ?? [];
    current.push(declaration);
    declarations.set(key, current);
  };
  for (const [root, project] of [...roots].sort(([, a], [, b]) =>
    a.localeCompare(b),
  )) {
    const manifest = await readJson<PackageManifest>(
      join(workspaceRoot, root, 'package.json'),
    );
    if (manifest?.name) {
      workspacePackages.set(manifest.name, [
        ...(workspacePackages.get(manifest.name) ?? []),
        manifest.version,
      ]);
    }
    const sections = [
      ['dependency', manifest?.dependencies],
      ['devDependency', manifest?.devDependencies],
      ['peerDependency', manifest?.peerDependencies],
      ['optionalDependency', manifest?.optionalDependencies],
    ] as const;
    for (const [kind, dependencies] of sections) {
      for (const [name, range] of Object.entries(dependencies ?? {}).sort(
        ([a], [b]) => a.localeCompare(b),
      )) {
        add(name, { ecosystem: 'npm', name, project, range, kind });
      }
    }

    const expo = await readJson<ExpoConfig>(
      join(workspaceRoot, root, 'app.json'),
    );
    if (expo?.expo?.sdkVersion) {
      add('expo:sdk', {
        ecosystem: 'expo',
        name: 'SDK',
        project,
        range: expo.expo.sdkVersion,
      });
    }

    const cargo = await readText(join(workspaceRoot, root, 'Cargo.toml'));
    if (cargo) {
      let section = '';
      for (const sourceLine of cargo.split(/\r?\n/)) {
        const line = sourceLine.replace(/\s+#.*$/, '').trim();
        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
          section = sectionMatch[1];
          continue;
        }
        if (!/(^|\.)((dev-|build-)?dependencies)$/.test(section)) continue;
        const dependency = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
        if (!dependency) continue;
        const quoted = dependency[2].match(/^"([^"]+)"$/)?.[1];
        const table = dependency[2].match(/\bversion\s*=\s*"([^"]+)"/)?.[1];
        const rawRange = quoted ?? table;
        if (!rawRange) continue;
        const range = rawRange.startsWith('=')
          ? rawRange.slice(1)
          : /^[0-9]/.test(rawRange)
            ? `^${rawRange}`
            : rawRange;
        add(`cargo:${dependency[1]}`, {
          ecosystem: 'cargo',
          name: dependency[1],
          project,
          range,
        });
      }
    }

    const swift = await readText(join(workspaceRoot, root, 'Package.swift'));
    if (swift) {
      const packagePattern = /\.package\s*\(\s*url:\s*"([^"]+)"\s*,([^\n]+)/g;
      for (const match of swift.matchAll(packagePattern)) {
        const url = match[1];
        const constraint = match[2];
        const name =
          url
            .split('/')
            .at(-1)
            ?.replace(/\.git$/, '') ?? url;
        const exact = constraint.match(/\bexact:\s*"([^"]+)"/)?.[1];
        const from = constraint.match(/\bfrom:\s*"([^"]+)"/)?.[1];
        const nextMinor = constraint.match(
          /upToNextMinor\s*\(\s*from:\s*"([^"]+)"/,
        )?.[1];
        const range = constraint.match(
          /"([0-9]+(?:\.[0-9]+){0,2})"\s*\.\.<\s*"([0-9]+(?:\.[0-9]+){0,2})"/,
        );
        const normalized = exact
          ? exact
          : nextMinor
            ? `~${nextMinor}`
            : from
              ? `^${from}`
              : range
                ? `>=${range[1]} <${range[2]}`
                : `unsupported:${constraint.trim()}`;
        add(`swiftpm:${name}`, {
          ecosystem: 'swiftpm',
          name,
          project,
          range: normalized,
        });
      }
    }
  }

  const findings: HealthFinding[] = [];
  for (const [key, consumers] of [...declarations].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const ranges = [...new Set(consumers.map(({ range }) => range))].sort();
    if (ranges.length < 2) continue;
    // These shorthand forms resolve to the same local package today, although
    // they deliberately produce different ranges when packed. Do not rewrite
    // publication intent or assume an alias/missing/ambiguous package resolves.
    const localVersions = workspacePackages.get(key);
    if (
      localVersions?.length === 1 &&
      localVersions[0] &&
      validVersion(localVersions[0]) &&
      consumers.every(
        ({ ecosystem, range }) =>
          ecosystem === 'npm' &&
          ['workspace:*', 'workspace:^', 'workspace:~'].includes(range),
      )
    )
      continue;
    const installedRanges = [
      ...new Set(
        consumers
          .filter(({ kind }) => kind !== 'peerDependency')
          .map(({ range }) => range),
      ),
    ];
    const bases = ranges.map(parsedBase);
    const supported = bases.every((value) => value !== undefined);
    const candidate = supported
      ? [...(bases as string[])].sort(compareVersions).at(-1)
      : undefined;
    const alignable = Boolean(
      candidate && ranges.every((range) => satisfies(candidate, range)),
    );
    // Peer dependencies describe a package's supported host versions; they do
    // not install another copy. A single installed range that satisfies every
    // peer contract is already aligned and should not produce remediation
    // noise merely because the support envelope is written differently.
    if (installedRanges.length === 1 && alignable) continue;
    const projects = consumers.map(({ project }) => project).sort();
    const { ecosystem, name } = consumers[0];
    const label = ecosystem === 'npm' ? name : `${ecosystem} ${name}`;
    findings.push({
      check: 'dependency-alignment',
      fingerprint: `${key}:${projects.join(':')}`,
      state: alignable ? 'alignable' : 'constrained',
      confidence: supported ? 'complete' : 'reduced',
      summary: alignable
        ? `${label} can be aligned across ${projects.length} consumers.`
        : `${label} has no proven common version across ${projects.length} consumers.`,
      evidence: consumers
        .map(({ project, range }) => `${project}: ${range}`)
        .sort(),
      ...(alignable && candidate
        ? { recommendation: `Align ${label} to ${candidate}.` }
        : {}),
    });
  }
  return findings;
}

function specDriftFindings(
  workspaceRoot: string,
  graph: ProjectGraph,
  documents: readonly RepositoryDocument[],
  config: MegamonoConfig,
): HealthFinding[] {
  const specs = documents.filter(
    (document) => document.data.type === 'spec' && !document.archived,
  );
  const projectNames = new Set(Object.keys(graph.nodes));
  const referenced = new Set(specs.flatMap(({ data }) => data.projects));
  const documented = new Set<string>();
  for (const project of referenced) {
    const aliases = config.health.projectAliases[project];
    if (aliases) aliases.forEach((candidate) => documented.add(candidate));
    else documented.add(project);
  }
  const findings: HealthFinding[] = [];
  for (const ratchet of config.adoption.ratchets) {
    const override = config.conventions.rules[ratchet.rule];
    if (
      override?.severity === ratchet.targetSeverity ||
      (override?.severity === 'off' && override.decision)
    ) {
      continue;
    }
    findings.push({
      check: 'spec-drift',
      fingerprint: `adoption-ratchet:${ratchet.rule}`,
      state: 'adoption-ratchet',
      confidence: 'complete',
      summary: `Structural rule ${ratchet.rule} remains in temporary adoption warning mode.`,
      evidence: [
        'megamono.json',
        `initial violations: ${ratchet.initialCount}`,
        `target severity: ${ratchet.targetSeverity}`,
      ],
      recommendation: `Resolve the remaining ${ratchet.rule} violations and promote the rule to ${ratchet.targetSeverity}, or record an accepted decision.`,
    });
  }
  for (const project of [...documented].sort()) {
    if (projectNames.has(project)) continue;
    findings.push({
      check: 'spec-drift',
      fingerprint: `missing-project:${project}`,
      state: 'missing-project',
      confidence: 'complete',
      summary: `Specifications reference missing project ${project}.`,
      evidence: specs
        .filter(({ data }) =>
          data.projects.some(
            (reference) =>
              reference === project ||
              config.health.projectAliases[reference]?.includes(project),
          ),
        )
        .map(({ data }) => data.id)
        .sort(),
    });
  }
  for (const project of [...projectNames].sort()) {
    if (
      !healthUsesDocs(config) ||
      documented.has(project) ||
      project === 'megamono-docs'
    )
      continue;
    findings.push({
      check: 'spec-drift',
      fingerprint: `undocumented-project:${project}`,
      state: 'undocumented-project',
      confidence: 'complete',
      summary: `Project ${project} is not named by an active specification.`,
      evidence: [graph.nodes[project].data.root],
    });
  }
  const graphEdges = new Map<string, readonly string[]>();
  for (const [source, dependencies] of Object.entries(graph.dependencies)) {
    for (const dependency of dependencies) {
      const fingerprint = `${source}->${dependency.target}`;
      graphEdges.set(fingerprint, [
        ...(graphEdges.get(fingerprint) ?? []),
        dependency.type,
      ]);
    }
  }
  for (const spec of specs.sort((left, right) =>
    left.data.id.localeCompare(right.data.id),
  )) {
    const architecture = spec.data.architecture;
    if (!architecture) continue;
    for (const edge of architecture.allowed_dependencies) {
      if (!projectNames.has(edge.from) || !projectNames.has(edge.to)) continue;
      const fingerprint = `${edge.from}->${edge.to}`;
      if (graphEdges.has(fingerprint)) continue;
      findings.push({
        check: 'spec-drift',
        fingerprint: `missing-architecture-edge:${spec.data.id}:${edge.from}:${edge.to}`,
        state: 'missing-architecture-edge',
        confidence: 'complete',
        summary: `Specification ${spec.data.id} expects ${edge.from} to depend on ${edge.to}, but the graph edge is absent.`,
        evidence: [spec.relativePath, fingerprint],
        recommendation:
          'Reconcile the implementation or update the specification.',
      });
    }
    for (const edge of architecture.forbidden_dependencies) {
      if (!projectNames.has(edge.from) || !projectNames.has(edge.to)) continue;
      const fingerprint = `${edge.from}->${edge.to}`;
      const types = graphEdges.get(fingerprint);
      if (!types) continue;
      findings.push({
        check: 'spec-drift',
        fingerprint: `forbidden-architecture-edge:${spec.data.id}:${edge.from}:${edge.to}`,
        state: 'forbidden-architecture-edge',
        confidence: 'complete',
        summary: `Specification ${spec.data.id} forbids ${edge.from} from depending on ${edge.to}, but the graph edge exists.`,
        evidence: [
          spec.relativePath,
          fingerprint,
          `edge types: ${[...new Set(types)].sort().join(', ')}`,
        ],
        recommendation:
          'Remove the dependency edge or revise the specification.',
      });
    }
  }
  const managedSkills = inspectManagedSkills(workspaceRoot);
  if (managedSkills.available) {
    for (const [name, state] of Object.entries(managedSkills.skills).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (state === 'current' || state === 'ejected') continue;
      findings.push({
        check: 'spec-drift',
        fingerprint: `managed-skill:${state}:${name}`,
        state: `managed-skill-${state}`,
        confidence: 'complete',
        summary:
          state === 'missing'
            ? `Managed skill ${name} is missing from the repository.`
            : state === 'outdated'
              ? `Managed skill ${name} is behind the installed plugin template.`
              : state === 'modified'
                ? `Managed skill ${name} differs from its recorded managed template.`
                : `Managed skill ${name} has invalid provenance.`,
        evidence: [`.agents/skills/${name}`],
        recommendation:
          state === 'modified'
            ? `Eject ${name} to keep the customization, or restore the managed template.`
            : 'Run the workspace-init generator to reconcile managed skills.',
      });
    }
  }
  try {
    const registry = readArtifactRegistryFromDisk(workspaceRoot);
    for (const inspection of inspectManagedArtifacts(workspaceRoot, registry)) {
      const { artifact, state } = inspection;
      if (
        artifact.id.startsWith('skill.') ||
        artifact.mode === 'seeded' ||
        state === 'current' ||
        state === 'ejected'
      ) {
        continue;
      }
      findings.push({
        check: 'spec-drift',
        fingerprint: `managed-artifact:${state}:${artifact.id}`,
        state: `managed-artifact-${state}`,
        confidence: 'complete',
        summary:
          state === 'missing'
            ? `Managed artifact ${artifact.id} is missing.`
            : `Managed artifact ${artifact.id} differs from its installed hash.`,
        evidence: [artifact.target],
        recommendation:
          state === 'modified'
            ? `Eject ${artifact.id} to retain the customization, or restore the managed artifact.`
            : 'Run workspace-init to reconcile the managed artifact.',
      });
    }
  } catch (error) {
    findings.push({
      check: 'spec-drift',
      fingerprint: 'managed-artifact:invalid:registry',
      state: 'managed-artifact-invalid',
      confidence: 'complete',
      summary: 'The Megamono artifact registry is invalid.',
      evidence: [(error as Error).message],
      recommendation:
        'Repair .megamono/artifacts.json before running workspace-init.',
    });
  }
  return findings;
}

async function databaseTargetFindings(
  workspaceRoot: string,
  graph: ProjectGraph,
  config: MegamonoConfig,
): Promise<HealthFinding[]> {
  const configured = Object.entries(config.databases).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (configured.length === 0) return [];

  const playstack = await readJson<PlaystackConfig>(
    join(workspaceRoot, 'playstack.json'),
  );
  const targets = playstack?.databases ?? {};
  const findings: HealthFinding[] = [];

  for (const [name, database] of configured) {
    const project = graph.nodes[database.project];
    if (!project) {
      findings.push({
        check: 'spec-drift',
        fingerprint: `database:missing-project:${name}:${database.project}`,
        state: 'constrained',
        confidence: 'complete',
        summary: `Database ${name} references missing Nx project ${database.project}.`,
        evidence: ['megamono.json'],
        recommendation:
          'Restore the project or update the database project mapping explicitly.',
      });
      continue;
    }

    const target = targets[name];
    if (!target) {
      findings.push({
        check: 'spec-drift',
        fingerprint: `database:missing-playstack-target:${name}`,
        state: 'constrained',
        confidence: 'complete',
        summary: `Database ${name} has no corresponding Playstack artifact target.`,
        evidence: ['megamono.json', 'playstack.json'],
        recommendation:
          'Configure the same logical database name in playstack.json before synchronizing package artifacts.',
      });
      continue;
    }

    if (target.adapter !== database.adapter) {
      findings.push({
        check: 'spec-drift',
        fingerprint: `database:adapter-disagreement:${name}`,
        state: 'constrained',
        confidence: 'complete',
        summary: `Database ${name} disagrees on its schema adapter.`,
        evidence: [
          `megamono.json: ${database.adapter}`,
          `playstack.json: ${String(target.adapter ?? 'missing')}`,
        ],
        recommendation:
          'Choose one adapter explicitly and align both configuration files; Megamono will not translate between ORM formats.',
      });
    }

    if (database.adapter === 'drizzle' && target.dialect !== 'postgresql') {
      findings.push({
        check: 'spec-drift',
        fingerprint: `database:dialect-disagreement:${name}`,
        state: 'constrained',
        confidence: 'complete',
        summary: `Database ${name} has no supported Drizzle dialect.`,
        evidence: [
          'megamono.json: drizzle',
          `playstack.json: ${String(target.dialect ?? 'missing')}`,
        ],
        recommendation:
          'Set the Playstack database dialect to postgresql so it matches the Megamono adapter contract.',
      });
    }

    if (typeof target.target !== 'string' || target.target.length === 0) {
      findings.push({
        check: 'spec-drift',
        fingerprint: `database:invalid-playstack-target:${name}`,
        state: 'constrained',
        confidence: 'complete',
        summary: `Database ${name} has no usable Playstack artifact destination.`,
        evidence: ['playstack.json'],
        recommendation:
          'Set a workspace-relative artifact target inside the selected Nx project.',
      });
      continue;
    }

    const projectRoot = resolve(workspaceRoot, project.data.root);
    const artifactTarget = resolve(workspaceRoot, target.target);
    const projectRelativeTarget = relative(projectRoot, artifactTarget);
    const outsideProject =
      isAbsolute(target.target) ||
      projectRelativeTarget === '..' ||
      projectRelativeTarget.startsWith(`..${sep}`) ||
      isAbsolute(projectRelativeTarget);
    if (outsideProject) {
      findings.push({
        check: 'spec-drift',
        fingerprint: `database:target-outside-project:${name}`,
        state: 'constrained',
        confidence: 'complete',
        summary: `Database ${name}'s Playstack artifact target is outside Nx project ${database.project}.`,
        evidence: [
          `project root: ${project.data.root}`,
          `artifact target: ${target.target}`,
        ],
        recommendation:
          'Move the target into the selected project or explicitly map the database to the project that owns it.',
      });
    }
  }

  return findings;
}

async function stalePlanFindings(
  documents: readonly RepositoryDocument[],
  staleDays: number,
  now: Date,
  git: HealthGitState,
): Promise<HealthFinding[]> {
  const threshold = now.getTime() - staleDays * 86_400_000;
  const findings: HealthFinding[] = [];
  const plans = documents.filter(
    (document) =>
      document.data.type === 'plan' &&
      !document.archived &&
      ['backlog', 'in-progress', 'on-hold'].includes(document.data.status),
  );
  for (const document of plans) {
    const gitChanged = git.lastChanged[document.data.id];
    const modifiedAt = gitChanged
      ? new Date(gitChanged).getTime()
      : (await stat(document.absolutePath)).mtimeMs;
    if (modifiedAt < threshold) {
      findings.push({
        check: 'stale-plans',
        fingerprint: `unchanged:${document.data.id}`,
        state: 'stale',
        confidence: 'complete',
        summary: `Plan ${document.data.id} has been unchanged for more than ${staleDays} days.`,
        evidence: [
          document.relativePath,
          `status: ${document.data.status}`,
          `last changed: ${new Date(modifiedAt).toISOString()}`,
        ],
        recommendation: 'Review, update, complete, or abort the plan.',
      });
    }
    const branch = document.data.branch;
    const branchState = branch ? git.branches[branch] : undefined;
    if (branch && branchState && branchState !== 'active') {
      findings.push({
        check: 'stale-plans',
        fingerprint: `branch-${branchState}:${document.data.id}:${branch}`,
        state: `branch-${branchState}`,
        confidence: 'complete',
        summary: `Plan ${document.data.id} references ${branchState} branch ${branch}.`,
        evidence: [document.relativePath, `branch: ${branch}`],
        recommendation: 'Complete or abort the plan and archive it.',
      });
    }
    const replacement = plans
      .filter(
        (candidate) =>
          candidate.data.id !== document.data.id &&
          candidate.data.date > document.data.date &&
          candidate.data.projects.some((project) =>
            document.data.projects.includes(project),
          ) &&
          candidate.data.topics.some((topic) =>
            document.data.topics.includes(topic),
          ),
      )
      .sort(
        (left, right) =>
          right.data.date.localeCompare(left.data.date) ||
          right.data.id.localeCompare(left.data.id),
      )[0];
    if (replacement) {
      const sharedTopics = document.data.topics
        .filter((topic) => replacement.data.topics.includes(topic))
        .sort();
      findings.push({
        check: 'stale-plans',
        fingerprint: `superseded:${document.data.id}:${replacement.data.id}`,
        state: 'superseded',
        confidence: 'complete',
        summary: `Plan ${document.data.id} is superseded by later plan ${replacement.data.id}.`,
        evidence: [
          document.relativePath,
          replacement.relativePath,
          `shared topics: ${sharedTopics.join(', ')}`,
        ],
        recommendation: 'Abort the older plan and archive it.',
      });
    }
  }
  return findings;
}

async function graphConfidence(
  workspaceRoot: string,
  config: MegamonoConfig,
): Promise<HealthConfidence> {
  const nx = await readJson<{ plugins?: Array<string | { plugin: string }> }>(
    join(workspaceRoot, 'nx.json'),
  );
  const plugins = new Set(
    (nx?.plugins ?? []).map((entry) =>
      typeof entry === 'string' ? entry : entry.plugin,
    ),
  );
  if (config.platforms.includes('apple') && !plugins.has('@megamono/nx-apple'))
    return 'reduced';
  if (config.platforms.includes('rust') && !plugins.has('@megamono/nx-cargo'))
    return 'reduced';
  if (
    config.adoption.inference.cloudflare &&
    !plugins.has('@megamono/nx-cloudflare')
  )
    return 'reduced';
  if (config.adoption.inference.render && !plugins.has('@megamono/nx-render'))
    return 'reduced';
  if (
    config.adoption.inference.extension &&
    !plugins.has('@megamono/nx-extension')
  )
    return 'reduced';
  return 'complete';
}

async function orphanFindings(
  workspaceRoot: string,
  graph: ProjectGraph,
  config: MegamonoConfig,
): Promise<HealthFinding[]> {
  const inbound = new Map(Object.keys(graph.nodes).map((name) => [name, 0]));
  for (const dependencies of Object.values(graph.dependencies)) {
    for (const dependency of dependencies) {
      inbound.set(dependency.target, (inbound.get(dependency.target) ?? 0) + 1);
    }
  }
  const confidence = await graphConfidence(workspaceRoot, config);
  const candidates: Array<readonly [string, (typeof graph.nodes)[string]]> = [];
  for (const [name, node] of Object.entries(graph.nodes)) {
    if (
      node.type !== 'lib' ||
      name === 'megamono-docs' ||
      (inbound.get(name) ?? 0) !== 0
    ) {
      continue;
    }
    const manifest = await readJson<PackageManifest>(
      join(workspaceRoot, node.data.root, 'package.json'),
    );
    // Published libraries and executable packages have consumers outside the
    // local Nx graph. Treating their lack of internal inbound edges as proof
    // of orphaning would be a false positive.
    if (
      manifest?.private !== true &&
      (manifest?.publishConfig !== undefined || manifest?.bin !== undefined)
    ) {
      continue;
    }
    candidates.push([name, node]);
  }
  return candidates.map(([name, node]) => ({
    check: 'orphaned-libraries' as const,
    fingerprint: name,
    state: 'orphaned',
    confidence,
    summary: `Library ${name} has no inbound project-graph edges.`,
    evidence: [node.data.root],
    ...(confidence === 'complete'
      ? { recommendation: 'Confirm the library is still used or remove it.' }
      : {}),
  }));
}

async function integrationDriftFindings(
  workspaceRoot: string,
  graph: ProjectGraph,
): Promise<HealthFinding[]> {
  const findings: HealthFinding[] = [];
  for (const [project, node] of Object.entries(graph.nodes).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const provenance = await readJson<IntegrationProvenance>(
      join(workspaceRoot, node.data.root, '.megamono-integration.json'),
    );
    if (!provenance) continue;
    const manifest = await readJson<PackageManifest>(
      join(workspaceRoot, node.data.root, 'package.json'),
    );
    const installed = {
      ...manifest?.dependencies,
      ...manifest?.devDependencies,
    }[provenance.sdk];
    if (!installed || installed === provenance.sdkRange) continue;
    findings.push({
      check: 'integration-template-drift',
      fingerprint: `${provenance.integration}:${project}:${provenance.templateRevision}`,
      state: 'template-drift',
      confidence: 'complete',
      summary: `${project} uses ${provenance.sdk} ${installed}, outside template revision ${provenance.templateRevision}.`,
      evidence: [`template range: ${provenance.sdkRange}`],
      recommendation: `Review the ${provenance.integration} integration template.`,
    });
  }
  return findings;
}

const suppressionTopics: Readonly<Record<HealthCheck, readonly string[]>> = {
  'dependency-alignment': ['dependencies'],
  'spec-drift': ['docs', 'architecture', 'skills'],
  'stale-plans': ['plans', 'lifecycle'],
  'orphaned-libraries': ['architecture'],
  'integration-template-drift': ['integrations'],
};

function applySuppressions(
  findings: readonly HealthFinding[],
  documents: readonly RepositoryDocument[],
  config: MegamonoConfig,
  now: Date,
): { findings: HealthFinding[]; intentional: HealthSuppressionResult[] } {
  const decisions = new Map(
    documents
      .filter(({ data }) => data.type === 'decision')
      .map((document) => [document.data.id, document]),
  );
  const superseded = new Set(
    documents
      .filter(({ data }) => data.type === 'decision' && data.supersedes)
      .map(({ data }) => data.supersedes as string),
  );
  const active = [...findings];
  const intentional: HealthSuppressionResult[] = [];
  for (const suppression of config.health.suppressions) {
    const decision = decisions.get(suppression.decision);
    if (
      !decision ||
      !['accepted', 'deferred'].includes(decision.data.status) ||
      superseded.has(decision.data.id)
    ) {
      throw new HealthConfigurationError(
        `Health suppression ${suppression.fingerprint} references a missing, inactive, or superseded decision ${suppression.decision}.`,
      );
    }
    if (
      !decision.data.topics.some((topic) =>
        suppressionTopics[suppression.check].includes(topic),
      )
    ) {
      throw new HealthConfigurationError(
        `Decision ${suppression.decision} does not carry a required topic for ${suppression.check}.`,
      );
    }
    if (
      suppression.expires_at &&
      suppression.expires_at < now.toISOString().slice(0, 10)
    ) {
      throw new HealthConfigurationError(
        `Health suppression ${suppression.fingerprint} expired on ${suppression.expires_at}.`,
      );
    }
    const index = active.findIndex(
      (finding) =>
        finding.check === suppression.check &&
        finding.fingerprint === suppression.fingerprint,
    );
    intentional.push({
      ...suppression,
      matched: index >= 0,
    });
    if (index >= 0) active.splice(index, 1);
  }
  return {
    findings: active.sort(findingSort),
    intentional: intentional.sort(
      (left, right) =>
        left.check.localeCompare(right.check) ||
        left.fingerprint.localeCompare(right.fingerprint),
    ),
  };
}

export async function runRepositoryHealth(options: {
  readonly workspaceRoot: string;
  readonly graph: ProjectGraph;
  readonly config: MegamonoConfig;
  readonly documents: readonly RepositoryDocument[];
  readonly checks?: readonly HealthCheck[];
  readonly now?: Date;
  readonly gitState?: HealthGitState;
}): Promise<RepositoryHealthReport> {
  options = { ...options, graph: repositoryOwnedGraph(options.graph) };
  const selected = new Set(options.checks ?? HEALTH_CHECKS);
  const docsEnabled = healthUsesDocs(options.config);
  if (!docsEnabled && options.config.health.suppressions.length)
    throw new HealthConfigurationError(
      'Decision-backed health suppressions require docs adoption; no suppression was applied.',
    );
  const shouldRun = (check: HealthCheck) =>
    selected.has(check) &&
    enabled(options.config, check) &&
    (docsEnabled || check !== 'stale-plans');
  const now = options.now ?? new Date();
  const gitState = shouldRun('stale-plans')
    ? (options.gitState ??
      (await collectHealthGitState(options.workspaceRoot, options.documents)))
    : { available: false, branches: {}, lastChanged: {} };
  const cloudflare =
    shouldRun('dependency-alignment') || shouldRun('spec-drift')
      ? await cloudflareHealthFindings(options.workspaceRoot, options.graph)
      : { dependencyAlignment: [], specDrift: [] };
  const databaseDrift = shouldRun('spec-drift')
    ? await databaseTargetFindings(
        options.workspaceRoot,
        options.graph,
        options.config,
      )
    : [];
  const findings = (
    await Promise.all([
      shouldRun('dependency-alignment')
        ? [
            ...(await dependencyAlignmentFindings(
              options.workspaceRoot,
              options.graph,
            )),
            ...cloudflare.dependencyAlignment,
          ]
        : [],
      shouldRun('spec-drift')
        ? [
            ...specDriftFindings(
              options.workspaceRoot,
              options.graph,
              docsEnabled ? options.documents : [],
              options.config,
            ),
            ...cloudflare.specDrift,
            ...renderPreflightFindings(options.graph),
            ...databaseDrift,
          ]
        : [],
      shouldRun('stale-plans')
        ? stalePlanFindings(
            options.documents,
            options.config.health.stalePlanDays,
            now,
            gitState,
          )
        : [],
      shouldRun('orphaned-libraries')
        ? orphanFindings(options.workspaceRoot, options.graph, options.config)
        : [],
      shouldRun('integration-template-drift')
        ? integrationDriftFindings(options.workspaceRoot, options.graph)
        : [],
    ])
  ).flat();
  const suppressed = applySuppressions(
    findings,
    options.documents,
    options.config,
    now,
  );
  const counts = Object.fromEntries(
    HEALTH_CHECKS.map((check) => [
      check,
      suppressed.findings.filter((finding) => finding.check === check).length,
    ]),
  ) as Record<HealthCheck, number>;
  return {
    schemaVersion: 1,
    ...(!docsEnabled
      ? {
          reductions: [
            'Docs corpus validation, specification coverage, and stale-plan checks are not run because docs governance is not adopted.',
          ],
        }
      : {}),
    findings: suppressed.findings,
    intentional: suppressed.intentional,
    summary: {
      findings: suppressed.findings.length,
      intentional: suppressed.intentional.length,
      checks: counts,
    },
  };
}

export function serializeHealthReport(report: RepositoryHealthReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
