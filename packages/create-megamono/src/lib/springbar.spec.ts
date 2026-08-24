import { normalizeCreateOptions } from './create-megamono.js';
import {
  configureSpringbarWithMcp,
  createSpringbarIntent,
  springbarSetupArguments,
  type SpringbarCandidate,
} from './springbar.js';

function options(apps: string[], services: string[] = ['postgres']) {
  return normalizeCreateOptions({
    name: 'Acme',
    apps,
    services,
    serviceRunner: 'springbar',
    cwd: '/workspace',
    platform: 'darwin',
  });
}

describe('createSpringbarIntent', () => {
  it('binds services to API and worker backends when present', () => {
    expect(
      createSpringbarIntent(options(['web', 'worker', 'api']), {
        postgresql: '17',
      }),
    ).toEqual({
      workspaceRoot: '/workspace/acme',
      apps: [
        { app: 'api', projectName: 'acme-api', directory: 'apps/api' },
        { app: 'web', projectName: 'acme-web', directory: 'apps/web' },
        { app: 'worker', projectName: 'acme-worker', directory: 'apps/worker' },
      ],
      services: [
        {
          service: 'postgres',
          version: '17',
          dependentApps: ['api', 'worker'],
        },
      ],
    });
  });

  it('binds services to all selected apps when no backend exists', () => {
    const intent = createSpringbarIntent(options(['site', 'web']), {
      postgresql: '17',
    });
    expect(intent.services[0]?.dependentApps).toEqual(['site', 'web']);
  });
});

describe('springbarSetupArguments', () => {
  it('uses inspected candidate names and emits the atomic setup payload', () => {
    const intent = createSpringbarIntent(options(['api', 'web']), {
      postgresql: '17',
    });
    const candidates: SpringbarCandidate[] = [
      { name: 'api-server', working_dir: '/workspace/acme/apps/api' },
      { name: 'web-ui', working_dir: 'apps/web' },
      { name: 'unrequested', working_dir: 'apps/other' },
    ];
    expect(springbarSetupArguments(intent, candidates)).toEqual({
      workspace_root: '/workspace/acme',
      candidate_names: ['api-server', 'web-ui'],
      services: [
        {
          service: 'postgres',
          version: '17',
          dependents: ['api-server'],
        },
      ],
    });
  });

  it('refuses ambiguous candidate matches instead of guessing', () => {
    const intent = createSpringbarIntent(options(['web'], []), {});
    expect(() =>
      springbarSetupArguments(intent, [
        { name: 'serve-web', working_dir: 'apps/web' },
        { name: 'preview-web', working_dir: 'apps/web' },
      ]),
    ).toThrow('ambiguous');
  });
});

describe('configureSpringbarWithMcp', () => {
  it('returns a retryable result when the MCP executable is unavailable', async () => {
    const previous = process.env['SPRINGBAR_MCP_PATH'];
    process.env['SPRINGBAR_MCP_PATH'] = '/definitely/missing/springbar-mcp';
    try {
      const intent = createSpringbarIntent(options(['web'], []), {});
      await expect(configureSpringbarWithMcp(intent)).resolves.toMatchObject({
        configured: false,
        message: expect.stringContaining('ENOENT'),
        retry: {
          inspect: { tool: 'inspect_candidates' },
          setup: { tool: 'setup_workspace' },
        },
      });
    } finally {
      if (previous === undefined) delete process.env['SPRINGBAR_MCP_PATH'];
      else process.env['SPRINGBAR_MCP_PATH'] = previous;
    }
  });
});
