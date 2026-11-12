import { createHash } from 'node:crypto';
import type { MegamonoConfig } from './config';
import {
  dependencyFindingIdentitySchema,
  dependencyIdentityKey,
} from './dependency-policy-contract';
import type { Diagnostic } from './diagnostics';

export type WarningBaselineEntry = NonNullable<
  MegamonoConfig['adoption']['warningBaseline']
>['entries'][number];
export type WarningIdentity = WarningBaselineEntry['identity'];

export interface IdentityBaselineResult {
  readonly baselined: readonly {
    readonly diagnostic: Diagnostic;
    readonly entry: WarningBaselineEntry;
  }[];
  readonly new: readonly {
    readonly diagnostic: Diagnostic;
    readonly identity?: WarningIdentity;
    readonly reason:
      'unreviewed' | 'unsupported-identity' | 'duplicate-identity';
  }[];
  readonly resolved: readonly WarningBaselineEntry[];
  /** Policy errors only. Original error findings remain in the caller's list. */
  readonly errors: readonly Diagnostic[];
}

/** Messages and object property order are deliberately outside the identity. */
export const warningIdentityKey = dependencyIdentityKey;

export function warningIdentityFingerprint(identity: WarningIdentity): string {
  return createHash('sha256')
    .update(warningIdentityKey(identity))
    .digest('hex');
}

export function warningIdentityEvidence(identity: WarningIdentity): string[] {
  return [
    `constraint: ${identity.constraint}`,
    `dependency kind: ${identity.classification.dependencyKind}`,
    `source: ${identity.source} (${identity.classification.source.kind}; ${identity.classification.source.tags.join(', ')})`,
    `target: ${identity.target} (${identity.classification.target.kind}; ${identity.classification.target.tags.join(', ')})`,
  ];
}

/** Compare warnings with a reviewed set. Never generate, expand, or prune it. */
export function evaluateIdentityBaseline(
  diagnostics: readonly Diagnostic[],
  config: MegamonoConfig,
): IdentityBaselineResult {
  const baseline = config.adoption.warningBaseline;
  if (!baseline) return { baselined: [], new: [], resolved: [], errors: [] };
  const rules = new Set<string>(baseline.rules);
  const expected = new Map(
    baseline.entries.map((entry) => [
      warningIdentityKey(entry.identity),
      entry,
    ]),
  );
  const active = new Map<
    string,
    { diagnostic: Diagnostic; identity: WarningIdentity }[]
  >();
  const newFindings: IdentityBaselineResult['new'][number][] = [];
  const errors: Diagnostic[] = [];
  const policyError = (code: string, message: string) => {
    errors.push({ severity: 'error', code, path: 'megamono.json', message });
  };
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== 'warning' || !rules.has(diagnostic.code))
      continue;
    const parsed = dependencyFindingIdentitySchema.safeParse(
      diagnostic.identity,
    );
    if (!parsed.success || parsed.data.rule !== diagnostic.code) {
      newFindings.push({ diagnostic, reason: 'unsupported-identity' });
      policyError(
        'adoption-baseline-unsupported',
        `${diagnostic.code}: warning has no supported, complete identity metadata. Review the finding; it cannot consume an identity baseline entry.`,
      );
      continue;
    }
    const identity = parsed.data;
    const key = warningIdentityKey(identity);
    const findings = active.get(key) ?? [];
    findings.push({ diagnostic, identity });
    active.set(key, findings);
  }
  const baselined: IdentityBaselineResult['baselined'][number][] = [];
  const matched = new Set<string>();
  for (const [key, findings] of active) {
    if (findings.length !== 1) {
      for (const finding of findings)
        newFindings.push({ ...finding, reason: 'duplicate-identity' });
      policyError(
        'adoption-baseline-duplicate',
        `${findings[0].identity.source} → ${findings[0].identity.target}: multiple warnings share one identity. Resolve the ambiguity before baselining.`,
      );
      continue;
    }
    const entry = expected.get(key);
    if (entry) {
      baselined.push({ diagnostic: findings[0].diagnostic, entry });
      matched.add(key);
    } else {
      newFindings.push({ ...findings[0], reason: 'unreviewed' });
      policyError(
        'adoption-baseline-new',
        `${findings[0].identity.source} → ${findings[0].identity.target}: new ${findings[0].identity.constraint} warning is outside the reviewed identity baseline. Fix it or explicitly review a policy change.`,
      );
    }
  }
  const resolved = baseline.entries.filter(
    (entry) => !matched.has(warningIdentityKey(entry.identity)),
  );
  for (const entry of resolved) {
    policyError(
      'adoption-baseline-resolved',
      `${entry.identity.source} → ${entry.identity.target}: reviewed ${entry.identity.constraint} warning is no longer active. Explicitly review and remove its baseline entry (${entry.reviewReference}, ${entry.revision}); resolved debt cannot hide a replacement warning.`,
    );
  }
  return { baselined, new: newFindings, resolved, errors };
}
