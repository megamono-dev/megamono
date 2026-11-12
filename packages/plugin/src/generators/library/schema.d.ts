export interface LibraryGeneratorSchema {
  name: string;
  scope?: string;
  packageScope?: string;
  platform?: 'neutral' | 'web' | 'node' | 'mobile' | 'worker';
  type?: 'util' | 'ui' | 'data' | 'feature';
  publishable?: boolean;
  access?: 'restricted' | 'public';
  skipInstall?: boolean;
  testRunner?: 'vitest' | 'none';
  dryRun?: boolean;
  planOnly?: boolean;
  yes?: boolean;
  allowDirty?: boolean;
}
