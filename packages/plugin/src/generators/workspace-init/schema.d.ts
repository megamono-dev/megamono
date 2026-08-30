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
  readonly packageRegistries?: string;
  readonly packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  readonly ciMode?: 'auto' | 'standalone' | 'reusable';
  readonly docsRoot?: string;
  readonly docsLoader?: string;
  readonly docsModule?: string;
  readonly docsOutput?: string;
  readonly docsLoaderMode?: 'create' | 'adopt';
  readonly docsAdoptionMap?: string;
  readonly defaultScope?: string;
  readonly defaultPlatform?:
    'web' | 'node' | 'worker' | 'apple' | 'rust' | 'php' | 'extension';
  readonly adoptionMap?: string;
  readonly toolchainPin?: 'none' | 'nvmrc' | 'node-version' | 'both';
  readonly toolchainNode?: string;
}
