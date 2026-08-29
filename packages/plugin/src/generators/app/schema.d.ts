export type AppType =
  | 'web'
  | 'site'
  | 'api'
  | 'worker'
  | 'mobile'
  | 'desktop'
  | 'apple';

export interface AppGeneratorSchema {
  readonly type?: AppType;
  readonly name?: string;
  readonly directory?: string;
  readonly scope?: string;
  readonly port?: number;
  readonly interactive?: boolean;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  readonly bootstrap?: boolean;
  readonly workspaceName?: string;
  readonly requestedApps?: string;
  readonly requestedServices?: string;
  readonly serviceRunner?: 'none' | 'springbar';
}
