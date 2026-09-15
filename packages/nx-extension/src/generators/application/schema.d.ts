export interface ExtensionApplicationSchema {
  readonly name: string;
  readonly projectName?: string;
  readonly directory?: string;
  readonly scope?: string;
  readonly tags?: string;
  readonly displayName?: string;
  readonly contentScriptMatches?: string[];
  readonly manifestVersion?: 2 | 3;
  readonly skipFormat?: boolean;
  readonly skipInstall?: boolean;
}
