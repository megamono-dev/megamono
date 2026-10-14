export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface PackageManagerAdapter {
  readonly command: string;
  readonly lockfiles: readonly string[];
  exec(binary: string, args: readonly string[]): string[];
  install(packages?: readonly string[]): string[];
  scaffold(packageName: string, args: readonly string[]): string[];
}

const adapters: Readonly<Record<PackageManager, PackageManagerAdapter>> = {
  npm: {
    command: 'npm',
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    exec: (binary, args) => ['exec', binary, '--', ...args],
    install: (packages = []) =>
      packages.length
        ? ['install', '--save-dev', '--save-exact', ...packages]
        : ['install'],
    scaffold: (packageName, args) => [
      'exec',
      '--yes',
      packageName,
      '--',
      ...args,
    ],
  },
  pnpm: {
    command: 'pnpm',
    lockfiles: ['pnpm-lock.yaml'],
    exec: (binary, args) => ['exec', binary, ...args],
    install: (packages = []) =>
      packages.length
        ? ['add', '--save-dev', '--save-exact', ...packages]
        : ['install', '--no-frozen-lockfile'],
    scaffold: (packageName, args) => ['dlx', packageName, ...args],
  },
  yarn: {
    command: 'yarn',
    lockfiles: ['yarn.lock'],
    exec: (binary, args) => [binary, ...args],
    install: (packages = []) =>
      packages.length ? ['add', '--dev', '--exact', ...packages] : ['install'],
    scaffold: (packageName, args) => [
      'create',
      packageName.replace(/^create-/, ''),
      ...args,
    ],
  },
  bun: {
    command: 'bun',
    lockfiles: ['bun.lock', 'bun.lockb'],
    exec: (binary, args) => ['x', binary, ...args],
    install: (packages = []) =>
      packages.length ? ['add', '--dev', '--exact', ...packages] : ['install'],
    scaffold: (packageName, args) => ['x', packageName, ...args],
  },
};

export function packageManagerAdapter(
  manager: PackageManager,
): PackageManagerAdapter {
  return adapters[manager];
}
