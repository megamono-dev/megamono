export interface WorkspaceInitGeneratorSchema {
  readonly survey?: boolean;
  readonly dryRun?: boolean;
  readonly format?: 'markdown' | 'json';
  readonly only?: string;
  readonly interactive?: boolean;
  readonly yes?: boolean;
  readonly report?: string;
  readonly bootstrap?: boolean;
  readonly platforms?: string;
  readonly ports?: string;
  readonly serviceRunner?: 'none' | 'springbar';
  readonly serviceRequirements?: string;
  readonly packageManager?: 'pnpm' | 'npm';
  readonly docsRoot?: string;
  readonly defaultScope?: string;
  readonly defaultPlatform?:
    'web' | 'node' | 'worker' | 'apple' | 'rust' | 'php' | 'extension';
  readonly adoptionMap?: string;
  readonly toolchainPin?: 'none' | 'nvmrc' | 'node-version' | 'both';
  readonly toolchainNode?: string;
}
