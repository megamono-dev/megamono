import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ProjectConfiguration } from '@nx/devkit';
import {
  createNodes,
  getRenderDiagnostics,
  parseRenderBlueprint,
  projectsFromRenderBlueprint,
  type RenderProjectMetadata,
} from './render';

const blueprint = `
services:
  - type: web
    name: starterpacks-api
    runtime: node
    rootDir: apps/api
    buildCommand: yarn nx run api:build
    startCommand: yarn nx run api:serve:production
    healthCheckPath: /health
    numInstances: 2
    buildFilter:
      paths: [apps/api/**, libs/**, yarn.lock]
    envVars:
      - key: DATABASE_URL
        fromDatabase: { name: primary, property: connectionString }
      - key: REDIS_URL
        fromService: { name: cache, type: keyvalue, property: connectionString }
  - type: worker
    name: firehose
    runtime: node
    rootDir: apps/firehose
    buildCommand: yarn nx run firehose:build
    startCommand: yarn nx run firehose:serve:production
  - type: keyvalue
    name: cache
    maxmemoryPolicy: allkeys-lru
databases:
  - name: primary
`;

describe('Render Blueprint inference', () => {
  it('parses selected services and resources without secret values', () => {
    const parsed = parseRenderBlueprint(blueprint);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.resources).toEqual([
      { name: 'cache', type: 'keyvalue', maxmemoryPolicy: 'allkeys-lru' },
      { name: 'primary', type: 'postgres' },
    ]);
    expect(parsed.services[0]).toMatchObject({
      name: 'firehose',
      type: 'worker',
    });
    expect(parsed.services[1]).toMatchObject({
      name: 'starterpacks-api',
      healthCheckPath: '/health',
      environmentNames: ['DATABASE_URL', 'REDIS_URL'],
      serviceReferences: ['cache'],
      databaseReferences: ['primary'],
      instances: 2,
    });
  });

  it('attaches bounded command targets and metadata to explicit service roots', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'nx-render-'));
    await mkdir(resolve(root, 'apps/api'), { recursive: true });
    await mkdir(resolve(root, 'apps/firehose'), { recursive: true });
    await writeFile(resolve(root, 'apps/api/project.json'), '{"name":"api"}');
    await writeFile(
      resolve(root, 'apps/api/next.config.js'),
      'module.exports={}',
    );
    await writeFile(
      resolve(root, 'apps/firehose/project.json'),
      '{"name":"firehose"}',
    );
    const parsed = parseRenderBlueprint(blueprint);
    const projects = projectsFromRenderBlueprint(parsed, 'render.yaml', root);

    expect(projects['apps/api']).toMatchObject({
      name: 'api',
      root: 'apps/api',
      targets: {
        'render-build': {
          cache: false,
          options: {
            command: 'yarn nx run api:build',
            cwd: '{workspaceRoot}/apps/api',
          },
        },
        'render-start': { continuous: true },
      },
    });
    const metadata = projects['apps/api']?.metadata?.[
      'megamono:render'
    ] as RenderProjectMetadata;
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      blueprintPath: 'render.yaml',
      resources: [{ name: 'cache' }, { name: 'primary' }],
    });
    expect(
      projects['apps/api']?.metadata?.['megamono:preflight'],
    ).toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: 'render-next-isr-shared-cache' }),
      ],
    });
  });

  it('fails closed around unsafe roots, invalid health checks, and implicit root projects', () => {
    const parsed = parseRenderBlueprint(`
services:
  - { type: web, name: unsafe, rootDir: ../outside, healthCheckPath: health }
  - { type: worker, name: dashboard-owned }
`);
    expect(parsed.diagnostics.map(({ code }) => code)).toEqual([
      'render-root-unsafe',
    ]);
    projectsFromRenderBlueprint(parsed, 'render.yaml', '/tmp');
    expect(getRenderDiagnostics()).toContainEqual(
      expect.objectContaining({ code: 'render-service-project-ambiguous' }),
    );
  });

  it('adapts the Nx 18/19 single-file createNodes contract', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'nx-render-node-'));
    await mkdir(resolve(root, 'apps/api'), { recursive: true });
    await writeFile(resolve(root, 'render.yaml'), blueprint);
    await writeFile(
      resolve(root, 'package.json'),
      '{"devDependencies":{"nx":"20.0.0"}}',
    );
    const callback = createNodes[1] as unknown as (
      configFile: string,
      options: Record<string, never>,
      context: { workspaceRoot: string },
    ) => Promise<{ projects: Record<string, ProjectConfiguration> }>;

    const result = await callback('render.yaml', {}, { workspaceRoot: root });

    expect(
      result.projects['apps/api']?.targets?.['render-start'],
    ).not.toHaveProperty('continuous');
  });
});
