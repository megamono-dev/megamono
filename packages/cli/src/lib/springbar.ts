import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

export interface SpringbarAppIntent {
  app: string;
  name: string;
  projectName: string;
  directory: string;
}

export interface SpringbarServiceIntent {
  service: string;
  version: string;
  dependentApps: string[];
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

const SERVICE_REGISTRY_NAMES: Record<string, string> = {
  postgres: 'postgres',
  redis: 'redis',
  clickhouse: 'clickhouse',
  typesense: 'typesense',
};

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
      }, 30_000);
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
    this.fail(new Error('Springbar MCP connection closed.'));
    this.lines.close();
    this.child.stdin.end();
    this.child.kill();
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
): Map<string, string> {
  const selected = new Map<string, string>();
  for (const app of intent.apps) {
    const expectedDirectory = resolve(intent.workspaceRoot, app.directory);
    const matches = candidates.filter((candidate) => {
      const directory = resolve(intent.workspaceRoot, candidate.working_dir);
      return (
        directory === expectedDirectory ||
        candidate.name === app.projectName ||
        candidate.name === app.name
      );
    });
    const exact = matches.filter(
      (candidate) =>
        candidate.name === app.projectName || candidate.name === app.name,
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
    selected.set(app.name, resolved.name);
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
    candidate_names: intent.apps.map((app) => selected.get(app.name) as string),
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
  if (hasSpringbarConfig(intent.workspaceRoot)) {
    return {
      configured: false,
      message:
        'Existing springbar.toml preserved; manage updates with Springbar.',
    };
  }
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
    if (hasSpringbarConfig(intent.workspaceRoot)) {
      return {
        configured: false,
        message:
          'Existing springbar.toml preserved; manage updates with Springbar.',
      };
    }
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

function hasSpringbarConfig(root: string): boolean {
  try {
    // Even a dangling symlink is application-owned, not an empty destination.
    lstatSync(resolve(root, 'springbar.toml'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export interface SpringbarWorkspaceOptions {
  workspaceRoot: string;
  candidateNames?: readonly string[];
  dryRun?: boolean;
}

export interface SpringbarWorkspaceResult {
  exitCode: 0 | 3 | 4;
  configured: boolean;
  message: string;
  candidates?: SpringbarCandidate[];
  plan?: { workspace_root: string; candidate_names: string[]; services: [] };
}

export type SpringbarToolCaller = (
  name: string,
  args: unknown,
) => Promise<unknown>;
export type SpringbarConnection = <T>(
  operation: (call: SpringbarToolCaller) => Promise<T>,
) => Promise<T>;

async function connectSpringbar<T>(
  operation: (call: SpringbarToolCaller) => Promise<T>,
): Promise<T> {
  const client = new McpClient(
    spawn(springbarBinary(), [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    }),
  );
  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'megamono', version: '0.0.1' },
    });
    return await operation(async (name, args) =>
      toolPayload(
        await client.request('tools/call', { name, arguments: args }),
      ),
    );
  } finally {
    client.close();
  }
}

/** Delegate command/cwd/port/dependency discovery and manifest validation to Springbar. */
export async function configureSpringbarWorkspace(
  options: SpringbarWorkspaceOptions,
  connect: SpringbarConnection = connectSpringbar,
): Promise<SpringbarWorkspaceResult> {
  const preserved = (): SpringbarWorkspaceResult => ({
    exitCode: 0,
    configured: false,
    message:
      'Existing springbar.toml preserved; manage updates with Springbar.',
  });
  try {
    if (hasSpringbarConfig(options.workspaceRoot)) return preserved();
    return await connect(async (call): Promise<SpringbarWorkspaceResult> => {
      const inspected = (await call('inspect_candidates', {
        workspace_root: options.workspaceRoot,
      })) as { candidates?: SpringbarCandidate[] };
      const candidates = inspected.candidates ?? [];
      if (
        candidates.some(
          (candidate) =>
            !candidate ||
            typeof candidate.name !== 'string' ||
            typeof candidate.working_dir !== 'string',
        ) ||
        new Set(candidates.map((candidate) => candidate.name)).size !==
          candidates.length
      ) {
        throw new Error(
          'Springbar returned invalid or duplicate candidate identities.',
        );
      }
      const names = options.candidateNames?.length
        ? [...new Set(options.candidateNames)]
        : candidates.length === 1
          ? [candidates[0].name]
          : [];
      if (
        names.length === 0 ||
        names.some(
          (name) => !candidates.some((candidate) => candidate.name === name),
        )
      ) {
        return {
          exitCode: 4,
          configured: false,
          candidates,
          message:
            'Select explicit Springbar candidates with --springbar-candidates=<name,...>. No configuration was written.',
        };
      }
      const plan = {
        workspace_root: options.workspaceRoot,
        candidate_names: names,
        services: [] as [],
      };
      if (hasSpringbarConfig(options.workspaceRoot)) return preserved();
      if (options.dryRun)
        return {
          exitCode: 0,
          configured: false,
          candidates,
          plan,
          message:
            'Springbar setup preview only; no files, registrations, packages, or services changed.',
        };
      await call('setup_workspace', plan);
      return {
        exitCode: 0,
        configured: true,
        plan,
        message:
          'Springbar configuration created. No services were started. Review springbar.toml before running Springbar.',
      };
    });
  } catch (error) {
    return {
      exitCode: 3,
      configured: false,
      message: `Springbar setup did not complete: ${error instanceof Error ? error.message : String(error)}. Ensure Springbar and its MCP server are available, then retry megamono add springbar. Inspect springbar.toml before retrying after a lost response.`,
    };
  }
}
