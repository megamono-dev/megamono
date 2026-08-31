import type { Tree } from '@nx/devkit';
import semver = require('semver');

export interface DependencyRequirement {
  readonly name: string;
  readonly range: string;
  readonly installIfMissing?: boolean;
  readonly reason: string;
}

export interface DependencyAssessment extends DependencyRequirement {
  readonly action: 'add' | 'retain' | 'conflict' | 'absent';
  readonly current?: string;
  readonly section?: 'dependencies' | 'devDependencies' | 'peerDependencies';
  readonly message: string;
}

const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
] as const;

function manifest(tree: Tree): Record<string, unknown> {
  try {
    return JSON.parse(tree.read('package.json', 'utf8') ?? '{}') as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

export function assessDependencyRequirements(
  tree: Tree,
  requirements: readonly DependencyRequirement[],
): readonly DependencyAssessment[] {
  const value = manifest(tree);
  return requirements.map((requirement) => {
    const declarations = dependencySections.flatMap((section) => {
      const dependencies = value[section];
      if (
        !dependencies ||
        typeof dependencies !== 'object' ||
        Array.isArray(dependencies)
      )
        return [];
      const current = (dependencies as Record<string, unknown>)[
        requirement.name
      ];
      return typeof current === 'string' ? [{ section, current }] : [];
    });
    if (declarations.length === 0) {
      const action = requirement.installIfMissing ? 'add' : 'absent';
      return {
        ...requirement,
        action,
        message: requirement.installIfMissing
          ? `Add ${requirement.name}@${requirement.range}: ${requirement.reason}`
          : `${requirement.name} is not installed; no compatibility check is required.`,
      };
    }
    if (declarations.length > 1) {
      return {
        ...requirement,
        action: 'conflict',
        message: `${requirement.name} is declared in multiple dependency sections; consolidate it before adoption.`,
      };
    }
    const [{ section, current }] = declarations;
    const currentRange = semver.validRange(current);
    const requiredRange = semver.validRange(requirement.range);
    const compatible =
      currentRange !== null &&
      requiredRange !== null &&
      semver.intersects(currentRange, requiredRange, {
        includePrerelease: true,
      });
    return {
      ...requirement,
      action: compatible ? 'retain' : 'conflict',
      current,
      section,
      message: compatible
        ? `Retain ${requirement.name}@${current} from ${section}; it satisfies ${requirement.range}.`
        : `${requirement.name}@${current} from ${section} is incompatible with required ${requirement.range}: ${requirement.reason}`,
    };
  });
}

export function workspaceInitDependencyRequirements(
  modules: ReadonlySet<string>,
): readonly DependencyRequirement[] {
  return [
    {
      name: 'nx',
      range: '>=17 <24',
      reason: 'Megamono core adoption supports Nx 17 through 23.',
    },
    {
      name: 'typescript',
      range: '>=5.2 <7',
      reason: 'Megamono core adoption supports TypeScript 5.2 through 6.',
    },
    ...(modules.has('lint')
      ? [
          {
            name: 'eslint',
            range: '>=8 <11',
            reason: 'Megamono lint wiring requires a supported ESLint peer.',
          },
        ]
      : []),
    ...(modules.has('docs')
      ? [
          {
            name: '@content-collections/core',
            range: '0.15.2',
            installIfMissing: true,
            reason: 'The repository documentation loader uses this API.',
          },
          {
            name: 'zod',
            range: '>=4.1 <5',
            installIfMissing: true,
            reason: 'Generated repository document schemas use Zod 4.',
          },
        ]
      : []),
  ];
}

export function workspaceInitDependencyAssessments(
  tree: Tree,
  modules: ReadonlySet<string>,
): readonly DependencyAssessment[] {
  return assessDependencyRequirements(
    tree,
    workspaceInitDependencyRequirements(modules),
  );
}
