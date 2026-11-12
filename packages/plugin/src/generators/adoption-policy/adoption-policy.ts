import {
  createProjectGraphAsync,
  logger,
  type ProjectGraph,
  type Tree,
} from '@nx/devkit';
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  ADOPTION_STRUCTURAL_RULES,
  assertSupportedMegamonoConfigVersion,
  isSafeWorkspaceRelativePath,
  megamonoConfigSchema,
} from '../../lib/config';
import {
  boundaryAllowanceSchema,
  dependencyFindingIdentitySchema,
  dependencyIdentityKey,
  warningBaselineSchema,
} from '../../lib/dependency-policy-contract';
import { acceptedBoundaryDecisions } from '../../lib/boundary-policy';
import { analyzeWorkspaceStructure } from '../../lib/structural-check';
import {
  evaluateIdentityBaseline,
  warningIdentityFingerprint,
} from '../../lib/identity-baseline';
import {
  adoptedStructuralRules,
  checkAdoptionRatchets,
} from '../../lib/adoption-ratchets';
import { hasErrors, type Diagnostic } from '../../lib/diagnostics';
import {
  hasBoundaryAllowanceEslintActivation,
  wrapEslintBoundaryAllowances,
} from '../../lib/eslint-flat-config';
import {
  assertWorkspaceMutationGitPreflight,
  type WorkspaceInitHostState,
} from '../../lib/workspace-init-preflight';
import type { AdoptionPolicyGeneratorSchema } from './schema';

const reviewedPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    boundaryAllowances: z.array(boundaryAllowanceSchema).optional(),
    warningBaseline: warningBaselineSchema.optional(),
    replaceLegacyRatchets: z.boolean().default(false),
  })
  .strict();
const reportKind = 'megamono-adoption-policy-report';
const configPath = 'megamono.json';

interface PolicyGitState extends WorkspaceInitHostState {
  readonly revision?: string;
}
export interface AdoptionPolicyGeneratorDependencies {
  readonly graph?: ProjectGraph;
  readonly gitState?: PolicyGitState;
  readonly revisionIsAncestor?: (revision: string) => boolean;
}

function gitOutput(root: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}
function collectPolicyGitState(root: string): PolicyGitState {
  const available =
    gitOutput(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  return {
    platform: process.platform,
    node: process.version,
    revision: available
      ? gitOutput(root, ['rev-parse', '--verify', 'HEAD'])
      : undefined,
    git: {
      available,
      clean:
        available &&
        gitOutput(root, [
          'status',
          '--porcelain=v1',
          '--untracked-files=all',
        ]) === '',
      branch: gitOutput(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      defaultBranch: gitOutput(root, [
        'symbolic-ref',
        '--quiet',
        '--short',
        'refs/remotes/origin/HEAD',
      ])?.replace(/^origin\//, ''),
    },
  };
}
function safePath(tree: Tree, path: string, label: string): string {
  if (!isSafeWorkspaceRelativePath(path) || !path.endsWith('.json'))
    throw new Error(`${label} must be a safe workspace-relative JSON path.`);
  if (tree.root !== '/virtual') {
    let current = resolve(tree.root);
    const absolute = resolve(tree.root, path);
    const relativePath = relative(current, absolute);
    if (isAbsolute(relativePath) || relativePath.startsWith(`..${sep}`))
      throw new Error(`${label} escapes the workspace.`);
    for (const segment of relativePath.split(sep)) {
      current = join(current, segment);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new Error(
            `${label} must not contain symlinked path components.`,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return path;
}
function readJson(tree: Tree, path: string): unknown {
  const source = tree.read(path, 'utf8');
  if (source === null) throw new Error(`${path} does not exist.`);
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
}
function object(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/** Report-only unless an explicit reviewed file and apply flag are supplied. */
export async function adoptionPolicyGenerator(
  tree: Tree,
  options: AdoptionPolicyGeneratorSchema,
  dependencies: AdoptionPolicyGeneratorDependencies = {},
): Promise<void> {
  const dryRun = options.dryRun === true || process.env.NX_DRY_RUN === 'true';
  if (options.apply && !options.policyFile)
    throw new Error('--apply requires an explicitly reviewed --policyFile.');
  safePath(tree, configPath, 'Configuration');
  const originalSource = tree.read(configPath, 'utf8');
  const raw = readJson(tree, configPath);
  assertSupportedMegamonoConfigVersion(raw, configPath);
  const existing = megamonoConfigSchema.parse(raw);
  const policyPath = options.policyFile
    ? safePath(tree, options.policyFile, 'Policy file')
    : undefined;
  if (policyPath === configPath)
    throw new Error('policyFile must be separate from megamono.json.');
  const policy = policyPath
    ? reviewedPolicySchema.parse(readJson(tree, policyPath))
    : undefined;
  if (
    policy &&
    existing.version === 1 &&
    existing.adoption.ratchets.length &&
    !policy.replaceLegacyRatchets
  )
    throw new Error(
      'Migrating version 1 count ratchets requires explicit replaceLegacyRatchets:true in the reviewed policyFile; counts cannot be converted into identities.',
    );
  const rawObject = object(raw);
  const rawCandidate = policy
    ? {
        ...rawObject,
        version: 2,
        conventions: {
          ...object(rawObject.conventions),
          ...(policy.boundaryAllowances !== undefined
            ? { boundaryAllowances: policy.boundaryAllowances }
            : {}),
        },
        ...(policy.warningBaseline !== undefined || policy.replaceLegacyRatchets
          ? {
              adoption: {
                ...object(rawObject.adoption ?? {}),
                ...(policy.warningBaseline !== undefined
                  ? { warningBaseline: policy.warningBaseline }
                  : {}),
                ...(policy.replaceLegacyRatchets ? { ratchets: [] } : {}),
              },
            }
          : {}),
      }
    : rawObject;
  const candidate = megamonoConfigSchema.parse(rawCandidate);
  const reportPath = options.report
    ? safePath(tree, options.report, 'Report')
    : undefined;
  if (reportPath) {
    if (
      [configPath, policyPath, 'package.json', 'nx.json'].includes(reportPath)
    )
      throw new Error(
        'Report path cannot overwrite a configuration or policy file.',
      );
    if (
      tree.exists(reportPath) &&
      object(readJson(tree, reportPath)).kind !== reportKind
    )
      throw new Error(
        'Refusing to overwrite a report path owned by another file.',
      );
  }
  const graph =
    dependencies.graph ??
    (await createProjectGraphAsync({ exitOnError: false }));
  const git = dependencies.gitState ?? collectPolicyGitState(tree.root);
  let accepted: ReadonlySet<string>;
  try {
    accepted = acceptedBoundaryDecisions(tree.root, candidate.docs.root);
  } catch {
    accepted = new Set();
  }
  const enabled = adoptedStructuralRules(candidate);
  const analysisRules =
    !policy && enabled ? new Set([...enabled, 'module-boundaries']) : enabled;
  const analysis = await analyzeWorkspaceStructure(
    tree.root,
    graph,
    candidate,
    accepted,
    analysisRules,
  );
  const baseline = evaluateIdentityBaseline(analysis.diagnostics, candidate);
  const errors: Diagnostic[] = [
    ...analysis.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error',
    ),
    ...baseline.errors,
    ...checkAdoptionRatchets(analysis.diagnostics, candidate),
  ];
  const structuralRules = new Set<string>(ADOPTION_STRUCTURAL_RULES);
  const baselineRules = new Set<string>(
    candidate.adoption.warningBaseline?.rules ?? [],
  );
  const unsupportedWarnings = analysis.diagnostics.filter(
    (diagnostic) =>
      diagnostic.severity === 'warning' &&
      structuralRules.has(diagnostic.code) &&
      !baselineRules.has(diagnostic.code),
  );
  for (const diagnostic of unsupportedWarnings)
    errors.push({
      severity: 'error',
      code: 'adoption-policy-uncovered-warning',
      path: diagnostic.path,
      message: `${diagnostic.code}: remaining structural warning has no reviewed identity policy. Resolve unsupported debt rather than converting a count allowance.`,
    });
  let eslintSource: string | undefined;
  const hasPolicy =
    candidate.conventions.boundaryAllowances !== undefined ||
    candidate.adoption.warningBaseline !== undefined;
  if (policy && hasPolicy) {
    const current = tree.read('eslint.config.mjs', 'utf8');
    eslintSource =
      current === null ? undefined : wrapEslintBoundaryAllowances(current);
    if (
      eslintSource === undefined ||
      !hasBoundaryAllowanceEslintActivation(eslintSource)
    )
      errors.push({
        severity: 'error',
        code: 'adoption-policy-eslint-unsupported',
        path: 'eslint.config.mjs',
        message:
          'Policy activation requires canonical Megamono imports/createConfig and a direct flat array or canonical boundary wrapper. Review existing lint wiring first.',
      });
    if (
      candidate.conventions.boundaryAllowances?.length &&
      candidate.conventions.rules['module-boundaries']?.severity === 'off'
    )
      errors.push({
        severity: 'error',
        code: 'adoption-policy-rule-inactive',
        path: configPath,
        message:
          'Boundary allowances cannot activate while module-boundaries is disabled.',
      });
  }
  if (policy && candidate.adoption.warningBaseline) {
    const isAncestor =
      dependencies.revisionIsAncestor ??
      ((revision: string) =>
        gitOutput(tree.root, [
          'merge-base',
          '--is-ancestor',
          revision,
          'HEAD',
        ]) !== undefined);
    for (const revision of new Set(
      candidate.adoption.warningBaseline.entries.map((entry) => entry.revision),
    ))
      if (!isAncestor(revision))
        errors.push({
          severity: 'error',
          code: 'adoption-policy-review-revision',
          path: policyPath,
          message: `Reviewed revision ${revision} is not a verifiable ancestor of this workspace HEAD.`,
        });
  }
  const candidates = new Map<string, unknown>();
  for (const diagnostic of analysis.diagnostics) {
    const identity = dependencyFindingIdentitySchema.safeParse(
      diagnostic.identity,
    );
    if (identity.success)
      candidates.set(dependencyIdentityKey(identity.data), {
        identity: identity.data,
        fingerprint: warningIdentityFingerprint(identity.data),
        severity: diagnostic.severity,
        baselineEligible: diagnostic.severity === 'warning',
      });
  }
  const configChanged =
    JSON.stringify(rawObject) !== JSON.stringify(rawCandidate);
  const eslintChanged =
    eslintSource !== undefined &&
    eslintSource !== tree.read('eslint.config.mjs', 'utf8');
  const report = {
    schemaVersion: 1,
    kind: reportKind,
    discoveryOnly: !policy,
    mode: options.apply && !dryRun ? 'apply' : 'report',
    observedRevision: git.revision ?? null,
    workingTreeClean: git.git.clean,
    fromVersion: existing.version,
    toVersion: candidate.version,
    ready: !hasErrors(errors),
    rawFindings: analysis.rawDiagnostics,
    allowed: analysis.allowed,
    baselined: baseline.baselined,
    new: baseline.new,
    resolved: baseline.resolved,
    errors,
    candidateIdentities: [...candidates.values()],
    policyChanges: {
      boundaryAllowances: {
        before: existing.conventions.boundaryAllowances ?? [],
        after: candidate.conventions.boundaryAllowances ?? [],
      },
      warningBaseline: {
        before: existing.adoption.warningBaseline ?? null,
        after: candidate.adoption.warningBaseline ?? null,
      },
      legacyRatchets: {
        before: existing.adoption.ratchets,
        after: candidate.adoption.ratchets,
      },
    },
    plannedFiles: [
      ...(configChanged ? [configPath] : []),
      ...(eslintChanged ? ['eslint.config.mjs'] : []),
    ],
    reviewRequired: true,
  };
  logger.info(JSON.stringify(report, null, 2));
  if (policy && hasErrors(errors))
    throw new Error(
      `Cannot validate adoption policy: ${errors.length} blocking finding(s). Review the report; no files were changed.`,
    );
  if (options.apply && !dryRun) {
    if (hasErrors(errors))
      throw new Error(
        `Cannot apply adoption policy: ${errors.length} blocking finding(s). Review the report; no files were changed.`,
      );
    assertWorkspaceMutationGitPreflight(git, 'Adoption policy migration');
    if (tree.read(configPath, 'utf8') !== originalSource)
      throw new Error(
        'megamono.json changed during policy analysis; no policy was applied.',
      );
    if (configChanged)
      tree.write(configPath, JSON.stringify(rawCandidate, null, 2) + '\n');
    if (eslintChanged && eslintSource !== undefined)
      tree.write('eslint.config.mjs', eslintSource);
  }
  if (reportPath && !dryRun)
    tree.write(reportPath, JSON.stringify(report, null, 2) + '\n');
}
export default adoptionPolicyGenerator;
