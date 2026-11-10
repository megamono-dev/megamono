export interface CheckExecutorSchema {
  readonly config?: string;
  readonly docsRoot?: string;
  readonly skipDocs?: boolean;
  readonly verbose?: boolean;
  readonly json?: boolean;
  readonly ci?: boolean;
  readonly profile?: 'development' | 'migration' | 'ci' | 'release';
  readonly excludeProjects?: string | readonly string[];
}
