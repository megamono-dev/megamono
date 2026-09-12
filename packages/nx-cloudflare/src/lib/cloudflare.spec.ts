import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DependencyType, type ProjectConfiguration } from '@nx/devkit';
import {
  createNodes,
  dependenciesFromWranglerConfigs,
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
  it('recognizes version metadata at the top level and in environments', async () => {
    const workspaceRoot = await mkdtemp(
      resolve(tmpdir(), 'nx-version-metadata-'),
    );
    const project = projectFrom(
      [
        record('apps/worker', {
          name: 'worker',
          main: 'src/index.ts',
          version_metadata: { binding: 'VERSION' },
          env: {
            production: { version_metadata: { binding: 'PRODUCTION_VERSION' } },
          },
          future_binding: { binding: 'UNKNOWN' },
        }),
      ],
      workspaceRoot,
      'apps/worker',
    );
    expect(project.metadata?.['megamono:cloudflare']).toMatchObject({
      resources: { version_metadata: [{ binding: 'VERSION' }] },
      topLevelBindingFamilies: ['version_metadata'],
      unknownBindingFamilies: ['future_binding'],
      environments: [
        {
          name: 'production',
          bindingFamilies: ['version_metadata'],
          bindingDifferences: ['version_metadata'],
        },
      ],
    });
  });

  it('adapts the Nx 18/19 single-file createNodes contract', async () => {
    const workspaceRoot = await mkdtemp(
      resolve(tmpdir(), 'nx-cloudflare-v1-node-'),
    );
    await mkdir(resolve(workspaceRoot, 'apps/worker'), { recursive: true });
    await writeFile(
      resolve(workspaceRoot, 'apps/worker/wrangler.json'),
      JSON.stringify({ name: 'worker', main: 'src/index.ts' }),
    );
    const singleFileCallback = createNodes[1] as unknown as (
      configFile: string,
      options: Record<string, never>,
      context: { workspaceRoot: string },
    ) => Promise<{ projects: Record<string, ProjectConfiguration> }>;

    const result = await singleFileCallback(
      'apps/worker/wrangler.json',
      {},
      { workspaceRoot },
    );

    expect(Array.isArray(result)).toBe(false);
    expect(result.projects['apps/worker']?.name).toBe('worker');
  });

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
      inferenceStatus: 'ready',
      configPath: 'apps/api/wrangler.jsonc',
      workerName: 'production-api',
      main: 'src/index.ts',
      compatibilityDate: '2026-08-23',
      compatibilityFlags: ['nodejs_compat'],
      resources: {
        d1_databases: [{ binding: 'DB', resource: 'acme', remote: true }],
      },
      topLevelBindingFamilies: ['d1_databases'],
      unknownBindingFamilies: [],
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
      options: {
        command:
          "'wrangler' 'types' 'apps/worker/worker-configuration.d.ts' '--config' 'apps/worker/wrangler.jsonc'",
      },
    });
    expect(project.targets?.['tail']).toMatchObject({
      cache: false,
      continuous: true,
    });
  });

  it('omits continuous target metadata before Nx 21', async () => {
    const workspaceRoot = await mkdtemp(
      resolve(tmpdir(), 'nx-cloudflare-legacy-target-'),
    );
    const results = projectsFromWranglerConfigs(
      [record('apps/worker', { name: 'worker', main: 'src/index.ts' })],
      workspaceRoot,
      {},
      { continuousTargets: false },
    );
    const project = results
      .flatMap(([, result]) => Object.values(result.projects))
      .find((candidate) => candidate.root === 'apps/worker');

    expect(project?.targets?.['dev']).not.toHaveProperty('continuous');
    expect(project?.targets?.['tail']).not.toHaveProperty('continuous');
  });

  it('suppresses repository-owned runtime targets without losing safe inference', async () => {
    const workspaceRoot = await mkdtemp(
      resolve(tmpdir(), 'nx-cloudflare-suppressed-target-'),
    );
    const results = projectsFromWranglerConfigs(
      [record('apps/worker', { name: 'worker', main: 'src/index.ts' })],
      workspaceRoot,
      {
        devTargetName: false,
        deployTargetName: false,
      },
    );
    const project = results
      .flatMap(([, result]) => Object.values(result.projects))
      .find((candidate) => candidate.root === 'apps/worker');

    expect(project?.targets).toEqual({
      typegen: expect.objectContaining({ cache: true }),
      tail: expect.objectContaining({ cache: false, continuous: true }),
    });
    expect(project?.metadata?.['megamono:cloudflare']).toMatchObject({
      workerName: 'worker',
      configPath: 'apps/worker/wrangler.jsonc',
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

describe('dependenciesFromWranglerConfigs', () => {
  function projects(records: WranglerConfigRecord[]) {
    return Object.fromEntries(
      records.map((item) => [
        item.root.replace('apps/', ''),
        { name: item.root.replace('apps/', ''), root: item.root },
      ]),
    ) as Record<string, ProjectConfiguration>;
  }

  it('emits every direct Worker edge and excludes local references without script_name', () => {
    const records = [
      record('apps/api', { name: 'api' }),
      record('apps/state', { name: 'state' }),
      record('apps/workflows', { name: 'workflows' }),
      record('apps/tail', { name: 'tail' }),
      record('apps/caller', {
        name: 'caller',
        services: [{ binding: 'API', service: 'api' }],
        durable_objects: {
          bindings: [
            { name: 'STATE', class_name: 'State', script_name: 'state' },
            { name: 'LOCAL', class_name: 'LocalState' },
          ],
        },
        workflows: [
          {
            binding: 'FLOW',
            name: 'flow',
            class_name: 'Flow',
            script_name: 'workflows',
          },
          { binding: 'LOCAL_FLOW', name: 'local', class_name: 'LocalFlow' },
        ],
        tail_consumers: [{ service: 'tail' }],
      }),
    ];
    expect(dependenciesFromWranglerConfigs(records, projects(records))).toEqual(
      [
        {
          source: 'caller',
          target: 'api',
          sourceFile: 'apps/caller/wrangler.jsonc',
          type: DependencyType.static,
        },
        {
          source: 'caller',
          target: 'state',
          sourceFile: 'apps/caller/wrangler.jsonc',
          type: DependencyType.static,
        },
        {
          source: 'caller',
          target: 'tail',
          sourceFile: 'apps/caller/wrangler.jsonc',
          type: DependencyType.static,
        },
        {
          source: 'caller',
          target: 'workflows',
          sourceFile: 'apps/caller/wrangler.jsonc',
          type: DependencyType.static,
        },
      ],
    );
  });

  it('fans each queue consumer into every local producer', () => {
    const records = [
      record('apps/producer-a', {
        name: 'producer-a',
        queues: { producers: [{ binding: 'EVENTS', queue: 'events' }] },
      }),
      record('apps/producer-b', {
        name: 'producer-b',
        queues: { producers: [{ binding: 'EVENTS', queue: 'events' }] },
      }),
      record('apps/consumer', {
        name: 'consumer',
        queues: { consumers: [{ queue: 'events' }] },
      }),
    ];
    expect(dependenciesFromWranglerConfigs(records, projects(records))).toEqual(
      [
        expect.objectContaining({ source: 'consumer', target: 'producer-a' }),
        expect.objectContaining({ source: 'consumer', target: 'producer-b' }),
      ],
    );
  });

  it('omits self, external, resource, environment-only, ambiguous, and invalid edges', () => {
    const duplicateA = record('apps/duplicate-a', { name: 'duplicate' });
    const duplicateB = record('apps/duplicate-b', { name: 'duplicate' });
    const invalid = record('apps/pages', { name: 'pages' }, false);
    const records = [
      record('apps/caller', {
        name: 'caller',
        services: [
          { binding: 'SELF', service: 'caller' },
          { binding: 'EXTERNAL', service: 'hosted' },
          { binding: 'DUPLICATE', service: 'duplicate' },
          { binding: 'PAGES', service: 'pages' },
        ],
        d1_databases: [{ binding: 'DB', database_id: 'cloudflare-id' }],
        env: {
          production: {
            services: [{ binding: 'ONLY_PROD', service: 'dependency' }],
          },
        },
      }),
      record('apps/dependency', { name: 'dependency' }),
      duplicateA,
      duplicateB,
      invalid,
    ];
    expect(dependenciesFromWranglerConfigs(records, projects(records))).toEqual(
      [],
    );
  });
});
