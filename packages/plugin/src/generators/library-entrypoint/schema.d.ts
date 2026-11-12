export interface LibraryEntrypointGeneratorSchema {
  readonly project: string;
  readonly name?: string;
  readonly sideEffects?: boolean;
  readonly dryRun?: boolean;
}
