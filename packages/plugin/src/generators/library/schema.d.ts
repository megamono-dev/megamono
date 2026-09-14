export interface LibraryGeneratorSchema {
  name: string;
  scope?: string;
  platform?: 'neutral' | 'web' | 'node' | 'mobile' | 'worker';
  type?: 'util' | 'ui' | 'data' | 'feature';
  publishable?: boolean;
  access?: 'restricted' | 'public';
  skipInstall?: boolean;
  dryRun?: boolean;
  planOnly?: boolean;
  yes?: boolean;
}
