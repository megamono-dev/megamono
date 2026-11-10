import { describe, expect, it } from 'vitest';
import { resolveDefaultBranch } from './git-default-branch.js';

function git(values: Record<string, string | undefined>) {
  const calls: string[] = [];
  return {
    calls,
    output: async (args: readonly string[]) => {
      const key = args.join(' ');
      calls.push(key);
      return values[key];
    },
  };
}

describe('CLI default branch discovery', () => {
  it('retains origin HEAD without contacting the remote', async () => {
    const probe = git({
      'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/trunk',
      'check-ref-format refs/heads/trunk': '',
    });
    expect(await resolveDefaultBranch(probe.output)).toBe('trunk');
    expect(probe.calls.some((call) => call.startsWith('ls-remote'))).toBe(
      false,
    );
  });
  it('respects advertised origin HEAD before the local init default', async () => {
    const probe = git({
      'remote get-url origin': 'https://example.test/repository.git',
      'ls-remote --symref origin HEAD':
        'ref: refs/heads/integration\tHEAD\nabc\tHEAD',
      'check-ref-format refs/heads/integration': '',
      'config --get init.defaultBranch': 'main',
    });
    expect(await resolveDefaultBranch(probe.output)).toBe('integration');
    expect(probe.calls).not.toContain('config --get init.defaultBranch');
  });
  it('supports an empty origin using an explicit configured default', async () => {
    const probe = git({
      'remote get-url origin': 'https://example.test/empty.git',
      'ls-remote --symref origin HEAD': '',
      'config --get init.defaultBranch': 'main',
      'check-ref-format refs/heads/main': '',
    });
    expect(await resolveDefaultBranch(probe.output)).toBe('main');
  });
  it('does not invent a default or accept malformed branch configuration', async () => {
    const probe = git({ 'config --get init.defaultBranch': 'invalid..branch' });
    expect(await resolveDefaultBranch(probe.output)).toBeUndefined();
  });
});
