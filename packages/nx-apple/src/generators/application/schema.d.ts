export interface AppleApplicationGeneratorSchema {
  name: string;
  directory?: string;
  displayName?: string;
  bundleIdentifier?: string;
  deploymentTarget?: string | number;
  scope?: string;
  tags?: string;
  skipFormat?: boolean;
}
