export interface AdoptionPolicyGeneratorSchema {
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly policyFile?: string;
  readonly report?: string;
}
