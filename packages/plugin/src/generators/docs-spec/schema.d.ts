export interface DocsArchitectureDependency {
  readonly from: string;
  readonly to: string;
}

export interface DocsSpecGeneratorSchema {
  readonly project: string;
  readonly projects?: string[];
  readonly title?: string;
  readonly topics?: string[];
  readonly references?: string[];
  readonly externalReferences?: string[];
  readonly allowedDependencies?: DocsArchitectureDependency[];
  readonly forbiddenDependencies?: DocsArchitectureDependency[];
  readonly date?: string;
}
