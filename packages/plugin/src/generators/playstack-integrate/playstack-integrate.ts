import { formatFiles, logger, type GeneratorCallback, type Tree } from '@nx/devkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';

export interface PlaystackIntegrateGeneratorSchema {
  readonly packages: string;
  readonly web?: string;
  readonly api?: string;
  readonly worker?: string;
  readonly portable?: string;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
}

type Surface = 'portable' | 'web' | 'api' | 'worker';

interface IntegrationTemplate {
  readonly id: string;
  readonly kind: 'module' | 'provider' | 'policy' | 'controller' | 'health' | 'test';
  readonly source: string;
  readonly target: string;
  readonly description?: string;
  readonly when?: string;
  readonly ejectable: true;
  readonly sha256: string;
}

interface IntegrationRequirements {
  readonly moduleImports?: readonly {
    readonly export: string;
    readonly registration: readonly string[];
  }[];
  readonly providerTokens?: readonly string[];
  readonly databaseArtifacts?: readonly {
    readonly package: string;
    readonly required: boolean;
    readonly formats: readonly ('prisma' | 'drizzle')[];
    readonly when?: string;
  }[];
  readonly environment?: readonly {
    readonly key: string;
    readonly suggestedNames?: readonly string[];
    readonly required: boolean;
    readonly secret: boolean;
    readonly when?: string;
  }[];
  readonly routes?: readonly {
    readonly id: string;
    readonly methods: readonly string[];
    readonly path: string;
    readonly rawBody: boolean;
    readonly authentication?: string;
  }[];
  readonly healthChecks?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly required: boolean;
    readonly when?: string;
  }[];
  readonly frameworkConfiguration?: readonly {
    readonly key: string;
    readonly value: unknown;
  }[];
  readonly requiredTests?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly when?: string;
  }[];
  readonly decisions?: readonly {
    readonly key: string;
    readonly prompt: string;
    readonly required: boolean;
    readonly options?: readonly string[];
    readonly when?: string;
  }[];
}

interface IntegrationManifest {
  readonly version: 1;
  readonly package: string;
  readonly packageVersion: string;
  readonly integrations: readonly {
    readonly id: string;
    readonly surface: Surface;
    readonly framework?: 'react' | 'next' | 'nest' | 'node' | 'worker';
    readonly when?: string;
    readonly requirements: IntegrationRequirements;
    readonly templates?: readonly IntegrationTemplate[];
  }[];
}

interface PlannedFile {
  readonly package: string;
  readonly integration: string;
  readonly id: string;
  readonly kind: IntegrationTemplate['kind'];
  readonly description?: string;
  readonly source: string;
  readonly target: string;
  readonly sha256: string;
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
    candidate.version !== 1 ||
    candidate.package !== name ||
    typeof candidate.packageVersion !== 'string' ||
    candidate.packageVersion.length === 0 ||
    !Array.isArray(candidate.integrations)
  )
    throw new Error(`${path} does not satisfy integration schema version 1.`);
  const packageJsonPath = packagePath(name, 'package.json');
  const packageJsonSource = readPackageFile(tree, packageJsonPath);
  if (!packageJsonSource)
    throw new Error(`${packageJsonPath} is required to verify the integration manifest.`);
  let packageVersion: unknown;
  try {
    packageVersion = (JSON.parse(packageJsonSource) as { version?: unknown }).version;
  } catch {
    throw new Error(`${packageJsonPath} is not valid JSON.`);
  }
  if (packageVersion !== candidate.packageVersion)
    throw new Error(
      `${path} declares packageVersion ${candidate.packageVersion}, but ${packageJsonPath} declares ${String(packageVersion)}.`,
    );
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
  const safe = safePath(replaced, 'Integration target');
  return safe.startsWith(`${root}/`) ? safe : safePath(posix.join(root, safe), 'Integration target');
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
    ...(options.portable ? { portable: safePath(options.portable, '--portable') } : {}),
    ...(options.web ? { web: safePath(options.web, '--web') } : {}),
    ...(options.api ? { api: safePath(options.api, '--api') } : {}),
    ...(options.worker ? { worker: safePath(options.worker, '--worker') } : {}),
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
      for (const template of integration.templates ?? []) {
        if (
          template.ejectable !== true ||
          !/^[a-f0-9]{64}$/.test(template.sha256)
        )
          throw new Error(
            `${source.package} integration template ${template.id} has invalid ownership or integrity metadata.`,
          );
        const sourcePath = packagePath(source.package, safePath(template.source, 'Integration source'));
        const content = readPackageFile(tree, sourcePath);
        if (content === null)
          throw new Error(`${source.package} integration source ${template.source} is missing.`);
        const actualHash = createHash('sha256').update(content).digest('hex');
        if (actualHash !== template.sha256)
          throw new Error(
            `${source.package} integration template ${template.id} failed SHA-256 verification.`,
          );
        files.push({
          package: source.package,
          integration: integration.id,
          id: template.id,
          kind: template.kind,
          ...(template.description ? { description: template.description } : {}),
          source: template.source,
          target: resolvedTarget(template.target, integration.surface, root, integration.id),
          sha256: template.sha256,
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
    packages: manifests.map(({ package: name, packageVersion }) => ({
      name,
      version: packageVersion,
    })),
    requirements,
    files: files.map((file) => ({
      package: file.package,
      integration: file.integration,
      id: file.id,
      kind: file.kind,
      ...(file.description ? { description: file.description } : {}),
      source: file.source,
      target: file.target,
      sha256: file.sha256,
    })),
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
