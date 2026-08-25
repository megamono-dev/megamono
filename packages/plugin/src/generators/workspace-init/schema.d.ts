export interface WorkspaceInitGeneratorSchema {
  readonly survey?: boolean;
  readonly format?: 'markdown' | 'json';
  readonly only?: string;
  readonly yes?: boolean;
  readonly report?: string;
  readonly docsRoot?: string;
  readonly defaultScope?: string;
  readonly defaultPlatform?:
    'web' | 'node' | 'worker' | 'apple' | 'rust' | 'php' | 'extension';
}
