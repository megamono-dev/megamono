export interface WorkerGeneratorSchema {
  readonly name: string;
  readonly directory?: string;
  readonly workerName?: string;
  readonly scope?: string;
  readonly tags?: string;
  readonly pages?: boolean;
  readonly dryRun?: boolean;
}
