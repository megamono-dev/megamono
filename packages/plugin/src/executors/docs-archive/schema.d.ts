export interface DocsArchiveExecutorSchema {
  readonly id: string;
  readonly status?:
    'completed' | 'aborted' | 'retired' | 'superseded' | 'complete';
  readonly reason?: string;
  readonly replacementId?: string;
  readonly completedAt?: string;
  readonly config?: string;
  readonly docsRoot?: string;
  readonly dryRun?: boolean;
}
