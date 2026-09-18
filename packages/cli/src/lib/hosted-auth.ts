import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface HostedAccount {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: string;
}

export interface HostedProfile {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly name?: string;
  };
  readonly account: { readonly id: string; readonly role: string } | null;
  readonly accounts: readonly HostedAccount[];
}

export interface HostedAuthOperations {
  login(serviceUrl: string): Promise<HostedProfile>;
  profile(serviceUrl: string): Promise<HostedProfile | null>;
  logout(serviceUrl: string): Promise<void>;
  switchAccount(serviceUrl: string, accountId: string): Promise<HostedProfile>;
  submitFeedback(
    serviceUrl: string,
    payload: unknown,
  ): Promise<{ readonly id?: string; readonly url?: string }>;
}

export const DEFAULT_HOSTED_API_URL = 'https://api.megamono.com';

interface ClientTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt?: number;
  readonly tokenType: 'Bearer';
  readonly scope?: readonly string[];
}

interface TokenStorage {
  load(): Promise<ClientTokenSet | null>;
  save(tokens: ClientTokenSet): Promise<void>;
  clear(): Promise<void>;
}

interface ClientAuth {
  authorize(): Promise<ClientTokenSet>;
  accessToken(options?: { readonly forceRefresh?: boolean }): Promise<string>;
  signOut(): Promise<void>;
}

interface ClientAuthModules {
  createClientAuth(options: {
    readonly clientId: string;
    readonly authorizationEndpoint: string;
    readonly redirectUri: string;
    readonly scopes: readonly string[];
    readonly transport: unknown;
    readonly storage: TokenStorage;
    readonly launcher?: unknown;
  }): ClientAuth;
  createFetchTokenTransport(options: {
    readonly tokenEndpoint: string;
    readonly revocationEndpoint: string;
    readonly fetch: typeof globalThis.fetch;
  }): unknown;
  createLoopbackLauncher(options: {
    readonly open: (authorizationUrl: string) => Promise<void>;
    readonly callbackPath: '/callback';
  }): {
    redirectUri(): Promise<string>;
  };
}

interface CredentialDocument {
  readonly version: 1;
  readonly profiles: Readonly<Record<string, ClientTokenSet>>;
}

export interface HostedAuthOptions {
  readonly configHome?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly open: (authorizationUrl: string) => Promise<void>;
  readonly loadModules?: () => Promise<ClientAuthModules>;
}

const CLIENT_ID = 'megamono-cli';
const SCOPES = [
  'profile',
  'accounts:read',
  'accounts:write',
  'adoption:read',
  'adoption:write',
] as const;

function configDirectory(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.MEGAMONO_CONFIG_HOME) return process.env.MEGAMONO_CONFIG_HOME;
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'megamono');
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'megamono');
  }
  return join(homedir(), '.config', 'megamono');
}

function serviceOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Megamono service URL: ${value}`);
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Megamono service URLs must use HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Megamono service URLs cannot include credentials or query data',
    );
  }
  return url.origin;
}

function tokenSet(value: unknown, now = Date.now()): ClientTokenSet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The Megamono service returned an invalid token response');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.access_token !== 'string' ||
    typeof record.refresh_token !== 'string' ||
    record.token_type !== 'Bearer' ||
    typeof record.expires_in !== 'number' ||
    !Number.isSafeInteger(record.expires_in) ||
    record.expires_in <= 0
  ) {
    throw new Error('The Megamono service returned an invalid token response');
  }
  const refreshExpiresIn = record.refresh_expires_in;
  return {
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    accessExpiresAt: now + record.expires_in * 1_000,
    ...(typeof refreshExpiresIn === 'number'
      ? { refreshExpiresAt: now + refreshExpiresIn * 1_000 }
      : {}),
    tokenType: 'Bearer',
    ...(typeof record.scope === 'string'
      ? { scope: record.scope.split(' ').filter(Boolean) }
      : {}),
  };
}

function parseProfile(value: unknown): HostedProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The Megamono service returned an invalid profile');
  }
  const record = value as Record<string, unknown>;
  const user = record.user as Record<string, unknown> | undefined;
  if (
    !user ||
    typeof user.id !== 'string' ||
    typeof user.email !== 'string' ||
    !Array.isArray(record.accounts)
  ) {
    throw new Error('The Megamono service returned an invalid profile');
  }
  const accounts = record.accounts.map((candidate) => {
    const account = candidate as Record<string, unknown>;
    if (
      typeof account.id !== 'string' ||
      typeof account.name !== 'string' ||
      typeof account.slug !== 'string' ||
      typeof account.role !== 'string'
    ) {
      throw new Error('The Megamono service returned an invalid account');
    }
    return {
      id: account.id,
      name: account.name,
      slug: account.slug,
      role: account.role,
    };
  });
  const active = record.account as Record<string, unknown> | null | undefined;
  if (
    active !== null &&
    active !== undefined &&
    (typeof active.id !== 'string' || typeof active.role !== 'string')
  ) {
    throw new Error('The Megamono service returned an invalid active account');
  }
  return {
    user: {
      id: user.id,
      email: user.email,
      ...(typeof user.name === 'string' ? { name: user.name } : {}),
    },
    account:
      active && typeof active.id === 'string' && typeof active.role === 'string'
        ? { id: active.id, role: active.role }
        : null,
    accounts,
  };
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const message = body.error_description ?? body.message ?? body.error;
    if (typeof message === 'string') return new Error(message);
  } catch {
    // Fall through to the status-only error.
  }
  return new Error(`Megamono service returned HTTP ${response.status}`);
}

async function defaultModules(): Promise<ClientAuthModules> {
  if (Number.parseInt(process.versions.node.split('.')[0] ?? '', 10) < 20) {
    throw new Error(
      'Hosted authentication requires Node.js 20 or newer; repository commands remain available on Node.js 18.18.',
    );
  }
  try {
    const packageName = '@playstack/client-auth';
    const loopbackName = '@playstack/client-auth/loopback';
    const [client, loopback] = await Promise.all([
      import(packageName),
      import(loopbackName),
    ]);
    return {
      createClientAuth:
        client.createClientAuth as ClientAuthModules['createClientAuth'],
      createFetchTokenTransport:
        client.createFetchTokenTransport as ClientAuthModules['createFetchTokenTransport'],
      createLoopbackLauncher:
        loopback.createLoopbackLauncher as ClientAuthModules['createLoopbackLauncher'],
    };
  } catch (cause) {
    throw new Error(
      'Hosted authentication requires @playstack/client-auth. Install it alongside @megamono/cli and retry.',
      { cause },
    );
  }
}

export function createHostedAuthOperations(
  options: HostedAuthOptions,
): HostedAuthOperations {
  const fetcher = options.fetch ?? globalThis.fetch;
  const credentialPath = join(
    configDirectory(options.configHome),
    'credentials.json',
  );
  const loadModules = options.loadModules ?? defaultModules;

  async function readCredentials(): Promise<CredentialDocument> {
    try {
      const parsed = JSON.parse(
        await readFile(credentialPath, 'utf8'),
      ) as CredentialDocument;
      if (
        parsed.version === 1 &&
        parsed.profiles &&
        typeof parsed.profiles === 'object'
      ) {
        return parsed;
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    return { version: 1, profiles: {} };
  }

  async function writeCredentials(document: CredentialDocument): Promise<void> {
    await mkdir(dirname(credentialPath), { recursive: true, mode: 0o700 });
    const temporary = `${credentialPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, credentialPath);
  }

  function storage(origin: string): TokenStorage {
    return {
      async load() {
        return (await readCredentials()).profiles[origin] ?? null;
      },
      async save(tokens) {
        const current = await readCredentials();
        await writeCredentials({
          version: 1,
          profiles: { ...current.profiles, [origin]: tokens },
        });
      },
      async clear() {
        const current = await readCredentials();
        const profiles = { ...current.profiles };
        delete profiles[origin];
        await writeCredentials({ version: 1, profiles });
      },
    };
  }

  async function client(
    serviceUrl: string,
    interactive = false,
  ): Promise<{
    readonly origin: string;
    readonly auth: ClientAuth;
    readonly storage: TokenStorage;
  }> {
    const origin = serviceOrigin(serviceUrl);
    const modules = await loadModules();
    const tokenStorage = storage(origin);
    const launcher = interactive
      ? modules.createLoopbackLauncher({
          open: options.open,
          callbackPath: '/callback',
        })
      : undefined;
    const redirectUri = launcher
      ? await launcher.redirectUri()
      : 'http://127.0.0.1/callback';
    return {
      origin,
      storage: tokenStorage,
      auth: modules.createClientAuth({
        clientId: CLIENT_ID,
        authorizationEndpoint: `${origin}/oauth/authorize`,
        redirectUri,
        scopes: SCOPES,
        transport: modules.createFetchTokenTransport({
          tokenEndpoint: `${origin}/api/oauth/token`,
          revocationEndpoint: `${origin}/api/oauth/revoke`,
          fetch: fetcher,
        }),
        storage: tokenStorage,
        ...(launcher ? { launcher } : {}),
      }),
    };
  }

  async function authenticatedProfile(
    origin: string,
    auth: ClientAuth,
  ): Promise<HostedProfile> {
    let response = await fetcher(`${origin}/api/oauth/profile`, {
      headers: { authorization: `Bearer ${await auth.accessToken()}` },
    });
    if (response.status === 401) {
      response = await fetcher(`${origin}/api/oauth/profile`, {
        headers: {
          authorization: `Bearer ${await auth.accessToken({ forceRefresh: true })}`,
        },
      });
    }
    if (!response.ok) throw await responseError(response);
    return parseProfile(await response.json());
  }

  return {
    async login(serviceUrl) {
      const current = await client(serviceUrl, true);
      await current.auth.authorize();
      return authenticatedProfile(current.origin, current.auth);
    },
    async profile(serviceUrl) {
      const current = await client(serviceUrl);
      if (!(await current.storage.load())) return null;
      return authenticatedProfile(current.origin, current.auth);
    },
    async logout(serviceUrl) {
      const current = await client(serviceUrl);
      await current.auth.signOut();
    },
    async switchAccount(serviceUrl, accountId) {
      const current = await client(serviceUrl);
      const response = await fetcher(
        `${current.origin}/api/oauth/accounts/switch`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await current.auth.accessToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ accountId }),
        },
      );
      if (!response.ok) throw await responseError(response);
      await current.storage.save(tokenSet(await response.json()));
      return authenticatedProfile(current.origin, current.auth);
    },
    async submitFeedback(serviceUrl, payload) {
      const current = await client(serviceUrl);
      const response = await fetcher(`${current.origin}/feedback`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await current.auth.accessToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw await responseError(response);
      const value = (await response.json()) as Record<string, unknown>;
      return {
        ...(typeof value.id === 'string' ? { id: value.id } : {}),
        ...(typeof value.url === 'string' ? { url: value.url } : {}),
      };
    },
  };
}
