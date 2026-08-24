import type { HealthCheck } from '../../lib/health';

export interface HealthExecutorSchema {
  readonly config?: string;
  readonly docsRoot?: string;
  readonly checks?: readonly HealthCheck[];
  readonly output?: string;
  readonly failOnFindings?: boolean;
  readonly now?: string;
}
