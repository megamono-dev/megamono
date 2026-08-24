import type {
  ConvertAnalysisOptions,
  ConvertVerifyMode,
} from '../../lib/convert';

export interface ConvertGeneratorSchema extends ConvertAnalysisOptions {
  readonly verify?: ConvertVerifyMode;
  readonly report?: string;
  readonly scope?: string;
  readonly dryRun?: boolean;
}
