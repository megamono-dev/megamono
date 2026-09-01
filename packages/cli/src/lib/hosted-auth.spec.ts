import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostedAuthOperations, type HostedAuthOptions } from './hosted-auth.js';

const fixtures: string[] = [];

function modules(): NonNullable<HostedAuthOptions['loadModules']> {
  return async () => ({
    createLoopbackLauncher: () => ({
      redirectUri: async () => 'http://127.0.0.1:43117/callback',
    }),
    createFetchTokenTransport: () => ({}),
    createClientAuth: ({ storage }) => ({
      async authorize() {
        const tokens = {
          accessToken: 'A'.repeat(43),
          refreshToken: 'B'.repeat(43),
          accessExpiresAt: Date.now() + 60_000,
          refreshExpiresAt: Date.now() + 120_000,
          tokenType: 'Bearer' as const,
          scope: ['profile', 'accounts:read', 'accounts:write'],
        };
        await storage.save(tokens);
        return tokens;
      },
      async accessToken() {
        const tokens = await storage.load();
        if (!tokens) throw new Error('Not authenticated');
        return tokens.accessToken;
      },
      async signOut() {
        await storage.clear();
      },
    }),
  });
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('hosted auth operations', () => {
  it('stores Playstack tokens per service and replaces them on account switch', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'megamono-hosted-auth-'));
    fixtures.push(configHome);
    let activeAccount: string | null = null;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/oauth/profile')) {
        return Response.json({
          user: { id: 'user-1', email: 'developer@megamono.test' },
          account: activeAccount ? { id: activeAccount, role: 'owner' } : null,
          accounts: [
            { id: 'personal-1', name: 'Personal', slug: 'personal', role: 'owner' },
            { id: 'commune-1', name: 'Commune', slug: 'commune', role: 'member' },
          ],
        });
      }
      if (url.endsWith('/api/oauth/accounts/switch')) {
        activeAccount = JSON.parse(String(init?.body)).accountId;
        return Response.json({
          access_token: 'C'.repeat(43),
          refresh_token: 'D'.repeat(43),
          token_type: 'Bearer',
          expires_in: 60,
          refresh_expires_in: 120,
          scope: 'profile accounts:read accounts:write',
        });
      }
      return new Response(null, { status: 404 });
    });
    const auth = createHostedAuthOperations({
      configHome,
      fetch: fetcher as typeof fetch,
      open: vi.fn(),
      loadModules: modules(),
    });

    const login = await auth.login('https://app.megamono.test');
    expect(login.accounts).toHaveLength(2);
    expect(login.account).toBeNull();
    const switched = await auth.switchAccount(
      'https://app.megamono.test',
      'commune-1',
    );
    expect(switched.account?.id).toBe('commune-1');

    const credentials = JSON.parse(
      await readFile(join(configHome, 'credentials.json'), 'utf8'),
    );
    expect(
      credentials.profiles['https://app.megamono.test'].accessToken,
    ).toBe('C'.repeat(43));

    await auth.logout('https://app.megamono.test');
    await expect(auth.profile('https://app.megamono.test')).resolves.toBeNull();
  });

  it('rejects insecure non-loopback service URLs before loading Playstack', async () => {
    const loadModules = vi.fn(modules());
    const auth = createHostedAuthOperations({
      open: vi.fn(),
      loadModules,
    });

    await expect(auth.profile('http://app.megamono.test')).rejects.toThrow(
      'must use HTTPS',
    );
    expect(loadModules).not.toHaveBeenCalled();
  });
});
