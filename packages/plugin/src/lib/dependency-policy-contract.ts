import type { ProjectGraphProjectNode } from '@nx/devkit';
import { z } from 'zod';

export const BOUNDARY_CONSTRAINTS = [
  'module-boundaries:type-direction',
  'module-boundaries:scope-direction',
] as const;
export const DEPENDENCY_KINDS = ['implicit', 'static', 'dynamic'] as const;
const projectId = z.string().regex(/^[a-zA-Z0-9@][a-zA-Z0-9@._/:-]*$/);
const classificationTags = z.array(
  z
    .string()
    .regex(/^(?:type|scope|platform|role):[a-z0-9]+(?:[-:][a-z0-9]+)*$/),
);
const projectClassificationSchema = z
  .object({
    kind: z.enum(['app', 'lib', 'e2e']),
    tags: classificationTags,
  })
  .strict();
export const dependencyClassificationSchema = z
  .object({
    dependencyKind: z.enum(DEPENDENCY_KINDS),
    source: projectClassificationSchema,
    target: projectClassificationSchema,
  })
  .strict();
export const dependencyFindingIdentitySchema = z
  .object({
    rule: z.literal('module-boundaries'),
    constraint: z.enum(BOUNDARY_CONSTRAINTS),
    source: projectId,
    target: projectId,
    classification: dependencyClassificationSchema,
  })
  .strict()
  .refine((value) => value.source !== value.target, {
    message: 'Dependency findings must identify distinct projects.',
  });
export const boundaryAllowanceSchema = z
  .object({
    source: projectId,
    target: projectId,
    constraint: z.enum(BOUNDARY_CONSTRAINTS),
    classification: dependencyClassificationSchema,
    rationale: z.string().trim().min(1),
    decision: z.string().regex(/^decision-\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/),
  })
  .strict()
  .refine((value) => value.source !== value.target, {
    message: 'Boundary allowances must identify distinct projects.',
  });
export const warningBaselineEntrySchema = z
  .object({
    identity: dependencyFindingIdentitySchema,
    reason: z.string().trim().min(1),
    reviewReference: z.string().trim().min(1),
    revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  })
  .strict();
export const warningBaselineSchema = z
  .object({
    identityVersion: z.literal(1),
    rules: z
      .array(z.literal('module-boundaries'))
      .min(1)
      .refine((rules) => new Set(rules).size === rules.length, {
        message: 'Identity baseline rules must be unique.',
      }),
    entries: z.array(warningBaselineEntrySchema),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = new Set<string>();
    value.entries.forEach((entry, index) => {
      const key = dependencyIdentityKey(entry.identity);
      if (identities.has(key))
        context.addIssue({
          code: 'custom',
          path: ['entries', index],
          message: 'Identity baseline entries must be unique.',
        });
      identities.add(key);
    });
  });

export type DependencyClassification = z.infer<
  typeof dependencyClassificationSchema
>;
export type DependencyFindingIdentity = z.infer<
  typeof dependencyFindingIdentitySchema
>;
export type BoundaryAllowance = z.infer<typeof boundaryAllowanceSchema>;
export type WarningBaselineEntry = z.infer<typeof warningBaselineEntrySchema>;
export type WarningBaseline = z.infer<typeof warningBaselineSchema>;

export function dependencyIdentityKey(
  identity: DependencyFindingIdentity,
): string {
  const canonical = (project: DependencyClassification['source']) => ({
    kind: project.kind,
    tags: [...project.tags].sort(),
  });
  return JSON.stringify([
    identity.rule,
    identity.constraint,
    identity.source,
    identity.target,
    {
      dependencyKind: identity.classification.dependencyKind,
      source: canonical(identity.classification.source),
      target: canonical(identity.classification.target),
    },
  ]);
}

/** Classify graph facts without parsing diagnostic wording or mutating tags. */
export function classifyDependency(
  source: ProjectGraphProjectNode,
  target: ProjectGraphProjectNode,
  kind: string,
): DependencyClassification | undefined {
  if (!(DEPENDENCY_KINDS as readonly string[]).includes(kind)) return undefined;
  const classify = (project: ProjectGraphProjectNode) => ({
    kind: project.type,
    tags: (project.data.tags ?? [])
      .filter((tag) => /^(?:type|scope|platform|role):/.test(tag))
      .sort(),
  });
  const value = dependencyClassificationSchema.safeParse({
    dependencyKind: kind,
    source: classify(source),
    target: classify(target),
  });
  return value.success ? value.data : undefined;
}
