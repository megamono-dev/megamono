import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MEGAMONO_CONFIG, megamonoConfigSchema } from './config';
import {
  classifyDependency,
  dependencyIdentityKey,
  type BoundaryAllowance,
  type DependencyFindingIdentity,
} from './dependency-policy-contract';

const identity: DependencyFindingIdentity = {
  rule: 'module-boundaries',
  constraint: 'module-boundaries:type-direction',
  source: 'feature',
  target: 'other-feature',
  classification: {
    dependencyKind: 'static',
    source: {
      kind: 'lib',
      tags: ['type:feature', 'scope:shared', 'platform:node'],
    },
    target: {
      kind: 'lib',
      tags: ['type:feature', 'scope:shared', 'platform:node'],
    },
  },
};
const allowance: BoundaryAllowance = {
  source: identity.source,
  target: identity.target,
  constraint: identity.constraint,
  classification: identity.classification,
  rationale: 'Reviewed domain composition during migration.',
  decision: 'decision-20261105-domain-composition',
};
const entry = {
  identity,
  reason: 'Existing dependency requires a staged extraction.',
  reviewReference: 'PR #42 architecture review',
  revision: 'a'.repeat(40),
};
const fresh = () =>
  structuredClone({
    ...DEFAULT_MEGAMONO_CONFIG,
    version: 2,
    conventions: {
      ...DEFAULT_MEGAMONO_CONFIG.conventions,
      boundaryAllowances: [allowance],
    },
    adoption: {
      ...DEFAULT_MEGAMONO_CONFIG.adoption,
      warningBaseline: {
        identityVersion: 1,
        rules: ['module-boundaries'],
        entries: [entry],
      },
    },
  });
const schema = JSON.parse(
  readFileSync(join(__dirname, '../../schemas/megamono.schema.json'), 'utf8'),
);
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(
  schema,
);

describe('versioned dependency policy contract', () => {
  it('keeps legacy defaults unchanged and accepts explicit version 2', () => {
    expect(megamonoConfigSchema.parse(DEFAULT_MEGAMONO_CONFIG).version).toBe(1);
    expect(
      megamonoConfigSchema.parse(DEFAULT_MEGAMONO_CONFIG).conventions,
    ).not.toHaveProperty('boundaryAllowances');
    expect(
      megamonoConfigSchema.parse(DEFAULT_MEGAMONO_CONFIG).adoption,
    ).not.toHaveProperty('warningBaseline');
    expect(megamonoConfigSchema.safeParse(fresh()).success).toBe(true);
    expect(validate(fresh()), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(['allowance', 'baseline'])(
    'rejects %s fields in version 1 even when their lists are empty',
    (field) => {
      const config = structuredClone(DEFAULT_MEGAMONO_CONFIG);
      const input =
        field === 'allowance'
          ? {
              ...config,
              conventions: { ...config.conventions, boundaryAllowances: [] },
            }
          : {
              ...config,
              adoption: {
                ...config.adoption,
                warningBaseline: {
                  identityVersion: 1,
                  rules: ['module-boundaries'],
                  entries: [],
                },
              },
            };
      expect(megamonoConfigSchema.safeParse(input).success).toBe(false);
      expect(validate(input)).toBe(false);
    },
  );

  it.each([
    [
      'wildcard source',
      (config: ReturnType<typeof fresh>) => {
        config.conventions.boundaryAllowances[0].source = 'feature-*';
      },
    ],
    [
      'wildcard target',
      (config: ReturnType<typeof fresh>) => {
        config.conventions.boundaryAllowances[0].target = '@example/*';
      },
    ],
    [
      'blank rationale',
      (config: ReturnType<typeof fresh>) => {
        config.conventions.boundaryAllowances[0].rationale = '  ';
      },
    ],
    [
      'invalid decision',
      (config: ReturnType<typeof fresh>) => {
        config.conventions.boundaryAllowances[0].decision = 'unreviewed';
      },
    ],
    [
      'unknown constraint',
      (config: ReturnType<typeof fresh>) => {
        Object.assign(config.conventions.boundaryAllowances[0], {
          constraint: 'platform-boundary',
        });
      },
    ],
    [
      'unknown field',
      (config: ReturnType<typeof fresh>) => {
        Object.assign(config.conventions.boundaryAllowances[0], {
          allTargets: true,
        });
      },
    ],
    [
      'unknown dependency kind',
      (config: ReturnType<typeof fresh>) => {
        Object.assign(
          config.adoption.warningBaseline.entries[0].identity.classification,
          { dependencyKind: 'runtime' },
        );
      },
    ],
    [
      'unsupported identity version',
      (config: ReturnType<typeof fresh>) => {
        config.adoption.warningBaseline.identityVersion = 2;
      },
    ],
    [
      'blank review reference',
      (config: ReturnType<typeof fresh>) => {
        config.adoption.warningBaseline.entries[0].reviewReference = '\n ';
      },
    ],
    [
      'invalid recorded revision',
      (config: ReturnType<typeof fresh>) => {
        config.adoption.warningBaseline.entries[0].revision = 'HEAD';
      },
    ],
    [
      'unreviewed baseline metadata',
      (config: ReturnType<typeof fresh>) => {
        config.adoption.warningBaseline.entries[0].reason = '';
      },
    ],
  ] as const)(
    'rejects %s in both published and runtime schemas',
    (_name, mutate) => {
      const config = fresh();
      mutate(config);
      expect(megamonoConfigSchema.safeParse(config).success).toBe(false);
      expect(validate(config), JSON.stringify(validate.errors)).toBe(false);
    },
  );

  it('rejects count and identity modes for the same rule in both schemas', () => {
    const config = fresh();
    config.adoption.ratchets = [
      { rule: 'module-boundaries', initialCount: 14, targetSeverity: 'error' },
    ];
    expect(megamonoConfigSchema.safeParse(config).success).toBe(false);
    expect(validate(config)).toBe(false);
  });

  it('rejects duplicate exact allowance keys with different rationale or classification', () => {
    const config = fresh();
    config.conventions.boundaryAllowances.push({
      ...allowance,
      rationale: 'A different explanation does not create a second permission.',
    });
    expect(megamonoConfigSchema.safeParse(config).success).toBe(false);
    config.conventions.boundaryAllowances[1].classification = {
      ...allowance.classification,
      dependencyKind: 'implicit',
    };
    expect(megamonoConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects duplicate baseline identities even when tag ordering and review text differ', () => {
    const config = fresh();
    const duplicate = structuredClone(entry);
    duplicate.identity.classification.source.tags.reverse();
    duplicate.reviewReference =
      'Second review still duplicates the same finding';
    config.adoption.warningBaseline.entries.push(duplicate);
    expect(megamonoConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects self-edge permissions and identities at runtime', () => {
    const config = fresh();
    config.conventions.boundaryAllowances[0].target = identity.source;
    expect(megamonoConfigSchema.safeParse(config).success).toBe(false);
    const other = fresh();
    other.adoption.warningBaseline.entries[0].identity.target = identity.source;
    expect(megamonoConfigSchema.safeParse(other).success).toBe(false);
  });

  it('canonicalizes tag order but retains dependency kind and duplicate classification facts', () => {
    const reordered = structuredClone(identity);
    reordered.classification.source.tags.reverse();
    expect(dependencyIdentityKey(reordered)).toBe(
      dependencyIdentityKey(identity),
    );
    reordered.classification.dependencyKind = 'implicit';
    expect(dependencyIdentityKey(reordered)).not.toBe(
      dependencyIdentityKey(identity),
    );
    const duplicate = structuredClone(identity);
    duplicate.classification.source.tags.push('type:feature');
    expect(dependencyIdentityKey(duplicate)).not.toBe(
      dependencyIdentityKey(identity),
    );
  });

  it('classifies graph metadata without mutating it and refuses unresolved edge kinds', () => {
    const source = {
      name: 'feature',
      type: 'lib' as const,
      data: {
        root: 'libs/feature',
        tags: ['type:feature', 'npm:private', 'scope:shared'],
      },
    };
    const target = {
      name: 'other-feature',
      type: 'lib' as const,
      data: {
        root: 'libs/other-feature',
        tags: ['scope:shared', 'type:feature'],
      },
    };
    const before = structuredClone(source);
    expect(classifyDependency(source, target, 'dynamic')).toMatchObject({
      dependencyKind: 'dynamic',
      source: { tags: ['scope:shared', 'type:feature'] },
    });
    expect(classifyDependency(source, target, 'unresolved')).toBeUndefined();
    expect(source).toEqual(before);
  });
});
