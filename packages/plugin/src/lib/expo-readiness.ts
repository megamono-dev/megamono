import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { ProjectGraph } from '@nx/devkit';
import { major, satisfies, valid, validRange } from 'semver';
import ts = require('typescript');
import type { HealthFinding } from './health';

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly engines?: { readonly node?: string };
}

export interface ExpoProjectInspection {
  readonly project: string;
  readonly root: string;
  readonly declaredExpoRange?: string;
  readonly installedExpoVersion?: string;
  readonly configuredSdkVersion?: string;
  readonly validation: 'not-assessed';
  readonly doctor: {
    readonly status: 'configured' | 'not-detected';
    readonly evidence: readonly string[];
    readonly installedVersion?: string;
    readonly nodeRange?: string;
    readonly nodeCompatible?: boolean;
  };
  readonly metro: {
    readonly status:
      | 'implicit-defaults'
      | 'expo-defaults-import'
      | 'direct-internal-import'
      | 'custom-unverified';
    readonly path?: string;
  };
  readonly compatibility: readonly {
    readonly package: string;
    readonly expected: string;
    readonly installed: string;
    readonly compatible: boolean;
  }[];
}

function json<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// Resolve from the app, so a supported mobile React version is never confused
// with a different version installed for a web app. Never load app config/code.
function installed(
  projectRoot: string,
  name: string,
):
  | {
      path: string;
      manifest: Manifest;
    }
  | undefined {
  try {
    const path = createRequire(join(projectRoot, 'package.json')).resolve(
      `${name}/package.json`,
    );
    const manifest = json<Manifest>(path);
    return manifest ? { path, manifest } : undefined;
  } catch (error) {
    if (
      ['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      return undefined;
    throw error;
  }
}

// This deliberately recognizes only direct commands. A custom script/wrapper
// can be valid, but static inspection must not treat a mention as execution.
function doctorCommand(source: string): boolean {
  if (/[;|`$\n]/.test(source)) return false;
  return source.split('&&').some((part) => {
    const tokens = part.trim().split(/\s+/);
    if (
      tokens.some((token) =>
        ['--help', '-h', '--version', '-v'].includes(token),
      )
    )
      return false;
    const command = tokens.join(' ');
    return /^(?:(?:npx|bunx)(?: --no-install)? |(?:npm|pnpm|yarn) exec (?:-- )?|(?:pnpm|yarn) )?expo-doctor(?: |$)/.test(
      command,
    );
  });
}

function commandStrings(
  target: NonNullable<ProjectGraph['nodes'][string]['data']['targets']>[string],
): string[] {
  return [
    target.command,
    target.options?.command,
    ...(Array.isArray(target.options?.commands)
      ? target.options.commands.map((entry: string | { command?: string }) =>
          typeof entry === 'string' ? entry : entry.command,
        )
      : []),
  ].filter((value): value is string => typeof value === 'string');
}

function metroImports(source: string): Set<string> {
  const imports = new Set<string>();
  const file = ts.createSourceFile(
    'metro.config.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.add(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

export function inspectExpoProjects(
  workspaceRoot: string,
  graph: ProjectGraph,
): ExpoProjectInspection[] {
  const rootManifest = json<Manifest>(join(workspaceRoot, 'package.json'));
  return Object.entries(graph.nodes)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([project, node]) => {
      const projectRoot = resolve(workspaceRoot, node.data.root);
      const manifest = json<Manifest>(join(projectRoot, 'package.json'));
      const app = json<{ expo?: { sdkVersion?: string } }>(
        join(projectRoot, 'app.json'),
      );
      const targets = Object.entries(node.data.targets ?? {});
      const declaredExpoRange =
        manifest?.dependencies?.expo ?? manifest?.devDependencies?.expo;
      const expoTarget = targets.some(([, target]) =>
        target.executor?.startsWith('@nx/expo:'),
      );
      if (
        !app?.expo &&
        !expoTarget &&
        !(
          declaredExpoRange &&
          node.type === 'app' &&
          projectRoot !== resolve(workspaceRoot)
        )
      )
        return [];
      const expo = installed(projectRoot, 'expo');
      const doctor = installed(projectRoot, 'expo-doctor')?.manifest;
      const doctorNodeRange = doctor?.engines?.node;
      const doctorEvidence = Object.entries(manifest?.scripts ?? {})
        .filter(([, command]) => doctorCommand(command))
        .map(([name]) => `${node.data.root}/package.json#scripts.${name}`);
      for (const [name, target] of targets) {
        const cwd = target.options?.cwd;
        const appCwd =
          typeof cwd === 'string' &&
          resolve(
            workspaceRoot,
            cwd
              .replaceAll('{projectRoot}', node.data.root)
              .replaceAll('{workspaceRoot}', workspaceRoot),
          ) === projectRoot;
        if (
          target.executor === '@megamono/plugin:expo-doctor' ||
          (appCwd && commandStrings(target).some(doctorCommand))
        ) {
          doctorEvidence.push(`${project}:target:${name}`);
        }
      }
      // A root script only supplies app-specific evidence when it explicitly
      // selects this package. A root Doctor command cannot validate every app.
      if (manifest?.name) {
        for (const [name, command] of Object.entries(
          rootManifest?.scripts ?? {},
        )) {
          const match = command.match(
            /^npm exec --workspace(?:=|\s+)([^\s]+) -- (expo-doctor(?:\s.*)?)$/,
          );
          if (match?.[1] === manifest.name && doctorCommand(match[2]))
            doctorEvidence.push(`package.json#scripts.${name}`);
        }
      }
      const metroPath = [
        'metro.config.js',
        'metro.config.cjs',
        'metro.config.mjs',
        'metro.config.ts',
      ].find((name) => existsSync(join(projectRoot, name)));
      const source = metroPath
        ? readFileSync(join(projectRoot, metroPath), 'utf8')
        : '';
      const imports = metroImports(source);
      const metro: ExpoProjectInspection['metro'] = {
        status: !metroPath
          ? 'implicit-defaults'
          : imports.has('expo/metro-config')
            ? 'expo-defaults-import'
            : imports.has('@expo/metro-config')
              ? 'direct-internal-import'
              : 'custom-unverified',
        ...(metroPath ? { path: `${node.data.root}/${metroPath}` } : {}),
      };
      const bundled = expo
        ? json<Record<string, string>>(
            join(dirname(expo.path), 'bundledNativeModules.json'),
          )
        : undefined;
      const compatibility = ['react', 'react-dom', 'react-native'].flatMap(
        (name) => {
          if (
            name === 'react-dom' &&
            !(
              manifest?.dependencies?.[name] ??
              manifest?.devDependencies?.[name]
            )
          )
            return [];
          const version = installed(projectRoot, name)?.manifest.version;
          const expected = bundled?.[name];
          return version && valid(version) && expected && validRange(expected)
            ? [
                {
                  package: name,
                  installed: version,
                  expected,
                  compatible: satisfies(version, expected, {
                    includePrerelease: true,
                  }),
                },
              ]
            : [];
        },
      );
      return [
        {
          project,
          root: node.data.root,
          ...((declaredExpoRange ??
          rootManifest?.dependencies?.expo ??
          rootManifest?.devDependencies?.expo)
            ? {
                declaredExpoRange:
                  declaredExpoRange ??
                  rootManifest?.dependencies?.expo ??
                  rootManifest?.devDependencies?.expo,
              }
            : {}),
          ...(expo?.manifest.version
            ? { installedExpoVersion: expo.manifest.version }
            : {}),
          ...(app?.expo?.sdkVersion
            ? { configuredSdkVersion: app.expo.sdkVersion }
            : {}),
          validation: 'not-assessed' as const,
          doctor: {
            status: doctorEvidence.length
              ? ('configured' as const)
              : ('not-detected' as const),
            evidence: doctorEvidence.sort(),
            ...(doctor?.version ? { installedVersion: doctor.version } : {}),
            ...(doctorNodeRange ? { nodeRange: doctorNodeRange } : {}),
            ...(doctorNodeRange && validRange(doctorNodeRange)
              ? { nodeCompatible: satisfies(process.version, doctorNodeRange) }
              : {}),
          },
          metro,
          compatibility,
        },
      ];
    });
}

export function expoReadinessFindings(
  inspections: readonly ExpoProjectInspection[],
): HealthFinding[] {
  const findings: HealthFinding[] = [];
  for (const inspection of inspections) {
    const finding = (
      kind: string,
      summary: string,
      evidence: string[],
      recommendation: string,
      confidence: HealthFinding['confidence'] = 'reduced',
    ) =>
      findings.push({
        check: 'spec-drift',
        fingerprint: `expo:${kind}:${inspection.project}`,
        state: 'platform-validation',
        confidence,
        summary,
        evidence,
        recommendation,
      });
    const sdk = inspection.installedExpoVersion ?? 'not installed';
    if (inspection.doctor.status === 'not-detected')
      finding(
        'doctor-not-detected',
        `${inspection.project} has no directly configured Expo Doctor check detected.`,
        [
          `${inspection.root}: Expo ${sdk}; declared ${inspection.declaredExpoRange ?? 'not found'}.`,
          'Static configuration inspection did not execute Doctor or assess deployment readiness.',
        ],
        'Configure an app-scoped Expo Doctor target, run it in CI and before cloud builds, and preserve any existing custom validation. A custom wrapper may require manual review.',
      );
    else if (!inspection.doctor.installedVersion)
      finding(
        'doctor-unavailable',
        `${inspection.project} configures Expo Doctor but has no local installation available.`,
        [...inspection.doctor.evidence],
        'Install a pinned Expo Doctor version compatible with the app’s SDK and Node runtime. Megamono does not download validation tools automatically.',
      );
    if (inspection.doctor.nodeCompatible === false)
      finding(
        'doctor-node',
        `${inspection.project} resolves Expo Doctor with an incompatible Node requirement.`,
        [
          `Expo Doctor ${inspection.doctor.installedVersion} requires ${inspection.doctor.nodeRange}; health runs on ${process.version}.`,
        ],
        'Use a supported Node runtime or explicitly select a compatible Expo Doctor version for this app.',
        'complete',
      );
    if (inspection.metro.status === 'direct-internal-import')
      finding(
        'metro-internal-import',
        `${inspection.project} imports @expo/metro-config directly.`,
        [inspection.metro.path ?? inspection.root],
        'Review the Metro config and extend expo/metro-config from the app’s installed Expo SDK; preserve custom resolvers and test native exports.',
      );
    else if (inspection.metro.status === 'custom-unverified')
      finding(
        'metro-unverified',
        `${inspection.project} has a custom Metro config whose Expo defaults could not be verified statically.`,
        [inspection.metro.path ?? inspection.root],
        'Review custom wrappers for preserved Expo defaults and validate real bundle exports. Megamono does not execute Metro configuration during health inspection.',
      );
    if (!inspection.installedExpoVersion)
      finding(
        'sdk-unavailable',
        `${inspection.project} has no installed Expo SDK available for compatibility inspection.`,
        [
          `Declared Expo range: ${inspection.declaredExpoRange ?? 'not found'}.`,
        ],
        'Install the frozen workspace dependencies, then run app-scoped Expo Doctor and bundle validation.',
      );
    for (const dependency of inspection.compatibility.filter(
      ({ compatible }) => !compatible,
    ))
      finding(
        `sdk-${dependency.package}`,
        `${inspection.project} resolves ${dependency.package} outside its installed Expo SDK’s expected range.`,
        [
          `Expo ${sdk}: ${dependency.package} expected ${dependency.expected}, Node package resolution found ${dependency.installed} from ${inspection.root}; Metro resolution was not executed.`,
        ],
        'Use Expo Doctor and expo install --check in this app; preserve separately supported web dependencies and verify Metro bundle isolation.',
        'complete',
      );
    if (
      inspection.installedExpoVersion &&
      valid(inspection.installedExpoVersion) &&
      inspection.configuredSdkVersion &&
      valid(inspection.configuredSdkVersion) &&
      major(inspection.installedExpoVersion) !==
        major(inspection.configuredSdkVersion)
    )
      finding(
        'sdk-config',
        `${inspection.project} configures a different Expo SDK major than it resolves.`,
        [
          `app.json SDK ${inspection.configuredSdkVersion}; installed Expo ${sdk}.`,
        ],
        'Review the app’s SDK configuration with Expo Doctor before building.',
        'complete',
      );
  }
  return findings;
}
