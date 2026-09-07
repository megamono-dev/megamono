import {
  formatFiles,
  getProjects,
  logger,
  updateProjectConfiguration,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { nestRoutes } from '../../lib/nest-routes';
import {
  COMPOSITION_STATE,
  planIntegrationComposition,
} from '../../lib/integration-composition';
import { planIntegrationVerification } from '../../lib/integration-verification';
import { collectIntegrationProvenance } from '../../lib/integration-provenance';
import { selectMigrationContracts } from '../../lib/integration-migration-contracts';
import {
  INTEGRATION_MIGRATIONS_PATH,
  integrationFingerprint,
  planIntegrationMigrations,
  qualificationRequirementsSchema,
} from '../../lib/integration-migrations';
import {
  validateIntegrationEquivalences,
  type IntegrationEquivalence,
} from '../../lib/integration-equivalences';
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
  readonly equivalences?: string;
  readonly verification?: string;
  readonly verificationProject?: string;
  readonly ciWorkflow?: string;
  readonly ciJob?: string;
  readonly migrationStages?: string;
  readonly composition?: string;
  readonly qualification?: string;
  readonly migrationContracts?: string;
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
  readonly reused?: boolean;
}

type ConditionState = 'active' | 'inactive' | 'unresolved';

interface ConditionSelection {
  readonly decisions: Readonly<Record<string, string>>;
  readonly declaredDecisions: ReadonlySet<string>;
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
  if (when.startsWith('decision:')) {
    const match = /^decision:([^=\s]+)=(\S.*)$/.exec(when);
    if (!match || !selection.declaredDecisions.has(match[1]))
      throw new Error(
        `Condition ${when} must reference a package-declared decision using decision:<key>=<value>.`,
      );
    const value = selection.decisions[match[1]];
    return value === undefined
      ? 'unresolved'
      : value === match[2]
        ? 'active'
        : 'inactive';
  }
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
  const selectedDecisions = jsonRecord(
    options.decisions,
    '--decisions',
    (entry): entry is string =>
      typeof entry === 'string' &&
      entry.trim().length > 0 &&
      entry === entry.trim(),
  );
  const declaredDecisions = new Set<string>();
  const selection: ConditionSelection = {
    decisions: selectedDecisions,
    declaredDecisions,
    adapters: new Set(adapters),
    adaptersSpecified: options.adapters !== undefined,
    ...(options.persistence ? { persistence: options.persistence } : {}),
    conditions: jsonRecord(
      options.conditions,
      '--conditions',
      (entry): entry is boolean => typeof entry === 'boolean',
    ),
  };
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
  const missingManifests: string[] = [];
  const manifests = packageNames(options.packages).map((name) => {
    if (
      !readPackageFile(tree, packagePath(name, 'playstack.integration.json')) &&
      options.dryRun
    ) {
      const installed = JSON.parse(
        readPackageFile(tree, packagePath(name, 'package.json')) ?? '{}',
      );
      if (installed.name !== name || typeof installed.version !== 'string')
        throw new Error(
          `${name} is not installed with a valid package manifest.`,
        );
      missingManifests.push(name);
      return {
        version: 1 as const,
        package: name,
        packageVersion: installed.version,
        integrations: [],
      };
    }
    return manifest(tree, name);
  });
  for (const source of manifests)
    for (const integration of source.integrations)
      for (const decision of integration.requirements.decisions ?? []) {
        declaredDecisions.add(decision.key);
        if (selectedDecisions[decision.key] === undefined) {
          const dedicated = decision.key.endsWith('.persistence')
            ? options.persistence
            : decision.key.endsWith('.adoptionMode')
              ? options.adoptionMode
              : undefined;
          if (dedicated !== undefined)
            selectedDecisions[decision.key] = dedicated;
        }
        const selected = selectedDecisions[decision.key];
        if (
          selected !== undefined &&
          decision.options &&
          !decision.options.includes(selected)
        )
          throw new Error(
            `Decision ${decision.key} must be one of: ${decision.options.join(', ')}.`,
          );
      }
  for (const key of Object.keys(selectedDecisions))
    if (!declaredDecisions.has(key))
      throw new Error(
        `Decision ${key} is not declared by the selected packages; a supplied choice cannot add unsupported package behavior.`,
      );
  const artifactProvenance = Object.fromEntries(
    manifests.map((source) => [
      source.package,
      collectIntegrationProvenance(tree, [source.package]),
    ]),
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
  const compositionProject = options.composition
    ? getProjects(tree).get(JSON.parse(options.composition).project)
    : undefined;
  if (options.composition && !compositionProject)
    throw new Error('Composition requires an existing Nx library project.');
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
            integration.framework === 'nest' && compositionProject
              ? compositionProject.root
              : root,
            integration.id,
          ),
          sha256: template.sha256,
          content,
        });
      }
    }
  }
  const equivalenceKinds = new Map<string, IntegrationEquivalence['kind']>();
  for (const record of requirements) {
    for (const entry of record.requirements.environment ?? [])
      equivalenceKinds.set(entry.key, 'environment');
    for (const entry of record.requirements.moduleImports ?? [])
      equivalenceKinds.set(entry.export, 'module');
    for (const token of record.requirements.providerTokens ?? [])
      equivalenceKinds.set(token, 'provider');
  }
  for (const file of files)
    equivalenceKinds.set(
      `${file.package}:${file.integration}:${file.id}`,
      'template',
    );
  const equivalences = validateIntegrationEquivalences(
    tree,
    jsonRecord(
      options.equivalences,
      '--equivalences',
      (value): value is string => typeof value === 'string',
    ),
    equivalenceKinds,
  );
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const mapping = equivalences.find(
      ({ key }) => key === `${file.package}:${file.integration}:${file.id}`,
    );
    if (!mapping?.file) continue;
    const content = tree.read(mapping.file, 'utf8');
    if (content === null)
      throw new Error(`Reused integration file disappeared: ${mapping.file}.`);
    if (file.kind === 'controller') {
      const declared = nestRoutes(content, mapping.file);
      const expected =
        requirements.find(
          (record) =>
            record.package === file.package && record.id === file.integration,
        )?.requirements.routes ?? [];
      if (
        declared.unresolved ||
        expected.some((route) =>
          route.methods.some(
            (method) =>
              !declared.routes.some(
                (found) =>
                  found.path === route.path &&
                  (found.method === method.toUpperCase() ||
                    found.method === 'ALL'),
              ),
          ),
        )
      )
        throw new Error(
          `Reused controller ${mapping.file} does not statically cover the declared integration routes.`,
        );
    }
    files[index] = { ...file, target: mapping.file, content, reused: true };
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
  const conflicts = [
    ...manifestConflicts(requirements),
    ...missingManifests.map(
      (name) =>
        `${name} has no integration manifest; installation does not supply generated application wiring.`,
    ),
  ];
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
  const migrationContracts = selectMigrationContracts(
    requirements.map((record) => `${record.package}:${record.id}`),
    options.migrationContracts,
  );
  for (const [index, record] of requirements.entries()) {
    const extra =
      migrationContracts[`${record.package}:${record.id}`]?.tests ?? [];
    if (!extra.length) continue;
    const prior = record.requirements.requiredTests ?? [];
    if (extra.some((test) => prior.some(({ id }) => id === test.id)))
      throw new Error(
        'Application migration contract IDs overlap package-authored tests.',
      );
    requirements[index] = {
      ...record,
      requirements: {
        ...record.requirements,
        requiredTests: [
          ...prior,
          ...extra.map(({ id, kind }) => ({ id, kind })),
        ],
      },
    };
  }
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
  const composition = planIntegrationComposition(
    tree,
    getProjects(tree),
    files,
    options.composition,
  );
  if (
    composition?.writes.some((write) =>
      files.some((file) => file.target === write.target),
    )
  )
    throw new Error(
      'Composition output overlaps a package-authored template; choose a separate composition library layout.',
    );
  const verification = planIntegrationVerification(
    tree,
    getProjects(tree),
    requirements.flatMap((record) =>
      (record.requirements.requiredTests ?? []).map(
        ({ id }) => `${record.package}:${record.id}:${id}`,
      ),
    ),
    options,
  );
  const qualification = qualificationRequirementsSchema.parse(
    JSON.parse(options.qualification ?? '{}'),
  );
  for (const [key, contract] of Object.entries(migrationContracts))
    for (const test of contract.tests) {
      const testKey = `${key}:${test.id}`;
      // Caller qualification can strengthen, never remove, the profile minimum.
      qualification[testKey] = [
        ...new Set([...test.environments, ...(qualification[testKey] ?? [])]),
      ];
    }
  const testKeys = new Set(
    requirements.flatMap((record) =>
      (record.requirements.requiredTests ?? []).map(
        ({ id }) => `${record.package}:${record.id}:${id}`,
      ),
    ),
  );
  for (const key of Object.keys(qualification))
    if (!testKeys.has(key))
      throw new Error(
        `Qualification ${key} is not an active package integration test.`,
      );
  const migrations = planIntegrationMigrations(
    tree,
    requirements.map((record) => {
      const source = manifests.find(
        (manifest) => manifest.package === record.package,
      );
      if (!source)
        throw new Error(
          `Missing selected integration manifest ${record.package}.`,
        );
      const decisionKeys = (record.requirements.decisions ?? [])
        .map(({ key }) => key)
        .filter((key) => !key.endsWith('.adoptionMode'));
      const equivalenceKeys = new Set([
        ...(record.requirements.environment ?? []).map(({ key }) => key),
        ...(record.requirements.moduleImports ?? []).map(
          ({ export: name }) => name,
        ),
        ...(record.requirements.providerTokens ?? []),
        ...files
          .filter(
            (file) =>
              file.package === record.package && file.integration === record.id,
          )
          .map((file) => `${file.package}:${file.integration}:${file.id}`),
      ]);
      return {
        key: `${record.package}:${record.id}`,
        version: source.packageVersion,
        requireEvidence: Boolean(
          migrationContracts[`${record.package}:${record.id}`],
        ),
        fingerprint: integrationFingerprint({
          manifest: source.integrations.find(({ id }) => id === record.id),
          version: source.packageVersion,
          artifacts: artifactProvenance[source.package].fingerprint,
          qualification: Object.fromEntries(
            Object.entries(qualification).filter(([key]) =>
              key.startsWith(`${record.package}:${record.id}:`),
            ),
          ),
          root: roots[record.surface],
          requirements: record.requirements,
          persistence: options.persistence,
          ...(composition && record.framework === 'nest'
            ? { composition: composition.selection }
            : {}),
          decisions: Object.fromEntries(
            decisionKeys.map((key) => [key, selectedDecisions[key]]),
          ),
          equivalences: equivalences.filter(({ key }) =>
            equivalenceKeys.has(key),
          ),
          verification: Object.fromEntries(
            Object.entries(verification?.mappings ?? {}).filter(([key]) =>
              key.startsWith(`${record.package}:${record.id}:`),
            ),
          ),
          files: files
            .filter(
              (file) =>
                file.package === record.package &&
                file.integration === record.id,
            )
            .map((file) => ({
              target: file.target,
              sha256: createHash('sha256').update(file.content).digest('hex'),
            })),
        }),
        requiredTests: (record.requirements.requiredTests ?? []).map(
          ({ id }) => id,
        ),
        requiredEnvironments: Object.fromEntries(
          (record.requirements.requiredTests ?? []).flatMap(({ id }) => {
            const environments =
              qualification[`${record.package}:${record.id}:${id}`];
            return environments ? [[id, environments]] : [];
          }),
        ),
        requiredTestKinds: Object.fromEntries(
          (record.requirements.requiredTests ?? []).map(({ id, kind }) => [
            id,
            kind,
          ]),
        ),
      };
    }),
    options.migrationStages,
  );
  for (const key of Object.keys(migrationContracts)) {
    const record = requirements.find(
      (entry) => `${entry.package}:${entry.id}` === key,
    );
    if (!record)
      throw new Error(`Missing active migration integration ${key}.`);
    const requestedModes = [
      options.adoptionMode,
      ...(record.requirements.decisions ?? [])
        .filter(({ key }) => key.endsWith('.adoptionMode'))
        .map(({ key }) => selectedDecisions[key]),
    ];
    for (const mode of new Set(requestedModes))
      if (
        (mode === 'shadow' || mode === 'cutover') &&
        migrations.integrations[key].stage !== mode
      )
        conflicts.push(
          `${key} requests ${mode} generation but its qualified migration stage is ${migrations.integrations[key].stage}; supply the matching reviewed migration transition and evidence first.`,
        );
  }
  const plan = {
    schemaVersion: 1,
    readiness: {
      scope: 'application-wiring',
      installation: 'installed-artifacts-inspected',
      // This generator never runs application tests. A reviewed ledger is a
      // separate attestation, not a runtime qualification result.
      verification: 'not-run',
      packages: manifests.map((source) => ({
        package: source.package,
        manifest: missingManifests.includes(source.package)
          ? 'missing'
          : 'available',
        integrations: requirements
          .filter((record) => record.package === source.package)
          .map((record) => {
            const selected = files.filter(
              (file) =>
                file.package === record.package &&
                file.integration === record.id,
            );
            const key = `${record.package}:${record.id}`;
            return {
              id: record.id,
              templates: selected.length ? 'available' : 'none-selected',
              wiring: !selected.length
                ? 'application-owned'
                : options.dryRun
                  ? selected.every((file) => tree.exists(file.target))
                    ? 'present'
                    : 'planned'
                  : 'generated-or-reused',
              requiredTests: (record.requirements.requiredTests ?? []).map(
                ({ id }) => ({
                  id,
                  target: verification?.mappings[`${key}:${id}`] ?? null,
                  status: 'not-run',
                }),
              ),
              recordedMigrationStage: migrations.integrations[key].stage,
            };
          }),
      })),
      limitations: [
        'Package installation and template generation do not qualify an application integration.',
        'Test targets and migration attestations require separately reviewed application evidence.',
        ...(missingManifests.length
          ? [
              'Packages without manifests require documented application-owned wiring.',
            ]
          : []),
        ...(requirements.some(
          (record) =>
            !files.some(
              (file) =>
                file.package === record.package &&
                file.integration === record.id,
            ),
        )
          ? [
              'Some selected integrations have no active templates; requirements still need application-owned implementation.',
            ]
          : []),
      ],
    },
    packages: manifests.map(({ package: name, packageVersion }) => ({
      name,
      version: packageVersion,
    })),
    artifactProvenance,
    migrationContracts,
    qualification,
    selections: {
      adapters,
      equivalences,
      ...(options.persistence ? { persistence: options.persistence } : {}),
      ...(options.adoptionMode ? { adoptionMode: options.adoptionMode } : {}),
      conditions: selection.conditions,
      decisions: selectedDecisions,
    },
    unresolvedConditions: [...unresolvedConditions].sort(),
    unresolvedDecisions,
    preflight: { conflicts, existingReferences },
    commitBoundaries,
    ...(verification ? { verification } : {}),
    migrations,
    ...(composition
      ? {
          composition: {
            project: composition.project,
            target: composition.target,
            modules: composition.modules,
            files: composition.writes.map((file) => ({
              target: file.target,
              sha256: integrationFingerprint(file.content),
            })),
          },
        }
      : {}),
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
      ...(file.reused
        ? {
            reused: true,
            contentSha256: createHash('sha256')
              .update(file.content)
              .digest('hex'),
          }
        : {}),
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
  const artifactErrors = Object.values(artifactProvenance)
    .flatMap((snapshot) => snapshot.findings)
    .filter((finding) => finding.severity === 'error');
  if (artifactErrors.length)
    throw new Error(
      `Installed artifact preflight failed: ${artifactErrors.map((finding) => finding.message).join(' ')}`,
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
  if (composition)
    for (const file of composition.writes)
      tree.write(file.target, file.content);
  if (verification) {
    const project = getProjects(tree).get(verification.project);
    if (!project)
      throw new Error(
        `Verification project disappeared: ${verification.project}.`,
      );
    updateProjectConfiguration(tree, verification.project, {
      ...project,
      targets: {
        ...project.targets,
        [verification.target]: verification.configuration,
      },
    });
    if (verification.workflow)
      tree.write(verification.workflow.path, verification.workflow.content);
  }
  tree.write(
    '.megamono/playstack-integration-plan.json',
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  tree.write(
    INTEGRATION_MIGRATIONS_PATH,
    `${JSON.stringify(migrations, null, 2)}\n`,
  );
  await formatFiles(tree);
  if (composition) {
    composition.state.files[composition.target] = integrationFingerprint(
      tree.read(composition.target, 'utf8'),
    );
    tree.write(
      COMPOSITION_STATE,
      `${JSON.stringify(composition.state, null, 2)}\n`,
    );
  }
  return () => undefined;
}

export default playstackIntegrateGenerator;
