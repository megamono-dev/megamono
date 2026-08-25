import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ProjectConfiguration } from '@nx/devkit';
import {
  projectsFromWranglerConfigs,
  type CloudflareProjectMetadata,
} from './cloudflare';
import type { WranglerConfigRecord } from './wrangler-config';

function record(
  root: string,
  config: WranglerConfigRecord['config'],
  executable = true,
): WranglerConfigRecord {
  return {
    root,
    configPath: `${root}/wrangler.jsonc`,
    config,
    diagnostics: [],
    executable,
  };
}

function projectFrom(
  records: WranglerConfigRecord[],
  workspaceRoot: string,
  root: string,
): ProjectConfiguration {
  const results = projectsFromWranglerConfigs(records, workspaceRoot);
  const project = results
    .flatMap(([, result]) => Object.values(result.projects))
    .find((candidate) => candidate.root === root);
  if (!project) throw new Error(`Missing fixture project ${root}.`);
  return project;
}

describe('projectsFromWranglerConfigs', () => {
  it('uses repository identity while preserving Worker binding identity', async () => {
    const workspaceRoot = await mkdtemp(
      resolve(tmpdir(), 'nx-cloudflare-node-'),
    );
    await mkdir(resolve(workspaceRoot, 'apps/api'), { recursive: true });
    await writeFile(
      resolve(workspaceRoot, 'apps/api/project.json'),
      JSON.stringify({ name: 'acme-api' }),
    );
    const project = projectFrom(
      [
        record('apps/api', {
          name: 'production-api',
          main: 'src/index.ts',
          compatibility_date: '2026-08-23',
          compatibility_flags: ['nodejs_compat'],
          d1_databases: [
            { binding: 'DB', database_name: 'acme', remote: true },
          ],
          dev: { port: 8788 },
          routes: ['api.example.com/*'],
          workers_dev: false,
        }),
      ],
      workspaceRoot,
      'apps/api',
    );
    expect(project).toMatchObject({
      name: 'acme-api',
      projectType: 'application',
      tags: [
        'platform:worker',
        'scope:shared',
        'type:app',
        'visibility:internal',
      ],
    });
    const metadata = project.metadata?.[
      'megamono:cloudflare'
    ] as CloudflareProjectMetadata;
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      configPath: 'apps/api/wrangler.jsonc',
      workerName: 'production-api',
      main: 'src/index.ts',
      compatibilityDate: '2026-08-23',
      compatibilityFlags: ['nodejs_compat'],
      resources: {
        d1_databases: [{ binding: 'DB', resource: 'acme', remote: true }],
      },
      routes: ['api.example.com/*'],
      workersDev: false,
      devPort: 8788,
    });
  });

  it('infers four target contracts and environment configurations but no build', async () => {
    const workspaceRoot = await mkdtemp(
      resolve(tmpdir(), 'nx-cloudflare-target-'),
    );
    const project = projectFrom(
      [
        record('apps/worker', {
          name: 'worker',
          main: 'src/index.ts',
          env: {
            staging: { name: 'worker-staging' },
            production: { name: 'worker-production' },
          },
        }),
      ],
      workspaceRoot,
      'apps/worker',
    );
    expect(project.targets?.['build']).toBeUndefined();
    expect(project.targets?.['dev']).toMatchObject({
      cache: false,
      continuous: true,
      inputs: ['default', '{workspaceRoot}/apps/worker/wrangler.jsonc'],
      options: {
        command: "'wrangler' 'dev' '--config' 'apps/worker/wrangler.jsonc'",
        cwd: '{workspaceRoot}',
      },
      configurations: {
        production: {
          command: expect.stringContaining("'--env=production'"),
        },
        staging: { command: expect.stringContaining("'--env=staging'") },
      },
    });
    expect(project.targets?.['deploy']).toMatchObject({
      cache: false,
    });
    expect(project.targets?.['deploy']).not.toHaveProperty('continuous');
    expect(project.targets?.['typegen']).toMatchObject({
      cache: true,
      outputs: ['{workspaceRoot}/apps/worker/worker-configuration.d.ts'],
    });
    expect(project.targets?.['tail']).toMatchObject({
      cache: false,
      continuous: true,
    });
  });

  it('resolves local and explicitly external references into versioned metadata', async () => {
    const workspaceRoot = await mkdtemp(
      resolve(tmpdir(), 'nx-cloudflare-ref-'),
    );
    const records = [
      record('apps/api', { name: 'api' }),
      record('apps/gateway', {
        name: 'gateway',
        services: [
          { binding: 'API', service: 'api' },
          { binding: 'AUTH', service: 'hosted-auth' },
          { binding: 'MISSING', service: 'missing' },
        ],
      }),
    ];
    const results = projectsFromWranglerConfigs(records, workspaceRoot, {
      externalWorkers: ['hosted-auth'],
    });
    const gateway = results
      .flatMap(([, result]) => Object.values(result.projects))
      .find((project) => project.root === 'apps/gateway');
    const metadata = gateway?.metadata?.[
      'megamono:cloudflare'
    ] as CloudflareProjectMetadata;
    expect(metadata.resolvedWorkers).toEqual([
      expect.objectContaining({ worker: 'api', project: 'api' }),
    ]);
    expect(metadata.externalWorkers).toEqual([
      expect.objectContaining({ worker: 'hosted-auth' }),
    ]);
    expect(metadata.unresolvedWorkers).toEqual([
      expect.objectContaining({ worker: 'missing' }),
    ]);
    expect(gateway?.metadata?.['megamono:preflight']).toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: 'cloudflare-worker-unresolved' }),
      ],
      requiredTools: [{ executable: 'wrangler' }],
    });
    expect(gateway?.targets?.['typegen'].inputs).toContain(
      '{workspaceRoot}/apps/api/wrangler.jsonc',
    );
  });

  it('keeps projects visible but omits targets for invalid configs', async () => {
    const workspaceRoot = await mkdtemp(
      resolve(tmpdir(), 'nx-cloudflare-bad-'),
    );
    const invalid = record('apps/site', undefined, false);
    invalid.diagnostics.push({
      severity: 'error',
      code: 'cloudflare-pages-unsupported',
      message: 'Pages is unsupported.',
      path: invalid.configPath,
    });
    const project = projectFrom([invalid], workspaceRoot, 'apps/site');
    expect(project.targets).toEqual({});
    expect(project.metadata?.['megamono:preflight']).toMatchObject({
      diagnostics: [{ code: 'cloudflare-pages-unsupported' }],
      requiredTools: [],
    });
  });

  it('reports duplicate Worker names without choosing a local reference target', async () => {
    const workspaceRoot = await mkdtemp(
      resolve(tmpdir(), 'nx-cloudflare-dup-'),
    );
    const results = projectsFromWranglerConfigs(
      [
        record('apps/first', { name: 'shared' }),
        record('apps/second', { name: 'shared' }),
        record('apps/caller', {
          name: 'caller',
          services: [{ binding: 'SHARED', service: 'shared' }],
        }),
      ],
      workspaceRoot,
    );
    const projects = results.flatMap(([, result]) =>
      Object.values(result.projects),
    );
    expect(
      projects
        .filter((project) => project.root !== 'apps/caller')
        .map((project) => project.metadata?.['megamono:preflight']),
    ).toEqual([
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: 'cloudflare-worker-name-duplicate',
          }),
        ],
      }),
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: 'cloudflare-worker-name-duplicate',
          }),
        ],
      }),
    ]);
    const callerMetadata = projects.find(
      (project) => project.root === 'apps/caller',
    )?.metadata?.['megamono:cloudflare'] as CloudflareProjectMetadata;
    expect(callerMetadata.resolvedWorkers).toEqual([]);
    expect(callerMetadata.unresolvedWorkers).toHaveLength(1);
  });
});
