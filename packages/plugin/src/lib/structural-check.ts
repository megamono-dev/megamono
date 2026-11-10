import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProjectGraph } from '@nx/devkit';
import type { MegamonoConfig } from './config';
import type { Diagnostic } from './diagnostics';
import { isTauriProject } from './tauri-platform';
import { repositoryOwnedGraph } from './repository-graph';
import { checkNextPagesBoundary } from './next-pages-boundary';
import {
  checkExtensionRuntimeBoundary,
  extensionAllowsWebEdge,
  type ExtensionRuntimeEntries,
} from './extension-runtime';
import {
  allowedTypeDependencies,
  matchingBoundaryAllowance,
  validateBoundaryAllowances,
} from './boundary-policy';
import {
  classifyDependency,
  type BoundaryAllowance,
  type DependencyFindingIdentity,
} from './dependency-policy-contract';

const typeTags = [
  'type:app',
  'type:feature',
  'type:ui',
  'type:data',
  'type:util',
];
const platformTags = [
  'platform:web',
  'platform:node',
  'platform:worker',
  'platform:mobile',
  'platform:apple',
  'platform:android',
  'platform:rust',
  'platform:php',
  'platform:extension',
];
const visibilityTags = ['visibility:public', 'visibility:internal'];
const capabilityTags = ['capability:theme-tokens'];
const scopeTagPattern = /^scope:[a-z0-9]+(?:-[a-z0-9]+)*$/;

function tagsInFamily(
  tags: readonly string[],
  family: readonly string[],
): string[] {
  return tags.filter((tag) => family.includes(tag));
}

function tagValue(tags: readonly string[], prefix: string): string | undefined {
  return tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

function projectDiagnostic(
  code: string,
  project: string,
  message: string,
): Diagnostic {
  return { severity: 'error', code, path: project, message };
}

function validateTagCardinality(
  graph: ProjectGraph,
  diagnostics: Diagnostic[],
): void {
  const themeTokenProjects: string[] = [];
  for (const [name, node] of Object.entries(graph.nodes)) {
    const tags = node.data.tags ?? [];
    const types = tagsInFamily(tags, typeTags);
    const scopes = tags.filter((tag) => tag.startsWith('scope:'));
    const platforms = tagsInFamily(tags, platformTags);
    const visibility = tagsInFamily(tags, visibilityTags);
    const capabilities = tags.filter((tag) => tag.startsWith('capability:'));
    const isApplication = node.type === 'app' || node.type === 'e2e';

    if (types.length !== 1) {
      diagnostics.push(
        projectDiagnostic(
          'require-tags',
          name,
          `Expected exactly one type tag; found ${types.length}.`,
        ),
      );
    }
    if (scopes.length !== 1) {
      diagnostics.push(
        projectDiagnostic(
          'require-tags',
          name,
          `Expected exactly one scope tag; found ${scopes.length}.`,
        ),
      );
    } else if (!scopeTagPattern.test(scopes[0])) {
      diagnostics.push(
        projectDiagnostic(
          'require-tags',
          name,
          `Invalid scope tag ${scopes[0]}; expected scope:<lowercase-hyphenated-name>.`,
        ),
      );
    }
    if (isApplication && platforms.length !== 1) {
      diagnostics.push(
        projectDiagnostic(
          'require-tags',
          name,
          `Applications require exactly one platform tag; found ${platforms.length}.`,
        ),
      );
    }
    if (!isApplication && platforms.length > 1) {
      diagnostics.push(
        projectDiagnostic(
          'require-tags',
          name,
          `Libraries allow at most one platform tag; found ${platforms.length}.`,
        ),
      );
    }
    if (isApplication && visibility.length !== 1) {
      diagnostics.push(
        projectDiagnostic(
          'require-tags',
          name,
          `Applications require exactly one visibility tag; found ${visibility.length}.`,
        ),
      );
    }
    if (!isApplication && visibility.length > 0) {
      diagnostics.push(
        projectDiagnostic(
          'require-tags',
          name,
          'Only applications may carry a visibility tag.',
        ),
      );
    }
    for (const capability of capabilities.filter(
      (tag) => !capabilityTags.includes(tag),
    )) {
      diagnostics.push(
        projectDiagnostic(
          'require-tags',
          name,
          `Unknown capability tag ${capability}.`,
        ),
      );
    }
    if (tags.filter((tag) => tag === 'capability:theme-tokens').length > 1) {
      diagnostics.push(
        projectDiagnostic(
          'require-tags',
          name,
          'capability:theme-tokens may appear only once on a project.',
        ),
      );
    }
    if (tags.includes('capability:theme-tokens')) {
      themeTokenProjects.push(name);
      if (types[0] !== 'type:util' || platforms.length > 0 || isApplication) {
        diagnostics.push(
          projectDiagnostic(
            'require-tags',
            name,
            'capability:theme-tokens requires a platform-neutral type:util library.',
          ),
        );
      }
    }
  }
  if (themeTokenProjects.length > 1) {
    for (const name of themeTokenProjects) {
      diagnostics.push(
        projectDiagnostic(
          'require-tags',
          name,
          `capability:theme-tokens must be unique; found ${themeTokenProjects.sort().join(', ')}.`,
        ),
      );
    }
  }
}

function validateDependencies(
  workspaceRoot: string,
  graph: ProjectGraph,
  diagnostics: Diagnostic[],
  docsRoot: string,
): ExtensionRuntimeReport[] {
  const runtimeReports: ExtensionRuntimeReport[] = [];
  for (const [sourceName, dependencies] of Object.entries(graph.dependencies)) {
    const source = graph.nodes[sourceName];
    if (!source) continue;
    const sourceTags = source.data.tags ?? [];
    const sourceType = tagValue(sourceTags, 'type:');
    const sourceScope = tagValue(sourceTags, 'scope:');
    const sourcePlatform = tagValue(sourceTags, 'platform:');
    // Aggregate graph edges cannot distinguish a native host from its frontend
    // or tooling. The source-level rule enforces the individual file boundary.
    const tauri =
      source.type === 'app' &&
      isTauriProject(join(workspaceRoot, source.data.root), existsSync);
    const nextPages =
      source.type === 'app' && sourcePlatform === 'web'
        ? checkNextPagesBoundary(
            workspaceRoot,
            join(workspaceRoot, source.data.root),
            graph,
          )
        : undefined;
    const extension =
      source.type === 'app' && sourcePlatform === 'extension'
        ? checkExtensionRuntimeBoundary(
            workspaceRoot,
            join(workspaceRoot, source.data.root),
            graph,
            docsRoot,
          )
        : undefined;
    const applied: ExtensionRuntimeReport['applied'][number][] = [];
    if (extension) {
      for (const message of extension.policyErrors)
        diagnostics.push(
          projectDiagnostic('extension-runtime-policy', sourceName, message),
        );
      for (const issue of extension.issues)
        diagnostics.push(
          projectDiagnostic(
            'platform-boundary',
            sourceName,
            `${issue.file}: ${issue.message}`,
          ),
        );
      runtimeReports.push({
        project: sourceName,
        contract: extension.contract,
        complete: extension.complete,
        applied,
      });
    }
    for (const violation of nextPages?.violations ?? []) {
      diagnostics.push(
        projectDiagnostic('platform-boundary', sourceName, violation),
      );
    }

    for (const dependency of dependencies) {
      const target = graph.nodes[dependency.target];
      if (!target) continue;
      const targetTags = target.data.tags ?? [];
      const targetType = tagValue(targetTags, 'type:');
      const targetScope = tagValue(targetTags, 'scope:');
      const targetPlatform = tagValue(targetTags, 'platform:');
      const extensionWeb =
        targetPlatform === 'web' &&
        extensionAllowsWebEdge(
          extension,
          resolve(workspaceRoot, target.data.root),
          dependency.type,
        );
      if (extensionWeb)
        for (const use of extension?.uses ?? [])
          if (
            use.target === dependency.target &&
            use.kind === dependency.type &&
            !applied.some(
              (entry) =>
                entry.target === use.target &&
                entry.dependencyKind === use.kind &&
                entry.source === use.file,
            )
          )
            applied.push({
              target: use.target,
              dependencyKind: use.kind,
              source: use.file,
            });
      // An explicitly identified e2e project schedules the applications it
      // tests through implicit edges. This is only a platform exemption for
      // this edge; imports and every other dependency constraint still apply.
      const testOrchestration =
        (source.type === 'e2e' || sourceTags.includes('role:e2e')) &&
        dependency.type === 'implicit' &&
        target.type === 'app' &&
        !targetTags.includes('role:e2e');

      const classification = classifyDependency(
        source,
        target,
        dependency.type,
      );
      const identity = (constraint: DependencyFindingIdentity['constraint']) =>
        classification
          ? {
              rule: 'module-boundaries' as const,
              constraint,
              source: sourceName,
              target: dependency.target,
              classification,
            }
          : undefined;
      if (
        sourceScope &&
        targetScope &&
        !(
          sourceScope === targetScope ||
          (sourceScope !== 'shared' && targetScope === 'shared')
        )
      ) {
        diagnostics.push({
          ...projectDiagnostic(
            'module-boundaries',
            sourceName,
            `${sourceName} (${sourceScope}) may not depend on ${dependency.target} (${targetScope}).`,
          ),
          identity: identity('module-boundaries:scope-direction'),
        });
      }
      if (
        sourceType &&
        targetType &&
        !allowedTypeDependencies[sourceType]?.includes(targetType)
      ) {
        diagnostics.push({
          ...projectDiagnostic(
            'module-boundaries',
            sourceName,
            `type:${sourceType} may not depend on type:${targetType} (${dependency.target}).`,
          ),
          identity: identity('module-boundaries:type-direction'),
        });
      }
      if (
        targetPlatform &&
        sourcePlatform !== targetPlatform &&
        !testOrchestration &&
        !(nextPages && targetPlatform === 'node') &&
        !extensionWeb &&
        !(tauri && ['rust', 'web', 'node'].includes(targetPlatform))
      ) {
        diagnostics.push(
          projectDiagnostic(
            'platform-boundary',
            sourceName,
            `platform:${sourcePlatform} may not depend on platform:${targetPlatform} (${dependency.target}).`,
          ),
        );
      }
      if (
        sourceName.startsWith('@playstack/') &&
        dependency.target.startsWith('@megamono/')
      ) {
        diagnostics.push(
          projectDiagnostic(
            'playstack-direction',
            sourceName,
            `Playstack project ${sourceName} may not depend on ${dependency.target}.`,
          ),
        );
      }
    }
  }
  return runtimeReports;
}

export interface ExtensionRuntimeReport {
  readonly project: string;
  readonly contract?: ExtensionRuntimeEntries;
  readonly complete: boolean;
  readonly applied: readonly {
    readonly target?: string;
    readonly dependencyKind: 'static' | 'dynamic';
    readonly source: string;
  }[];
}

interface PackageManifest {
  generators?: string;
  executors?: string;
  readonly bin?: string | Readonly<Record<string, string>>;
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

async function readManifest(
  path: string,
): Promise<PackageManifest | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as PackageManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function megamonoPackages(
  dependencies: Readonly<Record<string, string>> | undefined,
): string[] {
  return Object.keys(dependencies ?? {}).filter((name) =>
    name.startsWith('@megamono/'),
  );
}

function hasBinary(
  manifest: PackageManifest | undefined,
  name: string,
): boolean {
  const bin = manifest?.bin;
  return (
    typeof bin === 'object' &&
    bin !== null &&
    typeof bin[name] === 'string' &&
    bin[name].length > 0
  );
}

async function validateManifests(
  workspaceRoot: string,
  graph: ProjectGraph,
  config: MegamonoConfig,
  diagnostics: Diagnostic[],
): Promise<void> {
  const rootManifest = await readManifest(join(workspaceRoot, 'package.json'));
  // Plugin authors may compose other local Megamono plugins. This does not
  // permit applications (or Playstack packages) to ship Megamono at runtime.
  const localTooling = new Set<string>();
  let hasLocalCli = false;
  for (const node of Object.values(graph.nodes)) {
    const manifest = await readManifest(
      join(workspaceRoot, node.data.root, 'package.json'),
    );
    if (
      node.type === 'lib' &&
      manifest?.name === '@megamono/cli' &&
      hasBinary(manifest, 'megamono')
    )
      hasLocalCli = true;
    if (
      node.type === 'lib' &&
      manifest?.name?.startsWith('@megamono/') &&
      (typeof manifest.generators === 'string' ||
        typeof manifest.executors === 'string')
    )
      localTooling.add(manifest.name);
  }
  for (const field of [
    'dependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const) {
    for (const packageName of megamonoPackages(rootManifest?.[field])) {
      diagnostics.push({
        severity: 'error',
        code: 'megamono-dev-only',
        path: 'package.json',
        message: `${packageName} must be in root devDependencies, not ${field}.`,
      });
    }
  }

  for (const [projectName, node] of Object.entries(graph.nodes)) {
    const manifestPath = join(workspaceRoot, node.data.root, 'package.json');
    const manifest = await readManifest(manifestPath);
    if (!manifest || manifestPath === join(workspaceRoot, 'package.json'))
      continue;
    if (
      config.conventions.nestFeatureLibraries &&
      (node.data.tags ?? []).includes('type:feature') &&
      (node.data.tags ?? []).includes('platform:node') &&
      !/^@[^/]+\/nest-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name ?? '')
    ) {
      diagnostics.push(
        projectDiagnostic(
          'naming-convention',
          projectName,
          'Node feature libraries must use the package name @[repo]/nest-[feature].',
        ),
      );
    }
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ] as const) {
      for (const packageName of megamonoPackages(manifest[field])) {
        // The published bootstrapper re-exports the repository-owned CLI's
        // Springbar setup contract. This is tooling composition, not app runtime.
        if (
          node.type === 'lib' &&
          manifest.name === 'create-megamono' &&
          hasBinary(manifest, 'create-megamono') &&
          packageName === '@megamono/cli' &&
          hasLocalCli
        )
          continue;
        if (
          node.type === 'lib' &&
          manifest.name &&
          localTooling.has(manifest.name) &&
          localTooling.has(packageName)
        )
          continue;
        diagnostics.push(
          projectDiagnostic(
            'megamono-dev-only',
            projectName,
            `${packageName} must be installed only in root devDependencies, not ${node.data.root}/package.json ${field}.`,
          ),
        );
      }
    }
    if (manifest.name?.startsWith('@playstack/')) {
      const allDependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      };
      for (const packageName of megamonoPackages(allDependencies)) {
        diagnostics.push(
          projectDiagnostic(
            'playstack-direction',
            projectName,
            `${manifest.name} may not declare ${packageName}.`,
          ),
        );
      }
    }
  }
}

export async function analyzeWorkspaceStructure(
  workspaceRoot: string,
  graph: ProjectGraph,
  config: MegamonoConfig,
  acceptedDecisionIds: ReadonlySet<string> = new Set(),
  enabledRules?: ReadonlySet<string>,
): Promise<StructuralAnalysis> {
  graph = repositoryOwnedGraph(graph);
  const diagnostics: Diagnostic[] = [];
  validateTagCardinality(graph, diagnostics);
  const extensionRuntime = validateDependencies(
    workspaceRoot,
    graph,
    diagnostics,
    config.docs.root,
  );
  await validateManifests(workspaceRoot, graph, config, diagnostics);

  const invalidOverrides = new Set<string>();
  for (const [rule, override] of Object.entries(config.conventions.rules)) {
    if (
      override.severity === 'off' &&
      override.decision &&
      !acceptedDecisionIds.has(override.decision)
    ) {
      invalidOverrides.add(rule);
      diagnostics.push({
        severity: 'error',
        code: 'rule-override-decision',
        path: 'megamono.json',
        message: `Disabled rule ${rule} references a missing or non-accepted decision ${override.decision}.`,
      });
    }
  }
  const configuredRules = config.conventions.rules as Readonly<
    Record<
      string,
      { severity: 'off' | 'warning' | 'error'; decision?: string } | undefined
    >
  >;
  const rawDiagnostics = diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.code === 'rule-override-decision' ||
        diagnostic.code === 'extension-runtime-policy' ||
        enabledRules === undefined ||
        enabledRules.has(diagnostic.code),
    )
    .filter((diagnostic) => {
      const override = configuredRules[diagnostic.code];
      return !(
        override?.severity === 'off' && !invalidOverrides.has(diagnostic.code)
      );
    })
    .map((diagnostic) => {
      const severity = configuredRules[diagnostic.code]?.severity;
      if (severity === 'warning' || severity === 'error') {
        return { ...diagnostic, severity };
      }
      return diagnostic;
    });
  const policy = validateBoundaryAllowances(workspaceRoot, graph, config);
  const allowed: StructuralAnalysis['allowed'][number][] = [];
  const effective = rawDiagnostics.filter((diagnostic) => {
    const allowance =
      diagnostic.identity &&
      matchingBoundaryAllowance(diagnostic.identity, policy.valid);
    if (!allowance) return true;
    allowed.push({ diagnostic, allowance });
    return false;
  });
  return {
    diagnostics: [...effective, ...policy.diagnostics],
    rawDiagnostics: [...rawDiagnostics, ...policy.diagnostics],
    allowed,
    ...(extensionRuntime.length ? { extensionRuntime } : {}),
  };
}

export interface StructuralAnalysis {
  readonly extensionRuntime?: readonly ExtensionRuntimeReport[];
  readonly diagnostics: readonly Diagnostic[];
  readonly rawDiagnostics: readonly Diagnostic[];
  readonly allowed: readonly {
    readonly diagnostic: Diagnostic;
    readonly allowance: BoundaryAllowance;
  }[];
}

/** Existing callers receive the effective diagnostics as before. */
export async function checkWorkspaceStructure(
  workspaceRoot: string,
  graph: ProjectGraph,
  config: MegamonoConfig,
  acceptedDecisionIds: ReadonlySet<string> = new Set(),
  enabledRules?: ReadonlySet<string>,
): Promise<readonly Diagnostic[]> {
  return (
    await analyzeWorkspaceStructure(
      workspaceRoot,
      graph,
      config,
      acceptedDecisionIds,
      enabledRules,
    )
  ).diagnostics;
}
