export interface DurableObjectGeneratorSchema {
  readonly project: string;
  readonly className: string;
  readonly binding?: string;
  readonly migrationTag?: string;
  readonly configPath?: string;
  readonly dryRun?: boolean;
}
