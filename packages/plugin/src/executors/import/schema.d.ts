import type {
  ImportHistoryStrategy,
  ImportResolutions,
  ImportVerifyMode,
} from '../../lib/repository-import';
import type { MonorepoSelection } from '../../lib/monorepo-import';

export interface ImportExecutorSchema {
  readonly monorepo?: MonorepoSelection;
  readonly source: string;
  readonly ref?: string;
  readonly expectedSourceSha?: string;
  readonly name: string;
  readonly destination?: string;
  readonly history?: ImportHistoryStrategy;
  readonly verify?: ImportVerifyMode;
  readonly execute?: boolean;
  readonly allowHistoryLoss?: boolean;
  readonly resolutions?: ImportResolutions;
}
