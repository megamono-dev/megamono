import { ADOPTION_STRUCTURAL_RULES, type MegamonoConfig } from './config';
import type { Diagnostic } from './diagnostics';

/** Count budgets apply only to structural warnings, never to errors. */
export function checkAdoptionRatchets(
  diagnostics: readonly Diagnostic[],
  config: MegamonoConfig,
): Diagnostic[] {
  if (!config.adoption.ratchets.length) return [];
  const budgets = new Map<string, number>(
    config.adoption.ratchets.map((entry) => [entry.rule, entry.initialCount]),
  );
  const rules = new Set<string>([
    ...ADOPTION_STRUCTURAL_RULES,
    ...budgets.keys(),
  ]);
  return [...rules].flatMap((rule) => {
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
