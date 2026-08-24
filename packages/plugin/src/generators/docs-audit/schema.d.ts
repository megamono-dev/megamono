export interface DocsAuditGeneratorSchema {
  readonly target: string;
  readonly project: string;
  readonly spec: string;
  readonly title?: string;
  readonly topics?: string[];
  readonly references?: string[];
  readonly externalReferences?: string[];
  readonly date?: string;
}
