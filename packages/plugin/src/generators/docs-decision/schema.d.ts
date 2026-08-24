export interface DocsDecisionGeneratorSchema {
  readonly title: string;
  readonly project: string;
  readonly topics?: string[];
  readonly references?: string[];
  readonly externalReferences?: string[];
  readonly date?: string;
}
