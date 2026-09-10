import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureSpringbarWorkspace,
  configureSpringbarWithMcp,
  type SpringbarConnection,
} from './springbar.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'megamono-springbar-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function connection(names = ['api']) {
  const call = vi.fn(async (name: string) =>
    name === 'inspect_candidates'
      ? {
          candidates: names.map((name) => ({
            name,
            working_dir: `apps/${name}`,
          })),
        }
      : {},
  );
  const connect: SpringbarConnection = (operation) => operation(call);
  return { call, connect };
}

describe('Springbar optional setup', () => {
  it('qualifies the real stdio connector without a live daemon or service startup', async () => {
    const workspaceRoot = await fixture();
    const binary = join(workspaceRoot, 'springbar-mcp');
    const log = join(workspaceRoot, 'calls.jsonl');
    await writeFile(
      binary,
      `#!${process.execPath}
const { createInterface } = require('node:readline');
const { appendFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(request) + '\\n');
  let payload = {};
  if (request.params?.name === 'inspect_candidates') payload = { candidates: [{ name: 'api', working_dir: 'apps/api' }] };
  if (request.params?.name === 'setup_workspace') writeFileSync(join(request.params.arguments.workspace_root, 'springbar.toml'), '# Springbar-owned fixture\\n', { flag: 'wx' });
  const result = request.method === 'initialize' ? {} : { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`,
    );
    await chmod(binary, 0o755);
    vi.stubEnv('SPRINGBAR_MCP_PATH', binary);
    expect(
      await configureSpringbarWorkspace({ workspaceRoot, dryRun: true }),
    ).toMatchObject({ exitCode: 0, configured: false });
    await expect(
      readFile(join(workspaceRoot, 'springbar.toml')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await configureSpringbarWorkspace({ workspaceRoot })).toMatchObject({
      exitCode: 0,
      configured: true,
    });
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      calls
        .filter((call) => call.method === 'tools/call')
        .map((call) => call.params.name),
    ).toEqual(['inspect_candidates', 'inspect_candidates', 'setup_workspace']);
    expect(await readFile(join(workspaceRoot, 'springbar.toml'), 'utf8')).toBe(
      '# Springbar-owned fixture\n',
    );
    expect(await configureSpringbarWorkspace({ workspaceRoot })).toMatchObject({
      exitCode: 0,
      configured: false,
    });
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(
      calls.length,
    );
  });
  it('inspects only in dry-run mode, without registration or setup', async () => {
    const workspaceRoot = await fixture();
    const { call, connect } = connection();
    expect(
      await configureSpringbarWorkspace(
        { workspaceRoot, dryRun: true },
        connect,
      ),
    ).toMatchObject({
      exitCode: 0,
      configured: false,
      plan: { candidate_names: ['api'], services: [] },
    });
    expect(call.mock.calls.map(([name]) => name)).toEqual([
      'inspect_candidates',
    ]);
  });

  it('requires explicit selection when multiple launch targets are discovered', async () => {
    const workspaceRoot = await fixture();
    const { call, connect } = connection(['api', 'web', 'worker']);
    expect(
      await configureSpringbarWorkspace({ workspaceRoot }, connect),
    ).toMatchObject({ exitCode: 4, configured: false });
    expect(call).toHaveBeenCalledTimes(1);
    expect(
      await configureSpringbarWorkspace(
        { workspaceRoot, candidateNames: ['api', 'web'] },
        connect,
      ),
    ).toMatchObject({ exitCode: 0, configured: true });
    expect(call).toHaveBeenLastCalledWith('setup_workspace', {
      workspace_root: workspaceRoot,
      candidate_names: ['api', 'web'],
      services: [],
    });
    // Never provision/start units or synthesize commands, ports, or credentials.
    expect(
      call.mock.calls.every(([name]) =>
        ['inspect_candidates', 'setup_workspace'].includes(name),
      ),
    ).toBe(true);
  });

  it.each([{ names: [] }, { names: ['api'] }])(
    'rejects missing or unknown candidates: %j',
    async ({ names }) => {
      const { call, connect } = connection(names);
      expect(
        await configureSpringbarWorkspace(
          { workspaceRoot: await fixture(), candidateNames: ['unknown'] },
          connect,
        ),
      ).toMatchObject({ exitCode: 4 });
      expect(call).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses duplicate candidate identities', async () => {
    const { call, connect } = connection(['api', 'api']);
    expect(
      await configureSpringbarWorkspace(
        { workspaceRoot: await fixture(), candidateNames: ['api'] },
        connect,
      ),
    ).toMatchObject({ exitCode: 3 });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('preserves existing config bytes without contacting Springbar, including create', async () => {
    const workspaceRoot = await fixture();
    const config = '# app-owned custom config\n';
    await writeFile(join(workspaceRoot, 'springbar.toml'), config);
    const { call, connect } = connection();
    expect(
      await configureSpringbarWorkspace({ workspaceRoot }, connect),
    ).toMatchObject({ exitCode: 0, configured: false });
    expect(call).not.toHaveBeenCalled();
    expect(
      await configureSpringbarWithMcp({
        workspaceRoot,
        apps: [],
        services: [],
      }),
    ).toMatchObject({ configured: false });
    expect(await readFile(join(workspaceRoot, 'springbar.toml'), 'utf8')).toBe(
      config,
    );
  });

  it('preserves a config created during inspection', async () => {
    const workspaceRoot = await fixture();
    const call = vi.fn(async () => {
      await writeFile(join(workspaceRoot, 'springbar.toml'), '# preserve');
      return { candidates: [{ name: 'api', working_dir: 'apps/api' }] };
    });
    expect(
      await configureSpringbarWorkspace({ workspaceRoot }, (operation) =>
        operation(call),
      ),
    ).toMatchObject({ exitCode: 0, configured: false });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('does not follow or overwrite a dangling config symlink', async () => {
    const workspaceRoot = await fixture();
    await symlink('missing.toml', join(workspaceRoot, 'springbar.toml'));
    const { call, connect } = connection();
    expect(
      await configureSpringbarWorkspace({ workspaceRoot }, connect),
    ).toMatchObject({ exitCode: 0, configured: false });
    expect(call).not.toHaveBeenCalled();
  });

  it('reports an actionable unavailable-MCP failure without writing a fallback config', async () => {
    const connect: SpringbarConnection = async () => {
      throw new Error('unavailable');
    };
    expect(
      await configureSpringbarWorkspace(
        { workspaceRoot: await fixture() },
        connect,
      ),
    ).toMatchObject({
      exitCode: 3,
      configured: false,
      message: expect.stringContaining('retry megamono add springbar'),
    });
  });
});
