export interface VerifyContainerExecutorSchema {
  readonly dockerfile?: string;
  readonly report?: string;
  readonly smoke?: boolean;
  readonly context?: string;
}
