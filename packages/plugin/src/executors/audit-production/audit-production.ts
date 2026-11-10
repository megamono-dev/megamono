import { logger, type PromiseExecutor } from '@nx/devkit';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { satisfies, valid } from 'semver';
import type { AuditProductionExecutorSchema } from './schema';

const executeFile = promisify(execFile);
const SEVERITIES = ['low', 'moderate', 'high', 'critical'] as const;
type Severity = (typeof SEVERITIES)[number];

interface ListedDependency {
  version?: string;
  dependencies?: Record<string, ListedDependency>;
}
interface Advisory {
  id?: number;
  url?: string;
  title?: string;
  severity?: string;
  vulnerable_versions?: string;
}
export interface ProductionFinding {
  readonly package: string;
  readonly version: string;
  readonly severity: Severity;
  readonly title: string;
  readonly url?: string;
}

/**
 * Registry package versions in `pnpm list --prod --json` output. Workspace
 * links contribute their own production dependencies, not themselves.
 */
export function productionPackages(listing: unknown): Map<string, Set<string>> {
  const packages = new Map<string, Set<string>>();
  const visit = (dependencies: Record<string, ListedDependency> = {}) => {
    for (const [name, dependency] of Object.entries(dependencies)) {
      const version = dependency.version ?? '';
      if (valid(version)) {
        const versions = packages.get(name) ?? new Set<string>();
        versions.add(version);
        packages.set(name, versions);
      }
      visit(dependency.dependencies);
    }
  };
  for (const project of Array.isArray(listing) ? listing : [])
    visit((project as ListedDependency).dependencies);
  return packages;
}

/** Keep advisories whose vulnerable range includes an installed version. */
export function affectedFindings(
  packages: ReadonlyMap<string, ReadonlySet<string>>,
  advisories: Record<string, Advisory[]>,
): ProductionFinding[] {
  const findings: ProductionFinding[] = [];
  for (const [name, entries] of Object.entries(advisories)) {
    for (const advisory of entries) {
      const severity = SEVERITIES.find((value) => value === advisory.severity);
      if (!severity || !advisory.vulnerable_versions) continue;
      for (const version of packages.get(name) ?? [])
        if (satisfies(version, advisory.vulnerable_versions))
          findings.push({
            package: name,
            version,
            severity,
            title: advisory.title ?? `advisory ${advisory.id ?? ''}`.trim(),
            ...(advisory.url ? { url: advisory.url } : {}),
          });
    }
  }
  return findings.sort(
    (left, right) =>
      SEVERITIES.indexOf(right.severity) - SEVERITIES.indexOf(left.severity) ||
      left.package.localeCompare(right.package) ||
      left.version.localeCompare(right.version),
  );
}

const runExecutor: PromiseExecutor<AuditProductionExecutorSchema> = async (
  options,
  context,
) => {
  const project = context.projectName
    ? context.projectsConfigurations?.projects[context.projectName]
    : undefined;
  if (!project) {
    logger.error('audit-production must run as a project target.');
    return { success: false };
  }
  if (!existsSync(join(context.root, 'pnpm-lock.yaml'))) {
    logger.error(
      'audit-production reads the pnpm dependency tree; this workspace has no pnpm-lock.yaml.',
    );
    return { success: false };
  }
  const manifestPath = join(context.root, project.root, 'package.json');
  const name = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown })
        .name
    : undefined;
  if (typeof name !== 'string' || !name) {
    logger.error(
      `${context.projectName} needs a named package.json to select its pnpm dependency tree.`,
    );
    return { success: false };
  }
  const { stdout } = await executeFile(
    'pnpm',
    ['list', '--prod', '--json', '--depth', 'Infinity', '--filter', name],
    { cwd: context.root, maxBuffer: 256 * 1024 * 1024 },
  );
  const packages = productionPackages(JSON.parse(stdout));
  const registry = (options.registry ?? 'https://registry.npmjs.org').replace(
    /\/+$/,
    '',
  );
  const response = await fetch(
    `${registry}/-/npm/v1/security/advisories/bulk`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        Object.fromEntries(
          [...packages].map(([pkg, versions]) => [pkg, [...versions].sort()]),
        ),
      ),
    },
  );
  if (!response.ok) {
    logger.error(
      `Advisory lookup failed: ${response.status} ${response.statusText}`,
    );
    return { success: false };
  }
  const findings = affectedFindings(
    packages,
    (await response.json()) as Record<string, Advisory[]>,
  );
  const threshold = SEVERITIES.indexOf(options.auditLevel ?? 'low');
  const failing = findings.filter(
    (finding) => SEVERITIES.indexOf(finding.severity) >= threshold,
  );
  for (const finding of findings) {
    const line = `${finding.severity} ${finding.package}@${finding.version}: ${finding.title}${finding.url ? ` (${finding.url})` : ''}`;
    if (SEVERITIES.indexOf(finding.severity) >= threshold) logger.error(line);
    else logger.warn(line);
  }
  logger.info(
    `${name}: ${packages.size} production package(s), ${findings.length} advisory finding(s), ${failing.length} at or above ${options.auditLevel ?? 'low'}.`,
  );
  return { success: failing.length === 0 };
};

export default runExecutor;
