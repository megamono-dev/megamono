import type {
  ImportHistoryStrategy,
  ImportResolutions,
  ImportVerifyMode,
} from '../../lib/repository-import';

export interface ImportExecutorSchema {
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
