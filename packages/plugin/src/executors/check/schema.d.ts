export interface CheckExecutorSchema {
  readonly config?: string;
  readonly docsRoot?: string;
  readonly skipDocs?: boolean;
  readonly verbose?: boolean;
  readonly ci?: boolean;
}
