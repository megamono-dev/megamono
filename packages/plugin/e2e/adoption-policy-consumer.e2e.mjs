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
  const runtimeSchema = require('@megamono/plugin/schemas/extension-runtime.schema.json');
  assert.equal(runtimeSchema.properties.version.const, 1);
  assert.deepEqual(runtimeSchema.required, [
    'version',
    'renderers',
    'workers',
    'rationale',
    'decision',
  ]);
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

  // Qualify the real packed check executor, including its JSON evidence and
  // decision lookup when repository-wide documentation checks are skipped.
  const runtimeDecision = 'decision-20261110-packed-renderers';
  put(
    'docs/decisions/renderers.md',
    readFileSync(join(root, 'docs/decisions/packed.md'), 'utf8').replaceAll(
      decision,
      runtimeDecision,
    ),
  );
  const runtimeTags = [
    'type:app',
    'scope:shared',
    'platform:extension',
    'visibility:internal',
  ];
  const uiTags = ['type:ui', 'scope:shared', 'platform:web'];
  const contract = {
    version: 1,
    renderers: ['entrypoints/popup/index.html'],
    workers: ['entrypoints/background.ts'],
    rationale: 'Reviewed packed renderer and worker roots',
    decision: runtimeDecision,
  };
  put('apps/extension/package.json', {
    name: '@fixture/extension',
    nx: { tags: runtimeTags },
    megamono: { extension: { runtimeEntries: contract } },
  });
  put(
    'apps/extension/entrypoints/popup/index.html',
    '<script type="module" src="./main.ts"></script>',
  );
  put(
    'apps/extension/entrypoints/popup/main.ts',
    "export {button} from '@fixture/ui';",
  );
  put(
    'apps/extension/entrypoints/background.ts',
    'export const background=true;',
  );
  put('apps/extension/tsconfig.json', {
    compilerOptions: {
      module: 'ESNext',
      moduleResolution: 'Bundler',
      paths: { '@fixture/ui': ['../../libs/ui/src/index.ts'] },
    },
    include: ['entrypoints/**/*.ts'],
  });
  put('libs/ui/package.json', { name: '@fixture/ui', nx: { tags: uiTags } });
  put('libs/ui/src/index.ts', 'export const button=1;');
  const runtimeGraph = {
    nodes: {
      extension: {
        name: 'extension',
        type: 'app',
        data: { root: 'apps/extension', tags: runtimeTags },
      },
      ui: { name: 'ui', type: 'lib', data: { root: 'libs/ui', tags: uiTags } },
    },
    dependencies: {
      extension: [{ source: 'extension', target: 'ui', type: 'static' }],
      ui: [],
    },
  };
  const runtimeConfig = structuredClone(plugin.DEFAULT_MEGAMONO_CONFIG);
  runtimeConfig.adoption.modules = ['lint'];
  put('megamono.json', runtimeConfig);
  put('.megamono/artifacts.json', { schemaVersion: 1, artifacts: [] });
  const executorCollection = JSON.parse(
    readFileSync(join(packageRoot, 'executors.json'), 'utf8'),
  );
  const checkExecutor = require(
    resolve(packageRoot, executorCollection.executors.check.implementation),
  ).default;
  const packedRequire = createRequire(join(packageRoot, 'package.json'));
  const { logger } = packedRequire('@nx/devkit');
  const checkJson = async () => {
    const output = [];
    const original = logger.info;
    logger.info = (message) => output.push(message);
    try {
      const result = await checkExecutor(
        { json: true, skipDocs: true, profile: 'development' },
        { root, projectGraph: runtimeGraph },
      );
      const report = JSON.parse(
        output.find((message) => String(message).trim().startsWith('{')),
      );
      assert.equal(result.success, report.success);
      return report;
    } finally {
      logger.info = original;
    }
  };
  const rendererReport = await checkJson();
  assert.equal(
    rendererReport.success,
    true,
    JSON.stringify(rendererReport.errors),
  );
  assert.equal(rendererReport.extensionRuntime[0].complete, true);
  assert.equal(
    rendererReport.extensionRuntime[0].contract.decision,
    runtimeDecision,
  );
  assert.deepEqual(
    rendererReport.extensionRuntime[0].applied.map(
      ({ target, dependencyKind }) => ({ target, dependencyKind }),
    ),
    [{ target: 'ui', dependencyKind: 'static' }],
  );
  put(
    'apps/extension/entrypoints/background.ts',
    "export {button} from '@fixture/ui';",
  );
  const workerReport = await checkJson();
  assert.equal(workerReport.success, false);
  assert.equal(workerReport.extensionRuntime[0].complete, false);
  assert.deepEqual(workerReport.extensionRuntime[0].applied, []);
  assert(workerReport.errors.some((item) => item.code === 'platform-boundary'));
  put(
    'apps/extension/entrypoints/background.ts',
    'export const background=true;',
  );
  rmSync(join(root, 'docs/decisions/renderers.md'));
  const missingAuthorityReport = await checkJson();
  assert.equal(missingAuthorityReport.success, false);
  assert(
    missingAuthorityReport.errors.some(
      (item) => item.code === 'extension-runtime-policy',
    ),
  );
  console.log(
    `Packed ${manifest.name}@${manifest.version}: clean frozen pnpm install, consumer build, public exports, migration registration, exact allowances, identity replacement and reviewed extension runtime JSON checks passed.`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
