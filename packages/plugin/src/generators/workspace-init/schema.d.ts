export interface WorkspaceInitGeneratorSchema {
  readonly survey?: boolean;
  readonly format?: 'markdown' | 'json';
  readonly only?: string;
  readonly yes?: boolean;
  readonly report?: string;
  readonly bootstrap?: boolean;
  readonly platforms?: string;
  readonly serviceRunner?: 'none' | 'springbar';
  readonly serviceRequirements?: string;
  readonly docsRoot?: string;
  readonly defaultScope?: string;
  readonly defaultPlatform?:
    'web' | 'node' | 'worker' | 'apple' | 'rust' | 'php' | 'extension';
}
