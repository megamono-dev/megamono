export type CloudflareBindingType =
  | 'service'
  | 'kv'
  | 'r2'
  | 'd1'
  | 'hyperdrive'
  | 'queue-producer'
  | 'queue-consumer'
  | 'vectorize'
  | 'ai'
  | 'ai-search'
  | 'workflow'
  | 'analytics-engine'
  | 'browser'
  | 'images'
  | 'mtls'
  | 'dispatch-namespace'
  | 'assets';

export interface BindingGeneratorSchema {
  readonly project: string;
  readonly type: CloudflareBindingType;
  readonly binding: string;
  readonly resource?: string;
  readonly scriptName?: string;
  readonly remote?: boolean;
  readonly experimental?: boolean;
  readonly configPath?: string;
  readonly dryRun?: boolean;
}
