import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '../../..');
const sourceRequire = createRequire(join(workspace, 'package.json'));
const root = mkdtempSync(join(tmpdir(), 'megamono-adoption-policy-consumer-'));
const pnpmCli = process.env.npm_execpath;
assert(pnpmCli, 'Run through pnpm exec nx.');
const env = { ...process.env, NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false' };
delete env.NODE_PATH;
for (const key of Object.keys(env))
  if (
    key.startsWith('NX_') &&
    !['NX_DAEMON', 'NX_ISOLATE_PLUGINS'].includes(key)
  )
    delete env[key];
const pnpm = (args, cwd = root) =>
  execFileSync(process.execPath, [pnpmCli, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 240000,
    maxBuffer: 8_000_000,
  });
const put = (path, data) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof data === 'string' ? data : JSON.stringify(data, null, 2),
  );
};
try {
  const tarball = join(root, 'plugin.tgz');
  pnpm(['pack', '--out', tarball], join(workspace, 'packages/plugin'));
  put('package.json', {
    name: 'megamono-adoption-policy-consumer',
    private: true,
    devDependencies: {
      '@megamono/plugin': 'file:./plugin.tgz',
      ...Object.fromEntries(
        ['nx', '@nx/devkit', 'typescript', 'eslint'].map((name) => [
          name,
          sourceRequire(`${name}/package.json`).version,
        ]),
      ),
    },
  });
  put('pnpm-workspace.yaml', 'packages: []\nautoInstallPeers: false\n');
  pnpm(['install', '--ignore-scripts', '--no-frozen-lockfile']);
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  pnpm(['install', '--ignore-scripts', '--frozen-lockfile']);
  assert.equal(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), lock);
  const require = createRequire(join(root, 'package.json'));
  const plugin = require('@megamono/plugin');
  const eslint = require('@megamono/plugin/eslint');
  assert.equal(
    typeof (eslint.default ?? eslint).withBoundaryAllowances,
    'function',
  );
  const manifest = require('@megamono/plugin/package.json');
  const packageRoot = dirname(require.resolve('@megamono/plugin/package.json'));
  const collection = JSON.parse(
    readFileSync(join(packageRoot, 'generators.json'), 'utf8'),
  );
  assert(
    collection.generators['adoption-policy'],
    'Packed migration must be registered.',
  );
  const factory = collection.generators['adoption-policy'].factory;
  assert.equal(
    typeof require(resolve(packageRoot, factory)).default,
    'function',
  );
  const schema = require('@megamono/plugin/schemas/megamono.schema.json');
  assert.deepEqual(schema.properties.version.enum, [1, 2]);
  put('nx.json', {});
  put('project.json', {
    name: 'policy-consumer',
    targets: {
      build: {
        executor: 'nx:run-commands',
        options: {
          command: 'node node_modules/typescript/bin/tsc -p tsconfig.json',
        },
      },
    },
  });
  put('tsconfig.json', {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      rootDir: 'src',
      outDir: 'dist',
    },
    include: ['src/**/*.ts'],
  });
  put(
    'src/index.ts',
    `import { dependencyIdentityKey, type DependencyFindingIdentity } from '@megamono/plugin';
export function reviewedKey(identity: DependencyFindingIdentity): string { return dependencyIdentityKey(identity); }
`,
  );
  pnpm(['exec', 'nx', 'run', 'policy-consumer:build', '--output-style=static']);

  const graph = {
    nodes: Object.fromEntries(
      ['source', 'target', 'replacement'].map((name) => [
        name,
        {
          name,
          type: 'lib',
          data: {
            root: `libs/${name}`,
            tags: [
              `type:${name === 'source' ? 'ui' : 'data'}`,
              'scope:shared',
              'platform:node',
            ],
          },
        },
      ]),
    ),
    dependencies: {
      source: [{ source: 'source', target: 'target', type: 'static' }],
      target: [],
      replacement: [],
    },
  };
  const config = structuredClone(plugin.DEFAULT_MEGAMONO_CONFIG);
  config.version = 2;
  config.adoption.modules = ['lint'];
  config.conventions.rules['module-boundaries'] = { severity: 'warning' };
  const analysis = await plugin.analyzeWorkspaceStructure(root, graph, config);
  const finding = analysis.diagnostics.find((item) => item.identity);
  assert(finding, 'Packed checker must emit structured warning identities.');
  config.adoption.warningBaseline = {
    identityVersion: 1,
    rules: ['module-boundaries'],
    entries: [
      {
        identity: finding.identity,
        reason: 'Reviewed fixture debt',
        reviewReference: 'fixture-review',
        revision: 'a'.repeat(40),
      },
    ],
  };
  assert.equal(
    plugin.evaluateIdentityBaseline(analysis.diagnostics, config).errors.length,
    0,
  );
  graph.dependencies.source = [
    { source: 'source', target: 'replacement', type: 'static' },
  ];
  const replacement = await plugin.analyzeWorkspaceStructure(
    root,
    graph,
    config,
  );
  const baseline = plugin.evaluateIdentityBaseline(
    replacement.diagnostics,
    config,
  );
  assert.equal(baseline.new.length, 1);
  assert.equal(baseline.resolved.length, 1);
  assert.equal(
    baseline.errors.length,
    2,
    'Equal warning counts must not admit a replacement identity.',
  );

  graph.dependencies.source = [
    { source: 'source', target: 'target', type: 'static' },
  ];
  delete config.adoption.warningBaseline;
  const decision = 'decision-20261105-packed-consumer';
  put(
    'docs/decisions/packed.md',
    `---\n${Object.entries({
      id: decision,
      type: 'decision',
      status: 'accepted',
      visibility: 'internal',
      projects: ['source', 'target'],
      topics: [],
      summary: 'Reviewed packed fixture',
      date: '2026-11-05',
      supersedes: null,
      references: [],
      external_references: [],
    })
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n')}\n---\nReviewed.\n`,
  );
  config.conventions.boundaryAllowances = [
    {
      source: 'source',
      target: 'target',
      constraint: finding.identity.constraint,
      classification: finding.identity.classification,
      rationale: 'Reviewed exact fixture relationship',
      decision,
    },
  ];
  const allowed = await plugin.analyzeWorkspaceStructure(root, graph, config);
  assert.equal(allowed.allowed.length, 1);
  assert.equal(allowed.diagnostics.filter((item) => item.identity).length, 0);
  graph.nodes.source.data.tags = ['type:ui', 'scope:shared', 'platform:web'];
  const drifted = await plugin.analyzeWorkspaceStructure(root, graph, config);
  assert(
    drifted.diagnostics.some(
      (item) => item.code === 'boundary-allowance-invalid',
    ),
  );
  assert(drifted.diagnostics.some((item) => item.code === 'platform-boundary'));
  console.log(
    `Packed ${manifest.name}@${manifest.version}: clean frozen pnpm install, consumer build, public exports, migration registration, exact allowances and identity replacement checks passed.`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
