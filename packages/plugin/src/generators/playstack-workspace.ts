import { getProjects, readJson, type Tree } from '@nx/devkit';
import { megamonoConfigSchema } from '../lib/config';

const integrationPackages = new Set([
  '@playstack/cli',
  '@playstack/lint',
  '@playstack/skills',
]);

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly devDependencies?: Readonly<Record<string, unknown>>;
  readonly optionalDependencies?: Readonly<Record<string, unknown>>;
}

export class PlaystackWorkspaceIntegrationError extends Error {
  readonly exitCode = 3;
  readonly diagnosticCode = 'playstack-integration-preflight';
}

export function readInitializedMegamonoWorkspace(tree: Tree) {
  const source = tree.read('megamono.json', 'utf8');
  if (!source) {
    throw new PlaystackWorkspaceIntegrationError(
      'megamono.json is missing; run workspace-init first.',
    );
  }
  try {
    return megamonoConfigSchema.parse(JSON.parse(source));
  } catch (cause) {
    throw new PlaystackWorkspaceIntegrationError(
      'megamono.json must be valid before wiring a Playstack integration.',
      { cause },
    );
  }
}

export function assertInitializedMegamonoWorkspace(tree: Tree): void {
  readInitializedMegamonoWorkspace(tree);
}

function dependencyNames(manifest: PackageManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
}

export function declaredPlaystackProductPackages(tree: Tree): string[] {
  const manifests = new Set(['package.json']);
  for (const project of getProjects(tree).values()) {
    const path = `${project.root}/package.json`;
    if (tree.exists(path)) manifests.add(path);
  }
  return [
    ...new Set(
      [...manifests].flatMap((path) =>
        dependencyNames(readJson<PackageManifest>(tree, path)).filter(
          (name) =>
            name.startsWith('@playstack/') && !integrationPackages.has(name),
        ),
      ),
    ),
  ].sort();
}

export function assertPlaystackProductInstalled(tree: Tree): string[] {
  const products = declaredPlaystackProductPackages(tree);
  if (products.length === 0) {
    throw new PlaystackWorkspaceIntegrationError(
      'No @playstack/* product package is declared; workspace-level Playstack integration is intentionally omitted until a product uses it.',
    );
  }
  return products;
}

export function retainedLocalPackageVersion(
  tree: Tree,
  packageName: string,
  compatibleVersion: string,
): string {
  const manifest = readJson<PackageManifest>(tree, 'package.json');
  const current = manifest.devDependencies?.[packageName];
  return typeof current === 'string' &&
    /^(?:file:|link:|workspace:)/.test(current)
    ? current
    : compatibleVersion;
}

export function declaredRootDevelopmentDependency(
  tree: Tree,
  packageName: string,
): string | undefined {
  const value = readJson<PackageManifest>(tree, 'package.json')
    .devDependencies?.[packageName];
  return typeof value === 'string' ? value : undefined;
}
