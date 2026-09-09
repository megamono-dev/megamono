export type BrowserManifestVersions = Partial<
  Record<'chrome' | 'firefox', 2 | 3>
>;

export function manifestVersions(value: unknown): BrowserManifestVersions {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([browser, version]) =>
        !['chrome', 'firefox'].includes(browser) || ![2, 3].includes(version),
    )
  ) {
    throw new Error(
      'Extension manifestVersions must map chrome/firefox to 2 or 3.',
    );
  }
  return value as BrowserManifestVersions;
}

export function wxtCommand(
  verb: '' | 'build' | 'zip',
  browser: 'chrome' | 'firefox',
  version?: 2 | 3,
): string {
  return `wxt${verb ? ` ${verb}` : ''} --browser ${browser}${version ? ` --mv${version}` : ''}`;
}

export function wxtOutput(
  browser: 'chrome' | 'firefox',
  version?: 2 | 3,
): string {
  // Config may be a function or import. Never execute it during discovery or
  // assume Firefox MV2 when the host has not supplied an explicit override.
  return `{projectRoot}/.output/${browser}-mv${version ?? '*'}`;
}
