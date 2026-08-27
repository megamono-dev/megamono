export interface PlaystackLintGeneratorSchema {
  readonly preset?: 'recommended' | 'all';
  readonly interactive?: boolean;
  readonly dryRun?: boolean;
}
