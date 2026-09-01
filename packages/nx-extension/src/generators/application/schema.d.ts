export interface ExtensionApplicationSchema {
  readonly name: string;
  readonly projectName?: string;
  readonly directory?: string;
  readonly scope?: string;
  readonly tags?: string;
  readonly displayName?: string;
  readonly skipFormat?: boolean;
}
