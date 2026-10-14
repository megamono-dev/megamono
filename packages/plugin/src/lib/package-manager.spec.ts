import { describe, expect, it } from 'vitest';
import {
  PACKAGE_MANAGERS,
  lockfileManagers,
  packageManagerAdapter,
} from './package-manager';

describe('plugin package-manager adapters', () => {
  it('distinguishes pnpm dependency mutations from frozen CI installs', () => {
    const adapter = packageManagerAdapter('pnpm');
    expect(adapter.install).toBe('pnpm install --no-frozen-lockfile');
    expect(adapter.frozenInstall).toBe('pnpm install --frozen-lockfile');
  });
  it.each(PACKAGE_MANAGERS)('defines the complete %s contract', (manager) => {
    const adapter = packageManagerAdapter(manager);
    expect(adapter.install).toMatch(/^(npm|pnpm|yarn|bun) install/);
    expect(adapter.frozenInstall).toMatch(/(?:install|ci)/);
    expect(adapter.nx).toContain('nx');
    expect(adapter.lockfiles.length).toBeGreaterThan(0);
  });

  it('collapses multiple lockfile formats owned by the same manager', () => {
    const files = new Set(['bun.lock', 'bun.lockb']);
    expect(lockfileManagers((path) => files.has(path))).toEqual(['bun']);
  });
});
