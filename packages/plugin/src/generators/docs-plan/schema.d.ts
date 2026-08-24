export interface DocsPlanGeneratorSchema {
  readonly project: string;
  readonly title: string;
  readonly topics?: string[];
  readonly references?: string[];
  readonly externalReferences?: string[];
  readonly date?: string;
}
