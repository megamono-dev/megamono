import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

// Exercise built public entry points without running a database migration or
// installing anything into an adopter's workspace.
const workspace = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(workspace, 'package.json'));
const { createTreeWithEmptyWorkspace } = require('@nx/devkit/testing');
const { getProjects, readJson, writeJson } = require('@nx/devkit');
const { createTaskGraph } = require('nx/src/tasks-runner/create-task-graph');
const {
  appGenerator,
  databaseGenerator,
  DEFAULT_MEGAMONO_CONFIG,
  runRepositoryHealth,
} = require(join(workspace, 'packages/plugin/dist/index.js'));
const {
  renderAdoptGenerator,
  parseRenderBlueprint,
  projectsFromRenderBlueprint,
} = require(join(workspace, 'packages/nx-render/dist/index.js'));
const root = mkdtempSync(join(tmpdir(), 'megamono-render-prisma-'));
try {
  const tree = createTreeWithEmptyWorkspace();
  writeJson(tree, 'megamono.json', DEFAULT_MEGAMONO_CONFIG);
  writeJson(tree, 'package.json', {
    name: 'fixture',
    private: true,
    packageManager: 'npm@11.11.0',
    devDependencies: { nx: require('nx/package.json').version },
  });
  await appGenerator(tree, {
    type: 'api',
    name: 'api',
    scope: 'fixture',
    yes: true,
    interactive: false,
    skipInstall: true,
  });
  await databaseGenerator(tree, {
    name: 'primary',
    adapter: 'prisma',
    buildable: true,
    scope: 'fixture',
    yes: true,
    interactive: false,
  });
  const database = readJson(tree, 'megamono.json').databases.primary;
  const api = [...getProjects(tree)].find(
    ([, project]) => project.root === 'apps/api',
  )?.[0];
  assert(api);
  // The real database generator supplies the Playstack artifact destination.
  // Product models/Playstack runtime behavior remain independently qualified.
  const playstack = readJson(tree, 'playstack.json');
  assert.equal(playstack.databases.primary.adapter, 'prisma');
  assert.equal(
    playstack.databases.primary.target,
    'libs/prisma/primary/prisma',
  );
  tree.write(
    'render.services.json',
    JSON.stringify({
      services: [
        {
          type: 'web',
          name: 'api',
          runtime: 'node',
          plan: 'starter',
          startCommand: `npm exec -- nx run ${api}:serve:production`,
          healthCheckPath: '/health',
        },
      ],
    }),
  );
  writeJson(tree, 'render-adoption.json', {
    services: {
      api: { project: api, root: 'apps/api', databases: ['primary'] },
    },
  });
  await renderAdoptGenerator(tree, { serviceProjects: 'render-adoption.json' });
  assert(!tree.exists('render.yaml'));
  const source = tree.read('render.proposed.yaml', 'utf8');
  const parsed = parseRenderBlueprint(source);
  assert.equal(parsed.diagnostics.length, 0);
  assert.match(
    parsed.services[0].preDeployCommand,
    /prisma migrate deploy --schema 'libs\/prisma\/primary\/prisma' --config/,
  );
  assert(!parsed.services[0].buildCommand.includes('migrate'));
  for (const change of tree.listChanges()) {
    if (change.type === 'DELETE') continue;
    mkdirSync(dirname(join(root, change.path)), { recursive: true });
    writeFileSync(join(root, change.path), change.content);
  }
  const inferred = projectsFromRenderBlueprint(
    parsed,
    'render.proposed.yaml',
    root,
    { serviceProjects: { api: { project: api, root: 'apps/api' } } },
  );
  const projects = getProjects(tree);
  const graph = {
    nodes: Object.fromEntries(
      [...projects].map(([name, data]) => [
        name,
        {
          name,
          type: data.projectType === 'application' ? 'app' : 'lib',
          data: {
            ...data,
            ...(name === api
              ? { metadata: inferred['apps/api'].metadata }
              : {}),
          },
        },
      ]),
    ),
    dependencies: Object.fromEntries(
      [...projects].map(([name, data]) => [
        name,
        (data.implicitDependencies ?? []).map((target) => ({
          source: name,
          target,
          type: 'implicit',
        })),
      ]),
    ),
  };
  const tasks = createTaskGraph(graph, {}, [api], ['build'], undefined, {});
  const buildTask = Object.values(tasks.tasks).find(
    (task) => task.target.project === api && task.target.target === 'build',
  );
  assert(buildTask);
  assert(
    tasks.dependencies[buildTask.id].some(
      (id) =>
        tasks.tasks[id].target.project === database.project &&
        tasks.tasks[id].target.target === 'build',
    ),
  );
  assert(
    tasks.dependencies[buildTask.id].some(
      (id) =>
        tasks.tasks[id].target.project === database.project &&
        tasks.tasks[id].target.target === 'generate',
    ),
  );
  assert.equal(inferred['apps/api'].targets['render-pre-deploy'].cache, false);
  const health = async () =>
    (
      await runRepositoryHealth({
        workspaceRoot: root,
        graph,
        config: readJson(tree, 'megamono.json'),
        documents: [],
        checks: ['spec-drift'],
      })
    ).findings.filter(({ fingerprint }) =>
      fingerprint.startsWith('render:prisma-'),
    );
  assert.deepEqual(await health(), []);
  graph.nodes[api].data.metadata[
    'megamono:render'
  ].services[0].preDeployCommand = null;
  assert(
    (await health()).some(({ fingerprint }) =>
      fingerprint.includes('prisma-migrate'),
    ),
  );
  graph.nodes[api].data.targets.build.dependsOn = [];
  assert(
    (await health()).some(({ fingerprint }) =>
      fingerprint.includes('prisma-generate'),
    ),
  );
  console.log(
    'PASS: generated Nest API + Playstack database target + Render proposal, Nx task ordering, and missing-step health regressions. No migrations executed.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
