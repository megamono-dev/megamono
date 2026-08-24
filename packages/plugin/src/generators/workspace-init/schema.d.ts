export interface WorkspaceInitGeneratorSchema {
  readonly docsRoot?: string;
  readonly defaultScope?: string;
  readonly defaultPlatform?:
    'web' | 'node' | 'worker' | 'apple' | 'rust' | 'php' | 'extension';
}
