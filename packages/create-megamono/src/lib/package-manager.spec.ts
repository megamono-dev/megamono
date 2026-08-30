import { describe, expect, it } from 'vitest';
import { PACKAGE_MANAGERS, packageManagerAdapter } from './package-manager.js';

describe('create package-manager adapters', () => {
  it.each(PACKAGE_MANAGERS)('supports %s end-to-end commands', (manager) => {
    const adapter = packageManagerAdapter(manager);
    expect(adapter.exec('nx', ['show', 'projects'])).toContain('nx');
    expect(adapter.install(['example@1.0.0'])).toContain('example@1.0.0');
    expect(adapter.scaffold('create-nx-workspace@1', ['workspace'])).toContain(
      manager === 'yarn' ? 'nx-workspace@1' : 'create-nx-workspace@1',
    );
    expect(adapter.lockfiles.length).toBeGreaterThan(0);
  });
});
