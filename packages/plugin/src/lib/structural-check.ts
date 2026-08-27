import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectGraph } from '@nx/devkit';
import type { MegamonoConfig } from './config';
import type { Diagnostic } from './diagnostics';

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
  'platform:apple',
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

const allowedTypeDependencies: Readonly<Record<string, readonly string[]>> = {
  app: ['app', 'feature', 'ui', 'data', 'util'],
  feature: ['ui', 'data', 'util'],
  ui: ['util'],
  data: ['util'],
  util: ['util'],
};

function validateDependencies(
  graph: ProjectGraph,
  diagnostics: Diagnostic[],
): void {
  for (const [sourceName, dependencies] of Object.entries(graph.dependencies)) {
    const source = graph.nodes[sourceName];
    if (!source) continue;
    const sourceTags = source.data.tags ?? [];
    const sourceType = tagValue(sourceTags, 'type:');
    const sourceScope = tagValue(sourceTags, 'scope:');
    const sourcePlatform = tagValue(sourceTags, 'platform:');

    for (const dependency of dependencies) {
      const target = graph.nodes[dependency.target];
      if (!target) continue;
      const targetTags = target.data.tags ?? [];
      const targetType = tagValue(targetTags, 'type:');
      const targetScope = tagValue(targetTags, 'scope:');
      const targetPlatform = tagValue(targetTags, 'platform:');

      if (
        sourceScope &&
        targetScope &&
        !(
          sourceScope === targetScope ||
          (sourceScope !== 'shared' && targetScope === 'shared')
        )
      ) {
        diagnostics.push(
          projectDiagnostic(
            'module-boundaries',
            sourceName,
            `${sourceName} (${sourceScope}) may not depend on ${dependency.target} (${targetScope}).`,
          ),
        );
      }
      if (
        sourceType &&
        targetType &&
        !allowedTypeDependencies[sourceType]?.includes(targetType)
      ) {
        diagnostics.push(
          projectDiagnostic(
            'module-boundaries',
            sourceName,
            `type:${sourceType} may not depend on type:${targetType} (${dependency.target}).`,
          ),
        );
      }
      if (targetPlatform && sourcePlatform !== targetPlatform) {
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
}

interface PackageManifest {
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

async function validateManifests(
  workspaceRoot: string,
  graph: ProjectGraph,
  config: MegamonoConfig,
  diagnostics: Diagnostic[],
): Promise<void> {
  const rootManifest = await readManifest(join(workspaceRoot, 'package.json'));
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

export async function checkWorkspaceStructure(
  workspaceRoot: string,
  graph: ProjectGraph,
  config: MegamonoConfig,
  acceptedDecisionIds: ReadonlySet<string> = new Set(),
): Promise<readonly Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  validateTagCardinality(graph, diagnostics);
  validateDependencies(graph, diagnostics);
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
  return diagnostics
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
}
