import type { DatabaseAdapter } from '../../lib/config';

export interface DatabaseGeneratorSchema {
  readonly name?: string;
  readonly adapter?: DatabaseAdapter;
  readonly directory?: string;
  readonly project?: string;
  readonly target?: string;
  readonly schema?: string;
  readonly scope?: string;
  readonly interactive?: boolean;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  readonly bootstrap?: boolean;
}
