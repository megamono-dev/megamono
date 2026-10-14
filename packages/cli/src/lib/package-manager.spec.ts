import { describe, expect, it } from 'vitest';
import { PACKAGE_MANAGERS, packageManagerAdapter } from './package-manager.js';

describe('package-manager adapters', () => {
  it('allows pnpm dependency mutations to update the lockfile in CI', () => {
    expect(packageManagerAdapter('pnpm').installArgs()).toEqual([
      'install',
      '--no-frozen-lockfile',
    ]);
  });
  it.each([
    ['npm', ['npm', ['exec', 'nx', '--', 'show', 'projects']]],
    ['pnpm', ['pnpm', ['exec', 'nx', 'show', 'projects']]],
    ['yarn', ['yarn', ['nx', 'show', 'projects']]],
    ['bun', ['bunx', ['nx', 'show', 'projects']]],
  ] as const)('renders %s executable delegation', (manager, expected) => {
    expect(
      packageManagerAdapter(manager).exec('nx', ['show', 'projects']),
    ).toEqual(expected);
  });

  it.each(PACKAGE_MANAGERS)('renders %s dependency operations', (manager) => {
    const adapter = packageManagerAdapter(manager);
    expect(adapter.installArgs()).toContain('install');
    expect(
      adapter.addArgs(['example@1.0.0'], { development: true, exact: true }),
    ).toContain('example@1.0.0');
  });
});
