import { formatFiles, logger, type GeneratorCallback, type Tree } from '@nx/devkit';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PlaystackIntegrateGeneratorSchema {
  readonly packages: string;
  readonly web?: string;
  readonly api?: string;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
}

type Surface = 'web' | 'api';

interface IntegrationRequirements {
  readonly routes?: readonly string[];
  readonly modules?: readonly string[];
  readonly providers?: readonly string[];
  readonly environment?: readonly string[];
  readonly healthChecks?: readonly string[];
  readonly frameworkConfiguration?: readonly string[];
  readonly tests?: readonly string[];
  readonly rawBody?: boolean;
}

interface IntegrationManifest {
  readonly schemaVersion: 1;
  readonly package: string;
  readonly integrations: readonly {
    readonly id: string;
    readonly surface: Surface;
    readonly framework: string;
    readonly requirements: IntegrationRequirements;
    readonly files: readonly { readonly source: string; readonly target: string }[];
  }[];
}

interface PlannedFile {
  readonly package: string;
  readonly integration: string;
  readonly source: string;
  readonly target: string;
  readonly content: string;
}

function safePath(value: string, label: string): string {
  const path = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').includes('..')
  )
    throw new Error(`${label} must be a safe workspace-relative path.`);
  return path;
}

function packageNames(value: string): string[] {
  const names = [...new Set(value.split(',').map((name) => name.trim()).filter(Boolean))];
  if (
    names.length === 0 ||
    names.some((name) => !/^@playstack\/[a-z0-9][a-z0-9._-]*$/.test(name))
  )
    throw new Error('--packages must contain installed @playstack/<name> packages.');
  return names.sort();
}

function packagePath(name: string, suffix: string): string {
  return `node_modules/${name}/${suffix}`;
}

function readPackageFile(tree: Tree, path: string): string | null {
  const fromTree = tree.read(path, 'utf8');
  if (fromTree !== null) return fromTree;
  if (tree.root === '/virtual') return null;
  try {
    return readFileSync(resolve(tree.root, path), 'utf8');
  } catch {
    return null;
  }
}

function manifest(tree: Tree, name: string): IntegrationManifest {
  const path = packagePath(name, 'playstack.integration.json');
  const source = readPackageFile(tree, path);
  if (!source)
    throw new Error(
      `${name} does not publish playstack.integration.json; application wiring remains package-documented and cannot be generated.`,
    );
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  const candidate = value as Partial<IntegrationManifest> | null;
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    candidate.package !== name ||
    !Array.isArray(candidate.integrations)
  )
    throw new Error(`${path} does not satisfy integration schema version 1.`);
  return candidate as IntegrationManifest;
}

function resolvedTarget(
  target: string,
  surface: Surface,
  root: string,
  integration: string,
): string {
  const replaced = target
    .replaceAll(`{${surface}Root}`, root)
    .replaceAll('{integrationId}', integration);
  if (replaced.includes('{'))
    throw new Error(`Integration target ${target} contains an unsupported placeholder.`);
  return safePath(replaced, 'Integration target');
}

function requirementRecord(
  source: IntegrationManifest,
  integration: IntegrationManifest['integrations'][number],
) {
  return {
    package: source.package,
    id: integration.id,
    surface: integration.surface,
    framework: integration.framework,
    requirements: integration.requirements,
  };
}

export async function playstackIntegrateGenerator(
  tree: Tree,
  options: PlaystackIntegrateGeneratorSchema,
): Promise<GeneratorCallback> {
  const roots: Partial<Record<Surface, string>> = {
    ...(options.web ? { web: safePath(options.web, '--web') } : {}),
    ...(options.api ? { api: safePath(options.api, '--api') } : {}),
  };
  const manifests = packageNames(options.packages).map((name) => manifest(tree, name));
  const files: PlannedFile[] = [];
  const requirements: ReturnType<typeof requirementRecord>[] = [];
  for (const source of manifests) {
    for (const integration of source.integrations) {
      const root = roots[integration.surface];
      if (!root)
        throw new Error(
          `${source.package} integration ${integration.id} requires --${integration.surface}=<Nx project root>.`,
        );
      requirements.push(requirementRecord(source, integration));
      for (const file of integration.files) {
        const sourcePath = packagePath(source.package, safePath(file.source, 'Integration source'));
        const content = readPackageFile(tree, sourcePath);
        if (content === null)
          throw new Error(`${source.package} integration source ${file.source} is missing.`);
        files.push({
          package: source.package,
          integration: integration.id,
          source: file.source,
          target: resolvedTarget(file.target, integration.surface, root, integration.id),
          content,
        });
      }
    }
  }
  const duplicate = files.find(
    (file, index) => files.findIndex(({ target }) => target === file.target) !== index,
  );
  if (duplicate)
    throw new Error(`Multiple integration artifacts target ${duplicate.target}.`);
  for (const file of files) {
    const current = tree.read(file.target, 'utf8');
    if (current !== null && current !== file.content)
      throw new Error(
        `${file.target} already exists with repository-owned content; integration generation is fail-closed.`,
      );
  }
  const plan = {
    schemaVersion: 1,
    packages: manifests.map(({ package: name }) => name),
    requirements,
    files: files.map(({ content: _content, ...file }) => file),
  };
  if (options.dryRun) {
    logger.info(JSON.stringify(plan, null, 2));
    return () => undefined;
  }
  if (!options.yes)
    throw new Error('Integration generation requires --yes after reviewing --dry-run.');
  for (const file of files) tree.write(file.target, file.content);
  tree.write(
    '.megamono/playstack-integration-plan.json',
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  await formatFiles(tree);
  return () => undefined;
}

export default playstackIntegrateGenerator;
