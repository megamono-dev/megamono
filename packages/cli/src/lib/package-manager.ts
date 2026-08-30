export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface PackageManagerAdapter {
  readonly name: PackageManager;
  readonly lockfiles: readonly string[];
  readonly minimumVersion: readonly [major: number, minor: number];
  readonly maximumMajorExclusive: number;
  exec(
    binary: string,
    args: readonly string[],
  ): readonly [string, readonly string[]];
  installArgs(): readonly string[];
  addArgs(
    packages: readonly string[],
    options?: { readonly development?: boolean; readonly exact?: boolean },
  ): readonly string[];
}

const adapters: Readonly<Record<PackageManager, PackageManagerAdapter>> = {
  npm: {
    name: 'npm',
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    minimumVersion: [9, 0],
    maximumMajorExclusive: 12,
    exec: (binary, args) => ['npm', ['exec', binary, '--', ...args]],
    installArgs: () => ['install'],
    addArgs: (packages, options = {}) => [
      'install',
      ...(options.development ? ['--save-dev'] : []),
      ...(options.exact ? ['--save-exact'] : []),
      ...packages,
    ],
  },
  pnpm: {
    name: 'pnpm',
    lockfiles: ['pnpm-lock.yaml'],
    minimumVersion: [8, 0],
    maximumMajorExclusive: 12,
    exec: (binary, args) => ['pnpm', ['exec', binary, ...args]],
    installArgs: () => ['install'],
    addArgs: (packages, options = {}) => [
      'add',
      ...(options.development ? ['--save-dev'] : []),
      ...(options.exact ? ['--save-exact'] : []),
      ...packages,
    ],
  },
  yarn: {
    name: 'yarn',
    lockfiles: ['yarn.lock'],
    minimumVersion: [1, 22],
    maximumMajorExclusive: 5,
    exec: (binary, args) => ['yarn', [binary, ...args]],
    installArgs: () => ['install'],
    addArgs: (packages, options = {}) => [
      'add',
      ...(options.development ? ['--dev'] : []),
      ...(options.exact ? ['--exact'] : []),
      ...packages,
    ],
  },
  bun: {
    name: 'bun',
    lockfiles: ['bun.lock', 'bun.lockb'],
    minimumVersion: [1, 1],
    maximumMajorExclusive: 2,
    exec: (binary, args) => ['bunx', [binary, ...args]],
    installArgs: () => ['install'],
    addArgs: (packages, options = {}) => [
      'add',
      ...(options.development ? ['--dev'] : []),
      ...(options.exact ? ['--exact'] : []),
      ...packages,
    ],
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
