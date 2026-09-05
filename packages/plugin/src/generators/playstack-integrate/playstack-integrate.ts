import {
  formatFiles,
  getProjects,
  logger,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { nestRoutes } from '../../lib/nest-routes';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { format } from 'prettier';

const integrationValidator = new Ajv2020({
  allErrors: true,
  strict: true,
}).compile(
  JSON.parse(
    readFileSync(
      resolve(__dirname, '../../../schemas/playstack-integration.schema.json'),
      'utf8',
    ),
  ),
);

export interface PlaystackIntegrateGeneratorSchema {
  readonly packages: string;
  readonly web?: string;
  readonly api?: string;
  readonly worker?: string;
  readonly portable?: string;
  readonly adapters?: string;
  readonly persistence?: 'package' | 'application';
  readonly adoptionMode?: 'fresh' | 'compare' | 'shadow' | 'cutover';
  readonly decisions?: string;
  readonly conditions?: string;
  readonly dryRun?: boolean;
  readonly yes?: boolean;
}

type Surface = 'portable' | 'web' | 'api' | 'worker';

interface IntegrationTemplate {
  readonly id: string;
  readonly kind:
    'module' | 'provider' | 'policy' | 'controller' | 'health' | 'test';
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

type ConditionState = 'active' | 'inactive' | 'unresolved';

interface ConditionSelection {
  readonly adapters: ReadonlySet<string>;
  readonly adaptersSpecified: boolean;
  readonly persistence?: 'package' | 'application';
  readonly conditions: Readonly<Record<string, boolean>>;
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
  const names = [
    ...new Set(
      value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
  if (
    names.length === 0 ||
    names.some((name) => !/^@playstack\/[a-z0-9][a-z0-9._-]*$/.test(name))
  )
    throw new Error(
      '--packages must contain installed @playstack/<name> packages.',
    );
  return names.sort();
}

function commaValues(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function jsonRecord<T extends string | boolean>(
  value: string | undefined,
  label: string,
  valid: (entry: unknown) => entry is T,
): Record<string, T> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be a JSON object.`);
  }
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== 'object' ||
    Object.entries(parsed).some(
      ([key, entry]) => key.length === 0 || !valid(entry),
    )
  )
    throw new Error(`${label} must be a JSON object with valid values.`);
  return parsed as Record<string, T>;
}

function conditionState(
  when: string | undefined,
  selection: ConditionSelection,
): ConditionState {
  if (!when) return 'active';
  if (when.startsWith('adapter:')) {
    const adapter = when.slice('adapter:'.length);
    return !selection.adaptersSpecified
      ? 'unresolved'
      : selection.adapters.has(adapter)
        ? 'active'
        : 'inactive';
  }
  if (when.startsWith('persistence:')) {
    const persistence = when.slice('persistence:'.length);
    return !selection.persistence
      ? 'unresolved'
      : selection.persistence === persistence
        ? 'active'
        : 'inactive';
  }
  const selected = selection.conditions[when];
  return selected === undefined
    ? 'unresolved'
    : selected
      ? 'active'
      : 'inactive';
}

function filteredRequirements(
  requirements: IntegrationRequirements,
  selection: ConditionSelection,
  unresolved: Set<string>,
): IntegrationRequirements {
  const active = <T extends { readonly when?: string }>(
    entries: readonly T[] | undefined,
  ): T[] | undefined => {
    if (!entries) return undefined;
    return entries.filter((entry) => {
      const state = conditionState(entry.when, selection);
      if (state === 'unresolved' && entry.when) unresolved.add(entry.when);
      return state === 'active';
    });
  };
  return {
    ...(requirements.moduleImports
      ? { moduleImports: requirements.moduleImports }
      : {}),
    ...(requirements.providerTokens
      ? { providerTokens: requirements.providerTokens }
      : {}),
    ...(requirements.databaseArtifacts
      ? { databaseArtifacts: active(requirements.databaseArtifacts) }
      : {}),
    ...(requirements.environment
      ? { environment: active(requirements.environment) }
      : {}),
    ...(requirements.routes ? { routes: requirements.routes } : {}),
    ...(requirements.healthChecks
      ? { healthChecks: active(requirements.healthChecks) }
      : {}),
    ...(requirements.frameworkConfiguration
      ? { frameworkConfiguration: requirements.frameworkConfiguration }
      : {}),
    ...(requirements.requiredTests
      ? { requiredTests: active(requirements.requiredTests) }
      : {}),
    ...(requirements.decisions
      ? { decisions: active(requirements.decisions) }
      : {}),
  };
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
  if (!integrationValidator(value))
    throw new Error(
      `${path} does not satisfy integration schema version 1: ${new Ajv2020().errorsText(integrationValidator.errors)}`,
    );
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
    throw new Error(
      `${packageJsonPath} is required to verify the integration manifest.`,
    );
  let packageVersion: unknown;
  try {
    packageVersion = (JSON.parse(packageJsonSource) as { version?: unknown })
      .version;
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
    throw new Error(
      `Integration target ${target} contains an unsupported placeholder.`,
    );
  const safe = safePath(replaced, 'Integration target');
  return safe.startsWith(`${root}/`)
    ? safe
    : safePath(posix.join(root, safe), 'Integration target');
}

function requirementRecord(
  source: IntegrationManifest,
  integration: IntegrationManifest['integrations'][number],
  requirements: IntegrationRequirements,
) {
  return {
    package: source.package,
    id: integration.id,
    surface: integration.surface,
    framework: integration.framework,
    requirements,
  };
}

type RequirementRecord = ReturnType<typeof requirementRecord>;

function manifestConflicts(
  requirements: readonly RequirementRecord[],
): string[] {
  const conflicts = new Set<string>();
  const routes = new Map<string, string>();
  const framework = new Map<string, string>();
  const environment = new Map<string, boolean>();
  const decisions = new Map<string, string>();
  for (const record of requirements) {
    const owner = `${record.package}:${record.id}`;
    for (const route of record.requirements.routes ?? []) {
      for (const method of route.methods) {
        const key = `${record.surface}:${method.toUpperCase()} ${route.path}`;
        const routeOwner = `${owner}:${route.id}`;
        const previous = routes.get(key);
        if (previous)
          conflicts.add(
            `Route ${key} is declared by ${previous} and ${routeOwner}.`,
          );
        routes.set(key, routeOwner);
      }
    }
    for (const entry of record.requirements.frameworkConfiguration ?? []) {
      const encoded = JSON.stringify(entry.value);
      const previous = framework.get(entry.key);
      if (previous !== undefined && previous !== encoded)
        conflicts.add(
          `Framework configuration ${entry.key} has incompatible requested values.`,
        );
      framework.set(entry.key, encoded);
    }
    for (const entry of record.requirements.environment ?? []) {
      for (const name of [entry.key, ...(entry.suggestedNames ?? [])]) {
        const previous = environment.get(name);
        if (previous !== undefined && previous !== entry.secret)
          conflicts.add(
            `Environment requirement ${name} is declared as both secret and non-secret.`,
          );
        environment.set(name, entry.secret);
      }
    }
    for (const decision of record.requirements.decisions ?? []) {
      const signature = JSON.stringify({
        prompt: decision.prompt,
        required: decision.required,
        options: decision.options ?? [],
      });
      const previous = decisions.get(decision.key);
      if (previous !== undefined && previous !== signature)
        conflicts.add(
          `Decision ${decision.key} has incompatible declarations.`,
        );
      decisions.set(decision.key, signature);
    }
  }
  return [...conflicts].sort();
}

function projectFiles(tree: Tree, root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const child of tree.children(directory)) {
      const path = posix.join(directory, child);
      if (tree.isFile(path)) files.push(path);
      else if (child !== 'node_modules' && child !== 'dist') visit(path);
    }
  };
  visit(root);
  return files.filter((path) => /\.(?:[cm]?[jt]sx?|json)$/.test(path));
}

function existingRequirementReferences(
  tree: Tree,
  roots: Readonly<Partial<Record<Surface, string>>>,
  requirements: readonly RequirementRecord[],
  generatedTargets: ReadonlySet<string>,
) {
  const references: {
    category: 'route' | 'provider' | 'environment' | 'framework';
    key: string;
    files: string[];
  }[] = [];
  for (const [surface, root] of Object.entries(roots) as [Surface, string][]) {
    const files = projectFiles(tree, root).filter(
      (path) => !generatedTargets.has(path),
    );
    const contents = files.map((path) => ({
      path,
      content: tree.read(path, 'utf8') ?? '',
    }));
    const add = (
      category: 'route' | 'provider' | 'environment' | 'framework',
      key: string,
    ) => {
      const matches = contents
        .filter(({ content }) => content.includes(key))
        .map(({ path }) => path)
        .slice(0, 10);
      if (matches.length > 0)
        references.push({ category, key, files: matches });
    };
    for (const record of requirements.filter(
      (entry) => entry.surface === surface,
    )) {
      for (const route of record.requirements.routes ?? [])
        add('route', route.path);
      for (const token of record.requirements.providerTokens ?? [])
        add('provider', token);
      for (const entry of record.requirements.environment ?? [])
        for (const name of entry.suggestedNames ?? [entry.key])
          add('environment', name);
      for (const entry of record.requirements.frameworkConfiguration ?? [])
        add('framework', entry.key);
    }
  }
  return references.sort((left, right) =>
    `${left.category}:${left.key}`.localeCompare(
      `${right.category}:${right.key}`,
    ),
  );
}

export async function playstackIntegrateGenerator(
  tree: Tree,
  options: PlaystackIntegrateGeneratorSchema,
): Promise<GeneratorCallback> {
  const adapters = commaValues(options.adapters);
  const selection: ConditionSelection = {
    adapters: new Set(adapters),
    adaptersSpecified: options.adapters !== undefined,
    ...(options.persistence ? { persistence: options.persistence } : {}),
    conditions: jsonRecord(
      options.conditions,
      '--conditions',
      (entry): entry is boolean => typeof entry === 'boolean',
    ),
  };
  const selectedDecisions = jsonRecord(
    options.decisions,
    '--decisions',
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
  for (const [key, value] of Object.entries(selectedDecisions)) {
    const dedicated = key.endsWith('.persistence')
      ? options.persistence
      : key.endsWith('.adoptionMode')
        ? options.adoptionMode
        : undefined;
    if (dedicated !== undefined && dedicated !== value)
      throw new Error(
        `Decision ${key}=${value} conflicts with the dedicated option ${dedicated}.`,
      );
  }
  const roots: Partial<Record<Surface, string>> = {
    ...(options.portable
      ? { portable: safePath(options.portable, '--portable') }
      : {}),
    ...(options.web ? { web: safePath(options.web, '--web') } : {}),
    ...(options.api ? { api: safePath(options.api, '--api') } : {}),
    ...(options.worker ? { worker: safePath(options.worker, '--worker') } : {}),
  };
  const manifests = packageNames(options.packages).map((name) =>
    manifest(tree, name),
  );
  const projectRoots = new Set(
    [...getProjects(tree).values()].map((project) => project.root),
  );
  for (const [surface, root] of Object.entries(roots)) {
    if (!projectRoots.has(root))
      throw new Error(
        `--${surface}=${root} is not an existing Nx project root.`,
      );
  }
  const files: PlannedFile[] = [];
  const requirements: RequirementRecord[] = [];
  const unresolvedConditions = new Set<string>();
  for (const source of manifests) {
    for (const integration of source.integrations) {
      const integrationState = conditionState(integration.when, selection);
      if (integrationState === 'inactive') continue;
      if (integrationState === 'unresolved') {
        if (integration.when) unresolvedConditions.add(integration.when);
        continue;
      }
      const root = roots[integration.surface];
      if (!root)
        throw new Error(
          `${source.package} integration ${integration.id} requires --${integration.surface}=<Nx project root>.`,
        );
      const activeRequirements = filteredRequirements(
        integration.requirements,
        selection,
        unresolvedConditions,
      );
      requirements.push(
        requirementRecord(source, integration, activeRequirements),
      );
      for (const template of integration.templates ?? []) {
        const templateState = conditionState(template.when, selection);
        if (templateState === 'inactive') continue;
        if (templateState === 'unresolved') {
          if (template.when) unresolvedConditions.add(template.when);
          continue;
        }
        if (
          template.ejectable !== true ||
          !/^[a-f0-9]{64}$/.test(template.sha256)
        )
          throw new Error(
            `${source.package} integration template ${template.id} has invalid ownership or integrity metadata.`,
          );
        const sourcePath = packagePath(
          source.package,
          safePath(template.source, 'Integration source'),
        );
        const content = readPackageFile(tree, sourcePath);
        if (content === null)
          throw new Error(
            `${source.package} integration source ${template.source} is missing.`,
          );
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
          ...(template.description
            ? { description: template.description }
            : {}),
          source: template.source,
          target: resolvedTarget(
            template.target,
            integration.surface,
            root,
            integration.id,
          ),
          sha256: template.sha256,
          content,
        });
      }
    }
  }
  const duplicate = files.find(
    (file, index) =>
      files.findIndex(({ target }) => target === file.target) !== index,
  );
  if (duplicate)
    throw new Error(
      `Multiple integration artifacts target ${duplicate.target}.`,
    );
  for (const file of files) {
    const current = tree.read(file.target, 'utf8');
    let unchanged = current === file.content;
    if (current !== null && !unchanged) {
      try {
        // Compare both sides with one formatter configuration; repository
        // formatting must not turn our own output into a content conflict.
        unchanged =
          (await format(current, { filepath: file.target })) ===
          (await format(file.content, { filepath: file.target }));
      } catch {
        // Unknown syntax/formatters remain fail-closed.
      }
    }
    if (current !== null && !unchanged)
      throw new Error(
        `${file.target} already exists with repository-owned content; integration generation is fail-closed.`,
      );
  }
  const availableDecisions = requirements.flatMap((record) =>
    (record.requirements.decisions ?? []).map((decision) => ({
      ...decision,
      package: record.package,
      integration: record.id,
    })),
  );
  for (const decision of availableDecisions) {
    if (
      selectedDecisions[decision.key] === undefined &&
      decision.key.endsWith('.persistence') &&
      options.persistence
    )
      selectedDecisions[decision.key] = options.persistence;
    if (
      selectedDecisions[decision.key] === undefined &&
      decision.key.endsWith('.adoptionMode') &&
      options.adoptionMode
    )
      selectedDecisions[decision.key] = options.adoptionMode;
    const selected = selectedDecisions[decision.key];
    if (selected && decision.options && !decision.options.includes(selected))
      throw new Error(
        `Decision ${decision.key} must be one of: ${decision.options.join(', ')}.`,
      );
  }
  const unresolvedDecisions = availableDecisions
    .filter(
      (decision) =>
        decision.required && selectedDecisions[decision.key] === undefined,
    )
    .map(({ key, prompt, options: choices, package: name, integration }) => ({
      key,
      prompt,
      ...(choices ? { options: choices } : {}),
      package: name,
      integration,
    }));
  const conflicts = manifestConflicts(requirements);
  for (const record of requirements) {
    if (record.framework !== 'nest' || !record.requirements.routes?.length)
      continue;
    const root = roots[record.surface];
    if (!root) continue;
    for (const file of projectFiles(tree, root)) {
      if (files.some((planned) => planned.target === file)) continue;
      const existing = nestRoutes(tree.read(file, 'utf8') ?? '', file);
      if (existing.unresolved)
        conflicts.push(
          `Dynamic Nest routes in ${file} require explicit review before adding routes.`,
        );
      for (const route of record.requirements.routes) {
        if (
          existing.routes.some(
            (found) =>
              found.path === route.path &&
              route.methods.some(
                (method) =>
                  found.method === 'ALL' ||
                  method.toUpperCase() === 'ALL' ||
                  found.method === method.toUpperCase(),
              ),
          )
        )
          conflicts.push(
            `Existing Nest route ${route.methods.join(',')} ${route.path} in ${file} conflicts with ${record.package}:${record.id}.`,
          );
      }
    }
  }
  const existingReferences = existingRequirementReferences(
    tree,
    roots,
    requirements,
    new Set(files.map(({ target }) => target)),
  );
  const commitBoundaries = requirements.map((record) => ({
    id: `integrate-${record.id}`,
    package: record.package,
    integration: record.id,
    files: files
      .filter(
        (file) =>
          file.package === record.package && file.integration === record.id,
      )
      .map(({ target }) => target),
    verification: (record.requirements.requiredTests ?? []).map(
      ({ id, kind }) => ({ id, kind }),
    ),
  }));
  const plan = {
    schemaVersion: 1,
    packages: manifests.map(({ package: name, packageVersion }) => ({
      name,
      version: packageVersion,
    })),
    selections: {
      adapters,
      ...(options.persistence ? { persistence: options.persistence } : {}),
      ...(options.adoptionMode ? { adoptionMode: options.adoptionMode } : {}),
      conditions: selection.conditions,
      decisions: selectedDecisions,
    },
    unresolvedConditions: [...unresolvedConditions].sort(),
    unresolvedDecisions,
    preflight: { conflicts, existingReferences },
    commitBoundaries,
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
    throw new Error(
      'Integration generation requires --yes after reviewing --dry-run.',
    );
  if (unresolvedConditions.size > 0)
    throw new Error(
      `Integration generation has unresolved conditions: ${[...unresolvedConditions].sort().join(', ')}. Pass --conditions='<json>'.`,
    );
  if (unresolvedDecisions.length > 0)
    throw new Error(
      `Integration generation has unresolved required decisions: ${unresolvedDecisions.map(({ key }) => key).join(', ')}. Pass --decisions='<json>' or the matching dedicated options.`,
    );
  if (conflicts.length > 0)
    throw new Error(
      `Integration generation found incompatible manifest requirements: ${conflicts.join(' ')}`,
    );
  for (const file of files)
    if (!tree.exists(file.target)) tree.write(file.target, file.content);
  tree.write(
    '.megamono/playstack-integration-plan.json',
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  await formatFiles(tree);
  return () => undefined;
}

export default playstackIntegrateGenerator;
