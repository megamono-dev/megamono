export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface PackageManagerAdapter {
  readonly name: PackageManager;
  readonly lockfiles: readonly string[];
  readonly frozenInstall: string;
  readonly install: string;
  readonly nx: string;
  readonly runPrefix: string;
  readonly minimumVersion: readonly [major: number, minor: number];
  readonly maximumMajorExclusive: number;
  exec(executable: string, args?: readonly string[]): string;
  workspaceDependency(version: string): string;
}

const adapters: Readonly<Record<PackageManager, PackageManagerAdapter>> = {
  npm: {
    name: 'npm',
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    frozenInstall: 'npm ci',
    install: 'npm install',
    nx: 'npm exec nx --',
    runPrefix: 'npm run',
    minimumVersion: [9, 0],
    maximumMajorExclusive: 12,
    exec: (executable, args = []) =>
      `npm exec ${executable} --${args.length ? ` ${args.join(' ')}` : ''}`,
    workspaceDependency: (version) => version,
  },
  pnpm: {
    name: 'pnpm',
    lockfiles: ['pnpm-lock.yaml'],
    frozenInstall: 'pnpm install --frozen-lockfile',
    install: 'pnpm install --no-frozen-lockfile',
    nx: 'pnpm exec nx',
    runPrefix: 'pnpm run',
    minimumVersion: [8, 0],
    maximumMajorExclusive: 12,
    exec: (executable, args = []) =>
      `pnpm exec ${executable}${args.length ? ` ${args.join(' ')}` : ''}`,
    workspaceDependency: (version) => `workspace:${version}`,
  },
  yarn: {
    name: 'yarn',
    lockfiles: ['yarn.lock'],
    frozenInstall: 'yarn install --immutable',
    install: 'yarn install',
    nx: 'yarn nx',
    runPrefix: 'yarn run',
    minimumVersion: [1, 22],
    maximumMajorExclusive: 5,
    exec: (executable, args = []) =>
      `yarn ${executable}${args.length ? ` ${args.join(' ')}` : ''}`,
    workspaceDependency: (version) => version,
  },
  bun: {
    name: 'bun',
    lockfiles: ['bun.lock', 'bun.lockb'],
    frozenInstall: 'bun install --frozen-lockfile',
    install: 'bun install',
    nx: 'bunx nx',
    runPrefix: 'bun run',
    minimumVersion: [1, 1],
    maximumMajorExclusive: 2,
    exec: (executable, args = []) =>
      `bunx ${executable}${args.length ? ` ${args.join(' ')}` : ''}`,
    workspaceDependency: (version) => version,
  },
};

export function packageManagerAdapter(
  manager: PackageManager,
): PackageManagerAdapter {
  return adapters[manager];
}

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

export function lockfileManagers(
  exists: (path: string) => boolean,
): PackageManager[] {
  return PACKAGE_MANAGERS.filter((manager) =>
    packageManagerAdapter(manager).lockfiles.some(exists),
  );
}

export function preferredLockfile(manager: PackageManager): string {
  return packageManagerAdapter(manager).lockfiles[0];
}

export function packageManagerExec(
  manager: PackageManager,
  executable: string,
  args: readonly string[] = [],
): {
  readonly command: string;
  readonly args: readonly string[];
  readonly display: string;
} {
  const invocation: readonly [string, readonly string[]] =
    manager === 'npm'
      ? ['npm', ['exec', executable, '--', ...args]]
      : manager === 'pnpm'
        ? ['pnpm', ['exec', executable, ...args]]
        : manager === 'yarn'
          ? ['yarn', [executable, ...args]]
          : ['bun', ['x', executable, ...args]];
  return {
    command: invocation[0],
    args: invocation[1],
    display: [invocation[0], ...invocation[1]].join(' '),
  };
}
