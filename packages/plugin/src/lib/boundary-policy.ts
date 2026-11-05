import type { ProjectGraph } from '@nx/devkit';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { megamonoConfigSchema, type MegamonoConfig } from './config';
import type { Diagnostic } from './diagnostics';
import { repositoryDocumentSchema } from './docs';
import { repositoryOwnedGraph } from './repository-graph';
import {
  classifyDependency,
  dependencyIdentityKey,
  type BoundaryAllowance,
  type DependencyFindingIdentity,
} from './dependency-policy-contract';

export const allowedTypeDependencies: Readonly<
  Record<string, readonly string[]>
> = {
  app: ['app', 'feature', 'ui', 'data', 'util'],
  feature: ['ui', 'data', 'util'],
  ui: ['util'],
  data: ['util'],
  util: ['util'],
};
const tagValue = (tags: readonly string[], family: string) =>
  tags.find((tag) => tag.startsWith(family + ':'))?.slice(family.length + 1);

/** The only dependency constraints which reviewed allowances can relax. */
export function boundaryConstraints(
  source: readonly string[],
  target: readonly string[],
): DependencyFindingIdentity['constraint'][] {
  const constraints: DependencyFindingIdentity['constraint'][] = [];
  const sourceScope = tagValue(source, 'scope');
  const targetScope = tagValue(target, 'scope');
  if (
    sourceScope &&
    targetScope &&
    sourceScope !== targetScope &&
    !(sourceScope !== 'shared' && targetScope === 'shared')
  )
    constraints.push('module-boundaries:scope-direction');
  const sourceType = tagValue(source, 'type');
  const targetType = tagValue(target, 'type');
  if (
    sourceType &&
    targetType &&
    !allowedTypeDependencies[sourceType]?.includes(targetType)
  )
    constraints.push('module-boundaries:type-direction');
  return constraints;
}

export function allowanceIdentity(
  allowance: BoundaryAllowance,
): DependencyFindingIdentity {
  return {
    rule: 'module-boundaries',
    constraint: allowance.constraint,
    source: allowance.source,
    target: allowance.target,
    classification: allowance.classification,
  };
}

export function matchingBoundaryAllowance(
  identity: DependencyFindingIdentity,
  allowances: readonly BoundaryAllowance[],
): BoundaryAllowance | undefined {
  const key = dependencyIdentityKey(identity);
  return allowances.find(
    (allowance) => dependencyIdentityKey(allowanceIdentity(allowance)) === key,
  );
}

/** Decision authority is read independently of optional documentation checking. */
function readAcceptedBoundaryDecisions(
  workspaceRoot: string,
  docsRoot: string,
): ReadonlySet<string> {
  const records: {
    id: string;
    accepted: boolean;
    supersedes?: string | null;
  }[] = [];
  const segments = docsRoot.replaceAll('\\', '/').split('/');
  if (
    segments.some((segment) =>
      ['..', 'node_modules', '.pnpm', '.yarn', '.yalc', '.git', '.nx'].includes(
        segment.toLowerCase(),
      ),
    ) ||
    resolve(docsRoot) === docsRoot
  )
    return new Set();
  let directory = realpathSync(workspaceRoot);
  for (const segment of segments) {
    directory = join(directory, segment);
    if (!existsSync(directory)) return new Set();
    if (
      lstatSync(directory).isSymbolicLink() ||
      !lstatSync(directory).isDirectory()
    )
      return new Set();
  }
  const walk = (directory: string, archived: boolean) => {
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, archived);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const source = readFileSync(path, 'utf8');
          const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
            source,
          );
          if (!frontmatter) continue;
          const yaml = parseDocument(frontmatter[1], { uniqueKeys: true });
          if (yaml.errors.length || yaml.warnings.length) continue;
          const data = yaml.toJS() as Record<string, unknown>;
          if (!data || typeof data !== 'object' || Array.isArray(data))
            continue;
          if (typeof data.id !== 'string') continue;
          const parsed = repositoryDocumentSchema.safeParse(data);
          records.push({
            id: data.id,
            accepted:
              parsed.success &&
              parsed.data.type === 'decision' &&
              parsed.data.status === 'accepted' &&
              !archived,
            ...(parsed.success && parsed.data.type === 'decision'
              ? { supersedes: parsed.data.supersedes }
              : {}),
          });
        } catch {
          /* An unreadable or malformed record cannot authorize an allowance. */
        }
      }
    }
  };
  walk(join(directory, 'decisions'), false);
  const archives = join(directory, 'archives');
  if (existsSync(archives) && !lstatSync(archives).isSymbolicLink())
    walk(join(archives, 'decisions'), true);
  const superseded = new Set(
    records.flatMap((record) => (record.supersedes ? [record.supersedes] : [])),
  );
  return new Set(
    records
      .filter(
        (record) =>
          record.accepted &&
          !superseded.has(record.id) &&
          records.filter((other) => other.id === record.id).length === 1,
      )
      .map((record) => record.id),
  );
}

export function acceptedBoundaryDecisions(
  workspaceRoot: string,
  docsRoot: string,
): ReadonlySet<string> {
  try {
    return readAcceptedBoundaryDecisions(workspaceRoot, docsRoot);
  } catch {
    return new Set();
  }
}

export interface BoundaryPolicyResult {
  readonly valid: readonly BoundaryAllowance[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Validate exact graph facts and decision authority; never infer or expand policy. */
export function validateBoundaryAllowances(
  workspaceRoot: string,
  graph: ProjectGraph,
  config: MegamonoConfig,
): BoundaryPolicyResult {
  graph = repositoryOwnedGraph(graph);
  const supplied = config?.conventions?.boundaryAllowances;
  if (supplied === undefined) return { valid: [], diagnostics: [] };
  const parsed = megamonoConfigSchema.safeParse(config);
  if (!parsed.success || parsed.data.version !== 2)
    return {
      valid: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'boundary-allowance-invalid',
          path: 'megamono.json',
          message:
            'Boundary allowances require a valid version 2 configuration with unique, exact reviewed entries. No allowance was applied.',
        },
      ],
    };
  config = parsed.data;
  const allowances = config.conventions.boundaryAllowances ?? [];
  if (!allowances.length) return { valid: [], diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  const valid: BoundaryAllowance[] = [];
  let accepted: ReadonlySet<string>;
  try {
    accepted = acceptedBoundaryDecisions(workspaceRoot, config.docs.root);
  } catch {
    accepted = new Set();
  }
  for (const allowance of allowances) {
    const source = graph.nodes[allowance.source];
    const target = graph.nodes[allowance.target];
    let reason: string | undefined;
    if (!source || !target) reason = 'a selected project no longer exists';
    else if (
      !(graph.dependencies[allowance.source] ?? []).some(
        (edge) =>
          edge.target === allowance.target &&
          edge.type === allowance.classification.dependencyKind,
      )
    )
      reason = 'the selected dependency kind/edge no longer exists';
    else {
      const classification = classifyDependency(
        source,
        target,
        allowance.classification.dependencyKind,
      );
      if (
        !classification ||
        dependencyIdentityKey({
          ...allowanceIdentity(allowance),
          classification,
        }) !== dependencyIdentityKey(allowanceIdentity(allowance))
      )
        reason =
          'project kind or type/scope/platform/role classification changed';
      else if (
        !boundaryConstraints(
          source.data.tags ?? [],
          target.data.tags ?? [],
        ).includes(allowance.constraint)
      )
        reason = 'the selected constraint is no longer violated';
      else if (!accepted.has(allowance.decision))
        reason = `decision ${allowance.decision} is missing, malformed, inactive, duplicated, archived, or superseded`;
    }
    if (reason)
      diagnostics.push({
        severity: 'error',
        code: 'boundary-allowance-invalid',
        path: 'megamono.json',
        message: `${allowance.source} → ${allowance.target} (${allowance.constraint}): ${reason}. Review or remove this exact allowance; it cannot authorize a different edge.`,
      });
    else valid.push(allowance);
  }
  return { valid: diagnostics.length ? [] : valid, diagnostics };
}
