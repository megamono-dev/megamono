import { DEFAULT_MEGAMONO_CONFIG, megamonoConfigSchema } from './config';
import type { Diagnostic } from './diagnostics';
import {
  evaluateIdentityBaseline,
  warningIdentityKey,
  type WarningIdentity,
} from './identity-baseline';

function identity(): WarningIdentity {
  return {
    rule: 'module-boundaries',
    constraint: 'module-boundaries:type-direction',
    source: 'consumer',
    target: 'provider',
    classification: {
      dependencyKind: 'static',
      source: { kind: 'lib', tags: ['scope:shared', 'type:util'] },
      target: { kind: 'lib', tags: ['scope:shared', 'type:feature'] },
    },
  };
}

function config() {
  return megamonoConfigSchema.parse({
    ...DEFAULT_MEGAMONO_CONFIG,
    version: 2,
    adoption: {
      modules: ['lint'],
      warningBaseline: {
        identityVersion: 1,
        rules: ['module-boundaries'],
        entries: [
          {
            identity: identity(),
            reason: 'Reviewed migration debt',
            reviewReference: 'review-123',
            revision: 'a'.repeat(40),
          },
        ],
      },
    },
  });
}

function warning(value: WarningIdentity = identity()): Diagnostic {
  return {
    severity: 'warning',
    code: 'module-boundaries',
    path: value.source,
    message: 'A rendered explanation.',
    identity: value,
  };
}

describe('reviewed warning identity baselines', () => {
  it('accepts only the exact reviewed warning, retaining review evidence without mutation', () => {
    const policy = config();
    const before = JSON.stringify(policy);
    const diagnostic = warning();
    const result = evaluateIdentityBaseline([diagnostic], policy);
    expect(result.errors).toEqual([]);
    expect(result.new).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.baselined).toEqual([
      { diagnostic, entry: policy.adoption.warningBaseline?.entries[0] },
    ]);
    expect(diagnostic.severity).toBe('warning');
    expect(JSON.stringify(policy)).toBe(before);
  });

  it.each([
    'source',
    'target',
    'constraint',
    'dependency-kind',
    'classification-kind',
    'classification-tags',
  ] as const)(
    'rejects replacement debt at the same count when %s changes',
    (change) => {
      const next = identity();
      if (change === 'source') next.source = 'another-consumer';
      if (change === 'target') next.target = 'another-provider';
      if (change === 'constraint')
        next.constraint = 'module-boundaries:scope-direction';
      if (change === 'dependency-kind')
        next.classification.dependencyKind = 'dynamic';
      if (change === 'classification-kind')
        next.classification.source.kind = 'app';
      if (change === 'classification-tags')
        next.classification.source.tags = ['scope:billing', 'type:util'];
      const result = evaluateIdentityBaseline([warning(next)], config());
      expect(result.baselined).toEqual([]);
      expect(result.new).toHaveLength(1);
      expect(result.resolved).toHaveLength(1);
      expect(result.errors.map(({ code }) => code)).toEqual([
        'adoption-baseline-new',
        'adoption-baseline-resolved',
      ]);
    },
  );

  it('requires reviewed pruning even when the warning count decreases to zero', () => {
    const policy = config();
    const before = JSON.stringify(policy);
    const result = evaluateIdentityBaseline([], policy);
    expect(result.resolved).toEqual(policy.adoption.warningBaseline?.entries);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'adoption-baseline-resolved',
        severity: 'error',
        message: expect.stringContaining('review-123'),
      }),
    ]);
    expect(JSON.stringify(policy)).toBe(before);
  });

  it('adds a new warning error without consuming the reviewed identity', () => {
    const added = identity();
    added.source = 'new-consumer';
    const result = evaluateIdentityBaseline(
      [warning(), warning(added)],
      config(),
    );
    expect(result.baselined).toHaveLength(1);
    expect(result.resolved).toEqual([]);
    expect(result.new).toHaveLength(1);
    expect(result.errors.map(({ code }) => code)).toEqual([
      'adoption-baseline-new',
    ]);
  });

  it('ignores wording, property insertion order and classification tag order', () => {
    const same = identity();
    same.classification.source.tags.reverse();
    const rendered = {
      ...warning(same),
      message: 'Updated wording with no policy change.',
    };
    expect(warningIdentityKey(same)).toBe(warningIdentityKey(identity()));
    expect(evaluateIdentityBaseline([rendered], config()).errors).toEqual([]);
  });

  it.each([
    undefined,
    { ...identity(), constraint: 'module-boundaries:unknown' },
    {
      ...identity(),
      classification: {
        ...identity().classification,
        dependencyKind: 'unknown',
      },
    },
  ])(
    'fails closed for unsupported or incomplete warning identity metadata',
    (metadata) => {
      const diagnostic = { ...warning(), identity: metadata } as Diagnostic;
      const result = evaluateIdentityBaseline([diagnostic], config());
      expect(result.baselined).toEqual([]);
      expect(result.new[0].reason).toBe('unsupported-identity');
      expect(
        result.errors.some(
          ({ code }) => code === 'adoption-baseline-unsupported',
        ),
      ).toBe(true);
    },
  );

  it('does not baseline errors or silently accept duplicate warning identities', () => {
    const error: Diagnostic = { ...warning(), severity: 'error' };
    const result = evaluateIdentityBaseline([error], config());
    expect(result.baselined).toEqual([]);
    expect(error.severity).toBe('error');
    expect(result.resolved).toHaveLength(1);
    const duplicated = evaluateIdentityBaseline(
      [warning(), warning()],
      config(),
    );
    expect(duplicated.baselined).toEqual([]);
    expect(duplicated.new.map(({ reason }) => reason)).toEqual([
      'duplicate-identity',
      'duplicate-identity',
    ]);
    expect(
      duplicated.errors.some(
        ({ code }) => code === 'adoption-baseline-duplicate',
      ),
    ).toBe(true);
  });

  it('leaves default count-only behavior untouched when identity mode is absent', () => {
    expect(
      evaluateIdentityBaseline([warning()], DEFAULT_MEGAMONO_CONFIG),
    ).toEqual({ baselined: [], new: [], resolved: [], errors: [] });
  });
});
