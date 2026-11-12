import {
  adoptedStructuralRules,
  checkAdoptionRatchets,
} from './adoption-ratchets';
import { DEFAULT_MEGAMONO_CONFIG, megamonoConfigSchema } from './config';
import type { Diagnostic } from './diagnostics';

const warning = (code: string): Diagnostic => ({
  severity: 'warning',
  code,
  message: 'fixture',
});

describe('adoption count and identity modes', () => {
  it('activates only explicitly governed v2 rules without adopting unrelated lint', () => {
    const basic = new Set(['megamono-dev-only', 'playstack-direction']);
    expect(adoptedStructuralRules(DEFAULT_MEGAMONO_CONFIG)).toEqual(basic);
    const baseline = megamonoConfigSchema.parse({
      ...DEFAULT_MEGAMONO_CONFIG,
      version: 2,
      adoption: {
        warningBaseline: {
          identityVersion: 1,
          rules: ['module-boundaries'],
          entries: [],
        },
      },
    });
    expect(adoptedStructuralRules(baseline)).toEqual(
      new Set([...basic, 'module-boundaries']),
    );
    const allowance = megamonoConfigSchema.parse({
      ...DEFAULT_MEGAMONO_CONFIG,
      version: 2,
      conventions: {
        ...DEFAULT_MEGAMONO_CONFIG.conventions,
        boundaryAllowances: [],
      },
    });
    expect(adoptedStructuralRules(allowance)).toEqual(
      new Set([...basic, 'module-boundaries']),
    );
    expect(
      adoptedStructuralRules({
        ...baseline,
        adoption: { ...baseline.adoption, modules: ['lint'] },
      }),
    ).toBeUndefined();
  });
  it('preserves opt-out defaults and count ceilings that allow decreases', () => {
    expect(
      checkAdoptionRatchets(
        [warning('module-boundaries')],
        DEFAULT_MEGAMONO_CONFIG,
      ),
    ).toEqual([]);
    const config = megamonoConfigSchema.parse({
      ...DEFAULT_MEGAMONO_CONFIG,
      adoption: {
        ratchets: [
          {
            rule: 'module-boundaries',
            initialCount: 2,
            targetSeverity: 'error',
          },
        ],
      },
    });
    expect(
      checkAdoptionRatchets([warning('module-boundaries')], config),
    ).toEqual([]);
    expect(
      checkAdoptionRatchets(
        Array.from({ length: 3 }, () => warning('module-boundaries')),
        config,
      )[0].code,
    ).toBe('adoption-ratchet-exceeded');
  });

  it('delegates identity rules and retains zero budgets for other structural warning categories', () => {
    const config = megamonoConfigSchema.parse({
      ...DEFAULT_MEGAMONO_CONFIG,
      version: 2,
      adoption: {
        warningBaseline: {
          identityVersion: 1,
          rules: ['module-boundaries'],
          entries: [],
        },
      },
    });
    expect(
      checkAdoptionRatchets([warning('module-boundaries')], config),
    ).toEqual([]);
    expect(
      checkAdoptionRatchets([warning('platform-boundary')], config),
    ).toEqual([
      expect.objectContaining({
        code: 'adoption-ratchet-exceeded',
        message: expect.stringContaining('budget of 0'),
      }),
    ]);
    expect(
      checkAdoptionRatchets(
        [{ ...warning('platform-boundary'), severity: 'error' }],
        config,
      ),
    ).toEqual([]);
  });
});
