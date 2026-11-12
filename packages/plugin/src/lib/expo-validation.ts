import {
  getProjects,
  readJson,
  updateProjectConfiguration,
  type ProjectConfiguration,
  type TargetConfiguration,
  type Tree,
} from '@nx/devkit';
import { posix } from 'node:path';

export const EXPO_DOCTOR_TARGET = 'expo-doctor';

const buildTargets = new Set([
  'build',
  'export',
  'export-ios',
  'export-android',
  'build-ios',
  'build-android',
  'run-ios',
  'run-android',
]);

export interface ExpoValidationPlan {
  readonly name: string;
  readonly root: string;
  readonly doctorExists: boolean;
  readonly guardedTargets: readonly string[];
  readonly project: ProjectConfiguration;
}

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly expo?: unknown;
  readonly targetDefaults?: Record<
    string,
    TargetConfiguration | readonly TargetConfiguration[]
  >;
  readonly plugins?: readonly (
    | string
    | {
        readonly plugin: string;
        readonly options?: Record<string, string>;
        readonly include?: readonly string[];
        readonly exclude?: readonly string[];
      }
  )[];
}

function manifest(tree: Tree, path: string): Manifest {
  return tree.exists(path) ? readJson<Manifest>(tree, path) : {};
}

function isExpoApp(tree: Tree, project: ProjectConfiguration): boolean {
  const root = project.root;
  const pkg = manifest(tree, posix.join(root, 'package.json'));
  const declared = pkg.dependencies?.expo ?? pkg.devDependencies?.expo;
  const nativeTarget = Object.values(project.targets ?? {}).some((target) =>
    target.executor?.startsWith('@nx/expo:'),
  );
  const appConfig = manifest(tree, posix.join(root, 'app.json')).expo;
  if ((root === '.' || root === '') && !appConfig && !nativeTarget)
    return false;
  if (project.projectType === 'library' && !appConfig && !nativeTarget)
    return false;
  return Boolean(declared || nativeTarget || appConfig);
}

function inferredTargets(
  tree: Tree,
  root: string,
): Record<string, TargetConfiguration> {
  // The maintained Expo plugin infers these commands from the app config. Add
  // only dependency overlays; Nx remains responsible for the actual commands.
  // General glob scopes need the resolved graph supplied by the adoption
  // caller; exact app-config filenames can also be checked in the Tree.
  if (
    !tree.exists(posix.join(root, 'metro.config.js')) ||
    !['app.json', 'app.config.js', 'app.config.ts'].some((file) =>
      tree.exists(posix.join(root, file)),
    )
  )
    return {};
  const plugins = manifest(tree, 'nx.json').plugins ?? [];
  const configs = ['app.json', 'app.config.js', 'app.config.ts']
    .map((file) => posix.join(root, file))
    .filter((file) => tree.exists(file));
  const applicable = plugins.filter((entry) => {
    if (
      (typeof entry === 'string' ? entry : entry.plugin) !== '@nx/expo/plugin'
    )
      return false;
    if (typeof entry === 'string') return true;
    if (entry.exclude?.length) return false;
    return (
      !entry.include ||
      entry.include.some((pattern) => configs.includes(pattern))
    );
  });
  const result: Record<string, TargetConfiguration> = {};
  for (const plugin of applicable) {
    const options = typeof plugin === 'object' ? (plugin.options ?? {}) : {};
    for (const [option, fallback] of [
      ['buildTargetName', 'build'],
      ['exportTargetName', 'export'],
      ['runIosTargetName', 'run-ios'],
      ['runAndroidTargetName', 'run-android'],
    ]) {
      const targetName = options[option] ?? fallback;
      if (targetName === EXPO_DOCTOR_TARGET)
        throw new Error(
          `The Expo ${option} reserves ${EXPO_DOCTOR_TARGET} for a build/export command. Choose a different Expo target name before configuring validation.`,
        );
      const target =
        option === 'exportTargetName'
          ? { command: 'expo export', dependsOn: [`^${targetName}`] }
          : option === 'buildTargetName'
            ? { executor: '@nx/expo:build' }
            : {
                command:
                  option === 'runIosTargetName'
                    ? 'expo run:ios'
                    : 'expo run:android',
              };
      if (
        result[targetName] &&
        JSON.stringify(result[targetName]) !== JSON.stringify(target)
      )
        throw new Error(
          `Conflicting Expo inference policies for ${targetName}; review target names before configuring validation.`,
        );
      result[targetName] = target;
    }
  }
  return result;
}

function localDependencies(
  target: TargetConfiguration,
  projectName: string,
  strict = false,
): string[] {
  return (target.dependsOn ?? []).flatMap((dependency) => {
    let targetName: string;
    if (typeof dependency === 'string') {
      if (dependency.startsWith('^')) return [];
      targetName = dependency.startsWith(`${projectName}:`)
        ? dependency.slice(projectName.length + 1)
        : dependency;
    } else {
      if (dependency.dependencies) return [];
      const projects =
        typeof dependency.projects === 'string'
          ? [dependency.projects]
          : dependency.projects;
      if (
        projects &&
        !projects.includes(projectName) &&
        !projects.includes('self')
      ) {
        if (strict && projects.some((name) => /[*?[\]{}()]/.test(name)))
          throw new Error(
            `${projectName}:${EXPO_DOCTOR_TARGET} uses a project selector in its prerequisites that cannot be checked safely. Use explicit project/target dependencies before configuring Expo validation.`,
          );
        return [];
      }
      targetName = dependency.target;
    }
    if (strict && /[*?[\]{}()]/.test(targetName))
      throw new Error(
        `${projectName}:${EXPO_DOCTOR_TARGET} uses a wildcard target prerequisite (${targetName}) that may create a cycle. Use explicit independent Doctor prerequisites before configuring Expo validation.`,
      );
    return [targetName];
  });
}

function reaches(
  targets: Record<string, TargetConfiguration>,
  start: string,
  destination: string,
  projectName: string,
  seen = new Set<string>(),
): boolean {
  if (start === destination) return true;
  if (seen.has(start)) return false;
  seen.add(start);
  return localDependencies(targets[start] ?? {}, projectName, true).some(
    (dependency) =>
      reaches(targets, dependency, destination, projectName, seen),
  );
}

function targetDefaults(
  tree: Tree,
  name: string,
  target: TargetConfiguration,
): TargetConfiguration {
  const defaults = manifest(tree, 'nx.json').targetDefaults ?? {};
  const executor = target.command ? 'nx:run-commands' : target.executor;
  let selected = executor ? defaults[executor] : undefined;
  selected ??= defaults[name];
  if (!selected) {
    const matching = Object.keys(defaults)
      .filter((pattern) => {
        if (/[[\]{}()]/.test(pattern)) {
          const entries = Array.isArray(defaults[pattern])
            ? defaults[pattern]
            : [defaults[pattern]];
          if (entries.some((entry) => entry?.dependsOn))
            throw new Error(
              `Expo validation cannot safely assess complex targetDefaults pattern ${pattern}. Use explicit target defaults or review the resolved project configuration first.`,
            );
          return false;
        }
        if (!/[*?]/.test(pattern)) return false;
        const regex = pattern
          .split(/([*?])/)
          .map((part) =>
            part === '*'
              ? '.*'
              : part === '?'
                ? '.'
                : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          )
          .join('');
        return new RegExp(`^${regex}$`).test(name);
      })
      .sort((a, b) => b.length - a.length);
    selected = matching.length ? defaults[matching[0]] : undefined;
  }
  if (Array.isArray(selected)) {
    if (selected.some((entry) => 'filter' in entry))
      throw new Error(
        `Expo validation cannot safely assess filtered targetDefaults for ${name}. Configure an explicit independent Doctor target or review the resolved defaults before adopting CI.`,
      );
    return selected.reduce<TargetConfiguration>(
      (merged, entry) => ({ ...merged, ...entry }),
      {},
    );
  }
  return (selected as TargetConfiguration | undefined) ?? {};
}

/** Plan additive validation without loading Metro or changing SDK dependencies. */
export function planExpoValidation(
  tree: Tree,
  resolvedProjects: Readonly<Record<string, ProjectConfiguration>> = {},
  projectNames?: readonly string[],
): ExpoValidationPlan[] {
  return [...getProjects(tree)]
    .filter(
      ([name, project]) =>
        (!projectNames || projectNames.includes(name)) &&
        isExpoApp(tree, {
          ...project,
          targets: { ...project.targets, ...resolvedProjects[name]?.targets },
        }),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, project]) => {
      const targets = { ...project.targets };
      const inferred = inferredTargets(tree, project.root);
      const resolved = resolvedProjects[name]?.targets ?? {};
      const effectiveTargets = Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(inferred),
            ...Object.keys(resolved),
            ...Object.keys(targets),
          ]),
        ].map((target) => {
          const merged = {
            ...inferred[target],
            ...resolved[target],
            ...targets[target],
          };
          return [
            target,
            {
              ...inferred[target],
              ...targetDefaults(tree, target, merged),
              ...resolved[target],
              ...targets[target],
            },
          ];
        }),
      );
      const doctorExists = Boolean(effectiveTargets[EXPO_DOCTOR_TARGET]);
      if (!doctorExists)
        effectiveTargets[EXPO_DOCTOR_TARGET] = {
          ...targetDefaults(tree, EXPO_DOCTOR_TARGET, {
            executor: '@megamono/plugin:expo-doctor',
          }),
          executor: '@megamono/plugin:expo-doctor',
          cache: false,
        };
      const reserved = effectiveTargets[EXPO_DOCTOR_TARGET];
      if (
        /^@nx\/expo:(?:build|export|run|run-ios|run-android)$/.test(
          reserved.executor ?? '',
        ) ||
        /^(?:expo (?:export|run:ios|run:android)|eas build)(?: |$)/.test(
          reserved.command ?? reserved.options?.command ?? '',
        )
      )
        throw new Error(
          `${name}:${EXPO_DOCTOR_TARGET} is a build/export command. Rename it before configuring the independent Expo Doctor validation target.`,
        );
      const guardedTargets = Object.entries(effectiveTargets)
        .filter(
          ([targetName, target]) =>
            buildTargets.has(targetName) ||
            targetName in inferred ||
            /^@nx\/expo:(?:build|export|run|run-ios|run-android)$/.test(
              target.executor ?? '',
            ) ||
            /^(?:expo (?:export|run:ios|run:android)|eas build)(?: |$)/.test(
              target.command ?? target.options?.command ?? '',
            ),
        )
        .map(([target]) => target)
        .filter((target) => target !== EXPO_DOCTOR_TARGET);
      for (const target of guardedTargets) {
        if (reaches(effectiveTargets, EXPO_DOCTOR_TARGET, target, name))
          throw new Error(
            `${name}:${EXPO_DOCTOR_TARGET} depends on ${target}; adding the Expo validation prerequisite would create a cycle. Keep Doctor independent of build/export targets before adopting CI.`,
          );
        if (
          !localDependencies(effectiveTargets[target], name).includes(
            EXPO_DOCTOR_TARGET,
          )
        )
          targets[target] = {
            ...targets[target],
            dependsOn: [
              ...(effectiveTargets[target].dependsOn ?? []),
              EXPO_DOCTOR_TARGET,
            ],
          };
      }
      if (!doctorExists)
        targets[EXPO_DOCTOR_TARGET] = {
          executor: '@megamono/plugin:expo-doctor',
          cache: false,
        };
      return {
        name,
        root: project.root,
        doctorExists,
        guardedTargets,
        project: { ...project, targets },
      };
    });
}

export function wireExpoValidation(
  tree: Tree,
  resolvedProjects?: Readonly<Record<string, ProjectConfiguration>>,
  projectNames?: readonly string[],
): ExpoValidationPlan[] {
  const plan = planExpoValidation(tree, resolvedProjects, projectNames);
  for (const item of plan)
    updateProjectConfiguration(tree, item.name, item.project);
  return plan;
}
