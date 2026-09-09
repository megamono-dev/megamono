export type AppType =
  | 'web'
  | 'site'
  | 'api'
  | 'worker'
  | 'mobile'
  | 'desktop'
  | 'apple'
  | 'extension';

export interface AppGeneratorSchema {
  readonly type?: AppType;
  readonly name?: string;
  readonly directory?: string;
  readonly scope?: string;
  readonly port?: number;
  readonly styling?: import('../../lib/web-styling').WebStyling;
  readonly router?: 'pages' | 'app';
  readonly manifestVersion?: 2 | 3;
  readonly interactive?: boolean;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  readonly bootstrap?: boolean;
  readonly workspaceName?: string;
  readonly requestedApps?: string;
  readonly requestedServices?: string;
  readonly serviceRunner?: 'none' | 'springbar';
}
