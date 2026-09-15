import type { ProjectConfiguration } from '@nx/devkit';

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

/** Shared by authored scaffolds and inference. Finite WXT jobs form one DAG chain
 * because browser builds and zips also rewrite the shared .wxt directory. */
export function wxtTargets(
  versions: BrowserManifestVersions = {},
  names: {
    devChromeTargetName?: string;
    devFirefoxTargetName?: string;
    buildTargetName?: string;
    packageTargetName?: string;
  } = {},
): NonNullable<ProjectConfiguration['targets']> {
  const run = (
    command: string,
    dependsOn: string[] = [],
    outputs: string[] = [],
  ) => ({
    executor: 'nx:run-commands',
    cache: false,
    dependsOn,
    outputs,
    options: { command, cwd: '{projectRoot}' },
  });
  return {
    prepare: run('wxt prepare', [], ['{projectRoot}/.wxt']),
    typecheck: run('tsc --noEmit', ['prepare']),
    [names.devChromeTargetName ?? 'dev-chrome']: {
      ...run(wxtCommand('', 'chrome', versions.chrome), ['prepare']),
      continuous: true,
    },
    [names.devFirefoxTargetName ?? 'dev-firefox']: {
      ...run(wxtCommand('', 'firefox', versions.firefox), ['prepare']),
      continuous: true,
    },
    'build-chrome': run(
      wxtCommand('build', 'chrome', versions.chrome),
      ['typecheck'],
      [wxtOutput('chrome', versions.chrome)],
    ),
    'build-firefox': run(
      wxtCommand('build', 'firefox', versions.firefox),
      ['build-chrome'],
      [wxtOutput('firefox', versions.firefox)],
    ),
    [names.buildTargetName ?? 'build']: {
      executor: 'nx:noop',
      cache: false,
      dependsOn: ['build-chrome', 'build-firefox'],
      outputs: ['{projectRoot}/.output'],
    },
    'package-chrome': run(
      wxtCommand('zip', 'chrome', versions.chrome),
      ['build-firefox'],
      ['{projectRoot}/.output/*-chrome.zip'],
    ),
    'package-firefox': run(
      wxtCommand('zip', 'firefox', versions.firefox),
      ['package-chrome'],
      ['{projectRoot}/.output/*-firefox.zip'],
    ),
    'package-firefox-source': run(
      `${wxtCommand('zip', 'firefox', versions.firefox)} --sources`,
      ['package-firefox'],
      ['{projectRoot}/.output/*-sources.zip'],
    ),
    [names.packageTargetName ?? 'package']: {
      executor: 'nx:noop',
      cache: false,
      dependsOn: [
        'package-chrome',
        'package-firefox',
        'package-firefox-source',
      ],
      outputs: ['{projectRoot}/.output/*.zip'],
    },
    test: { ...run('vitest run'), cache: true },
    lint: {
      ...run(
        "eslint . --ignore-pattern '.wxt/**' --ignore-pattern '.output/**'",
      ),
      cache: true,
    },
  };
}
