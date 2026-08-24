import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type {
  AppId,
  NormalizedCreateOptions,
  ServiceId,
} from './create-megamono.js';

export interface SpringbarAppIntent {
  app: AppId;
  projectName: string;
  directory: string;
}

export interface SpringbarServiceIntent {
  service: ServiceId;
  version: string;
  dependentApps: AppId[];
}

export interface SpringbarSetupIntent {
  workspaceRoot: string;
  apps: SpringbarAppIntent[];
  services: SpringbarServiceIntent[];
}

export interface SpringbarSetupResult {
  configured: boolean;
  message: string;
  retry?: {
    inspect: {
      tool: 'inspect_candidates';
      arguments: { workspace_root: string };
    };
    setup: {
      tool: 'setup_workspace';
      after: 'inspect_candidates';
      intent: {
        workspace_root: string;
        requested_apps: SpringbarAppIntent[];
        services: SpringbarServiceIntent[];
      };
    };
  };
}

export type SpringbarConfigurator = (
  intent: SpringbarSetupIntent,
) => Promise<SpringbarSetupResult>;

export interface SpringbarCandidate {
  name: string;
  working_dir: string;
  confidence?: number;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

interface ToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

const APP_DIRECTORIES: Record<AppId, string> = {
  web: 'apps/web',
  api: 'apps/api',
  worker: 'apps/worker',
  mobile: 'apps/mobile',
  desktop: 'apps/desktop',
  apple: 'apps/apple',
  site: 'apps/site',
};

const SERVICE_REGISTRY_NAMES: Record<ServiceId, string> = {
  postgres: 'postgres',
  redis: 'redis',
  clickhouse: 'clickhouse',
  typesense: 'typesense',
};

export function createSpringbarIntent(
  options: NormalizedCreateOptions,
  serviceVersions: Readonly<Record<string, string>>,
): SpringbarSetupIntent {
  const apps = options.apps.map((app) => ({
    app,
    projectName: `${options.scope}-${app}`,
    directory: APP_DIRECTORIES[app],
  }));
  const backendApps = options.apps.filter(
    (app): app is AppId => app === 'api' || app === 'worker',
  );
  const dependentApps = backendApps.length > 0 ? backendApps : options.apps;
  const services = options.services.map((service) => {
    const registryName = service === 'postgres' ? 'postgresql' : service;
    const version = serviceVersions[registryName];
    if (!version)
      throw new Error(
        `No tested Springbar service version exists for ${service}.`,
      );
    return { service, version, dependentApps: [...dependentApps] };
  });
  return { workspaceRoot: options.destination, apps, services };
}

export function createSpringbarRetry(
  intent: SpringbarSetupIntent,
  message: string,
): SpringbarSetupResult {
  return {
    configured: false,
    message,
    retry: {
      inspect: {
        tool: 'inspect_candidates',
        arguments: { workspace_root: intent.workspaceRoot },
      },
      setup: {
        tool: 'setup_workspace',
        after: 'inspect_candidates',
        intent: {
          workspace_root: intent.workspaceRoot,
          requested_apps: intent.apps,
          services: intent.services,
        },
      },
    },
  };
}

class McpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly lines;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    this.lines.on('line', (line) => {
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        return;
      }
      if (typeof response.id !== 'number') return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error)
        pending.reject(
          new Error(response.error.message ?? 'Springbar MCP error'),
        );
      else pending.resolve(response.result);
    });
    child.once('error', (error) => this.fail(error));
    child.stdin.once('error', (error) => this.fail(error));
    child.once('exit', (code, signal) => {
      if (this.pending.size > 0) {
        this.fail(
          new Error(
            `Springbar MCP exited ${code === null ? `after signal ${signal ?? 'unknown'}` : `with code ${code}`}.`,
          ),
        );
      }
    });
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Springbar MCP ${method} timed out.`));
      }, 600_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });
  }

  close(): void {
    this.lines.close();
    this.child.stdin.end();
  }
}

function toolPayload(result: unknown): unknown {
  const toolResult = result as ToolResult;
  const text = toolResult.content?.find((item) => item.type === 'text')?.text;
  if (toolResult.isError) throw new Error(text ?? 'Springbar MCP tool failed.');
  if (!text) throw new Error('Springbar MCP returned no text payload.');
  return JSON.parse(text) as unknown;
}

function matchCandidates(
  intent: SpringbarSetupIntent,
  candidates: SpringbarCandidate[],
): Map<AppId, string> {
  const selected = new Map<AppId, string>();
  for (const app of intent.apps) {
    const expectedDirectory = resolve(intent.workspaceRoot, app.directory);
    const matches = candidates.filter((candidate) => {
      const directory = resolve(intent.workspaceRoot, candidate.working_dir);
      return (
        directory === expectedDirectory ||
        candidate.name === app.projectName ||
        candidate.name === app.app
      );
    });
    const exact = matches.filter(
      (candidate) =>
        candidate.name === app.projectName || candidate.name === app.app,
    );
    const resolved =
      exact.length === 1
        ? exact[0]
        : matches.length === 1
          ? matches[0]
          : undefined;
    if (!resolved) {
      throw new Error(
        `Springbar candidate match for ${app.projectName} was ${matches.length === 0 ? 'missing' : 'ambiguous'}.`,
      );
    }
    selected.set(app.app, resolved.name);
  }
  return selected;
}

export function springbarSetupArguments(
  intent: SpringbarSetupIntent,
  candidates: SpringbarCandidate[],
): {
  workspace_root: string;
  candidate_names: string[];
  services: Array<{ service: string; version: string; dependents: string[] }>;
} {
  const selected = matchCandidates(intent, candidates);
  return {
    workspace_root: intent.workspaceRoot,
    candidate_names: intent.apps.map((app) => selected.get(app.app) as string),
    services: intent.services.map((service) => ({
      service: SERVICE_REGISTRY_NAMES[service.service],
      version: service.version,
      dependents: service.dependentApps.map(
        (app) => selected.get(app) as string,
      ),
    })),
  };
}

function springbarBinary(): string {
  const override = process.env['SPRINGBAR_MCP_PATH'];
  if (override) return override;
  const bundled =
    '/Applications/Springbar.app/Contents/Resources/bin/springbar-mcp';
  return existsSync(bundled) ? bundled : 'springbar-mcp';
}

export const configureSpringbarWithMcp: SpringbarConfigurator = async (
  intent,
) => {
  const child = spawn(springbarBinary(), [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  const client = new McpClient(child);
  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'create-megamono', version: '0.0.1' },
    });
    const inspected = toolPayload(
      await client.request('tools/call', {
        name: 'inspect_candidates',
        arguments: { workspace_root: intent.workspaceRoot },
      }),
    ) as { candidates?: SpringbarCandidate[] };
    const setupArguments = springbarSetupArguments(
      intent,
      inspected.candidates ?? [],
    );
    toolPayload(
      await client.request('tools/call', {
        name: 'setup_workspace',
        arguments: setupArguments,
      }),
    );
    return {
      configured: true,
      message: `Springbar configured ${setupArguments.candidate_names.length} app(s) and ${setupArguments.services.length} service(s).`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return createSpringbarRetry(
      intent,
      `Springbar handoff was not applied: ${detail}`,
    );
  } finally {
    client.close();
  }
};
