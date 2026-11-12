import { ADOPTION_STRUCTURAL_RULES, type MegamonoConfig } from './config';
import type { Diagnostic } from './diagnostics';

/** Explicit v2 policy assesses its governed rules without adopting all lint. */
export function adoptedStructuralRules(
  config: MegamonoConfig,
): ReadonlySet<string> | undefined {
  if (config.adoption.modules.includes('lint')) return undefined;
  return new Set([
    'megamono-dev-only',
    'playstack-direction',
    ...(config.adoption.warningBaseline?.rules ?? []),
    ...(config.conventions.boundaryAllowances !== undefined
      ? ['module-boundaries']
      : []),
  ]);
}

/** Count budgets apply only to structural warnings, never to errors. */
export function checkAdoptionRatchets(
  diagnostics: readonly Diagnostic[],
  config: MegamonoConfig,
): Diagnostic[] {
  const identityRules = new Set<string>(
    config.adoption.warningBaseline?.rules ?? [],
  );
  if (!config.adoption.ratchets.length && !identityRules.size) return [];
  const budgets = new Map<string, number>(
    config.adoption.ratchets.map((entry) => [entry.rule, entry.initialCount]),
  );
  const rules = new Set<string>([
    ...ADOPTION_STRUCTURAL_RULES,
    ...budgets.keys(),
  ]);
  return [...rules].flatMap((rule) => {
    // Identity-mode rules are evaluated as exact reviewed finding sets. They
    // cannot also receive a count ceiling (configuration rejects overlap).
    if (identityRules.has(rule)) return [];
    const count = diagnostics.filter(
      (entry) => entry.code === rule && entry.severity === 'warning',
    ).length;
    const budget = budgets.get(rule) ?? 0;
    return count > budget
      ? [
          {
            severity: 'error' as const,
            code: 'adoption-ratchet-exceeded',
            path: 'megamono.json',
            message: `${rule}: ${count} warning(s) exceeds the adoption budget of ${budget}. Fix new debt; lower initialCount explicitly as existing debt is resolved.`,
          },
        ]
      : [];
  });
}
