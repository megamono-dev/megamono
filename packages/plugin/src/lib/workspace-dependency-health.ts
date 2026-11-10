import type { ProjectGraph } from '@nx/devkit';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { HealthFinding } from './health';
import { repositoryOwnedGraph } from './repository-graph';

const singletons = ['react', '@chakra-ui/react', '@emotion/react'] as const;
const sections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
interface Manifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
interface OwnedPackage {
  project: string;
  root: string;
  manifest?: Manifest;
}
interface Resolution {
  project: string;
  installation: string;
  version: string;
}
export interface SingletonInspection {
  readonly application: string;
  readonly package: string;
  readonly status:
    'single-installation' | 'multiple-installations' | 'incomplete';
  readonly resolutions: readonly Resolution[];
  readonly unavailable: readonly string[];
}
export interface WorkspaceDependencyInspection {
  readonly resolutionMode: 'node-require';
  readonly runtimeAssessment: 'not-assessed';
  readonly packageEdges: number;
  readonly limitations: readonly string[];
  readonly singletons: readonly SingletonInspection[];
}
const contained = (root: string, path: string) => {
  const part = relative(root, path);
  return (
    !isAbsolute(part) &&
    part !== '..' &&
    !part.startsWith('../') &&
    !part.startsWith('..\\')
  );
};
const declared = (manifest: Manifest | undefined, name: string) =>
  sections.some((section) => typeof manifest?.[section]?.[name] === 'string');

/** Read project manifests without following repository symlinks outside ownership. */
function packages(
  root: string,
  graph: ProjectGraph,
  limitations: string[],
): Map<string, OwnedPackage> {
  const result = new Map<string, OwnedPackage>();
  for (const [project, node] of Object.entries(graph.nodes).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const directory = resolve(root, node.data.root);
    if (!contained(root, directory) || !existsSync(directory)) continue;
    let actual: string;
    try {
      actual = realpathSync(directory);
    } catch {
      limitations.push(`${project}: project root could not be inspected`);
      continue;
    }
    if (!contained(realpathSync(root), actual)) {
      limitations.push(
        `${project}: project root is outside repository ownership`,
      );
      continue;
    }
    const entry: OwnedPackage = { project, root: directory };
    const file = join(directory, 'package.json');
    if (existsSync(file)) {
      if (!contained(realpathSync(root), realpathSync(file))) {
        limitations.push(
          `${project}: manifest is outside repository ownership`,
        );
        continue;
      }
      try {
        const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('Invalid manifest');
        const manifest = value as Manifest;
        if (manifest.name !== undefined && typeof manifest.name !== 'string')
          throw new Error('Invalid package name');
        for (const section of sections) {
          const entries = manifest[section];
          if (
            entries !== undefined &&
            (!entries ||
              typeof entries !== 'object' ||
              Array.isArray(entries) ||
              Object.values(entries).some((range) => typeof range !== 'string'))
          )
            throw new Error('Invalid dependency declarations');
        }
        entry.manifest = manifest;
      } catch {
        limitations.push(`${project}: package.json could not be assessed`);
      }
    }
    result.set(project, entry);
  }
  return result;
}

/** Resolve only through node_modules owned by this workspace, never NODE_PATH. */
function installed(
  root: string,
  owner: OwnedPackage,
  name: string,
): { installation: string; version: string } | undefined {
  let directory = owner.root;
  while (contained(root, directory)) {
    const locator = join(directory, 'node_modules', ...name.split('/'));
    if (existsSync(locator)) {
      try {
        const installation = realpathSync(locator);
        const manifest = JSON.parse(
          readFileSync(join(installation, 'package.json'), 'utf8'),
        ) as Manifest;
        if (manifest.name !== name) return undefined;
        const entry = realpathSync(
          createRequire(join(owner.root, 'package.json')).resolve(name),
        );
        if (!contained(installation, entry)) return undefined;
        return {
          installation,
          version:
            typeof manifest.version === 'string' ? manifest.version : 'unknown',
        };
      } catch {
        return undefined;
      }
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  return undefined;
}

/** Advisory package evidence. Does not infer browser bundling or change severity. */
export function inspectWorkspaceDependencies(
  workspaceRoot: string,
  input: ProjectGraph,
): {
  findings: HealthFinding[];
  inspection: WorkspaceDependencyInspection | undefined;
} {
  const root = resolve(workspaceRoot);
  const graph = repositoryOwnedGraph(input);
  const limitations: string[] = [];
  const owned = packages(root, graph, limitations);
  const findings: HealthFinding[] = [];
  let packageEdges = 0;
  for (const [source, edges] of Object.entries(graph.dependencies).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const owner = owned.get(source);
    if (!owner?.manifest?.name) continue;
    const targets = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!['static', 'dynamic'].includes(edge.type)) continue;
      const target = owned.get(edge.target);
      if (!target?.manifest?.name || target.root === owner.root) continue;
      const kinds = targets.get(target.manifest.name) ?? new Set<string>();
      kinds.add(edge.type);
      targets.set(target.manifest.name, kinds);
    }
    for (const [name, kinds] of [...targets].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      packageEdges++;
      if (declared(owner.manifest, name)) continue;
      findings.push({
        check: 'dependency-alignment',
        fingerprint: `workspace-import:${source}:${name}`,
        state: 'undeclared-workspace-import',
        confidence: 'complete',
        summary: `${source} imports workspace package ${name} without declaring it.`,
        evidence: [
          `${relative(root, owner.root).replaceAll('\\', '/')}/package.json`,
          `dependency kinds: ${[...kinds].sort().join(', ')}`,
        ],
        recommendation: `Declare ${name} in the appropriate dependencies, peerDependencies or devDependencies section and run the workspace package manager. A path alias or hoisted root dependency does not declare this package's ownership.`,
      });
    }
  }
  // A library that bundles its own React/Chakra/Emotion copy splits provider
  // context from the application's. Peers let the application own the copy.
  for (const [project, node] of Object.entries(graph.nodes).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const owner = owned.get(project);
    if (node.type !== 'lib' || !owner?.manifest) continue;
    for (const name of singletons) {
      if (
        typeof owner.manifest.dependencies?.[name] !== 'string' ||
        typeof owner.manifest.peerDependencies?.[name] === 'string'
      )
        continue;
      findings.push({
        check: 'dependency-alignment',
        fingerprint: `singleton-dependency:${project}:${name}`,
        state: 'singleton-regular-dependency',
        confidence: 'complete',
        summary: `${project} declares ${name} as a regular dependency instead of a peer.`,
        evidence: [
          `${relative(root, owner.root).replaceAll('\\', '/')}/package.json`,
          `dependencies.${name}: ${owner.manifest.dependencies[name]}`,
        ],
        recommendation: `Move ${name} to peerDependencies (and devDependencies for the library's own tests) so consuming applications provide one shared installation.`,
      });
    }
  }
  const inspections: SingletonInspection[] = [];
  for (const [application, node] of Object.entries(graph.nodes).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    if (node.type !== 'app' || !owned.has(application)) continue;
    const closure = new Set<string>();
    const visit = (name: string) => {
      if (closure.has(name)) return;
      closure.add(name);
      for (const edge of graph.dependencies[name] ?? [])
        if (['static', 'dynamic'].includes(edge.type) && owned.has(edge.target))
          visit(edge.target);
    };
    visit(application);
    for (const name of singletons) {
      const consumers = [...closure]
        .sort()
        .map((project) => owned.get(project))
        .filter((value): value is OwnedPackage =>
          Boolean(
            value &&
            (value.project === application || declared(value.manifest, name)),
          ),
        );
      if (!consumers.some((value) => declared(value.manifest, name))) continue;
      const resolutions: Resolution[] = [],
        unavailable: string[] = [];
      for (const consumer of consumers) {
        const resolution = installed(root, consumer, name);
        if (resolution)
          resolutions.push({ project: consumer.project, ...resolution });
        else unavailable.push(consumer.project);
      }
      const installations = new Set(
        resolutions.map((item) => item.installation),
      );
      const display = resolutions.map((item) => ({
        ...item,
        installation: contained(realpathSync(root), item.installation)
          ? relative(realpathSync(root), item.installation).replaceAll(
              '\\',
              '/',
            )
          : `external installation of ${name}@${item.version}`,
      }));
      inspections.push({
        application,
        package: name,
        status: unavailable.length
          ? 'incomplete'
          : installations.size > 1
            ? 'multiple-installations'
            : 'single-installation',
        resolutions: display,
        unavailable: unavailable.sort(),
      });
      if (unavailable.length)
        limitations.push(
          `${application}: ${name} resolution unavailable for ${unavailable.sort().join(', ')}; node_modules resolution only, no ambient fallback`,
        );
      if (installations.size > 1)
        findings.push({
          check: 'dependency-alignment',
          fingerprint: `installed-singleton:${application}:${name}`,
          state: 'multiple-installed-singletons',
          confidence: 'reduced',
          summary: `${application}'s project closure resolves more than one installed ${name} package.`,
          evidence: display
            .map(
              (item) =>
                `${item.project}: ${name}@${item.version} (${item.installation})`,
            )
            .sort(),
          recommendation:
            'Verify the application bundle and provider context. Prefer peer dependencies for shared UI packages; preserve intentionally separate runtimes. This is installed Node-resolution evidence, not proof of duplicate browser code.',
        });
    }
  }
  const inspection =
    packageEdges || inspections.length || limitations.length
      ? {
          resolutionMode: 'node-require' as const,
          runtimeAssessment: 'not-assessed' as const,
          packageEdges,
          limitations: [...new Set(limitations)].sort(),
          singletons: inspections,
        }
      : undefined;
  return { findings, inspection };
}
