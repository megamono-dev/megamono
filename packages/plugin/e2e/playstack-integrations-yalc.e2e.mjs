import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { addProjectConfiguration } from '@nx/devkit';
import { resolve } from 'node:path';
import { minVersion } from 'semver';

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, '../../..');
const packageVersion = '0.1.0-beta.1';
const packageNames = [
  '@playstack/nest-auth',
  '@playstack/nest-billing',
  '@playstack/webhooks',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const { stdout } = await execFileAsync('yalc', ['dir']);
const yalcStore = stdout.trim();
const playstackRoot = resolve(
  yalcStore,
  'packages',
  '@playstack',
  'cli',
  packageVersion,
);
const sourceSchema = await json(
  resolve(playstackRoot, 'playstack.integration.schema.json'),
);
const consumerSchema = await json(
  resolve(
    workspaceRoot,
    'packages/plugin/schemas/playstack-integration.schema.json',
  ),
);
assert(
  JSON.stringify(sourceSchema) === JSON.stringify(consumerSchema),
  'Megamono integration schema has drifted from the packed Playstack contract.',
);

const tree = createTreeWithEmptyWorkspace();
addProjectConfiguration(tree, 'api', {
  root: 'apps/api',
  projectType: 'application',
});
const staged = new Set();
async function stagePackage(packageName) {
  if (staged.has(packageName)) return;
  staged.add(packageName);
  const packageRoot = resolve(
    yalcStore,
    'packages',
    ...packageName.split('/'),
    packageVersion,
  );
  async function copy(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory())
        await copy(resolve(directory, entry.name), `${path}/`);
      else if (entry.isFile())
        tree.write(
          `node_modules/${packageName}/${path}`,
          await readFile(resolve(directory, entry.name)),
        );
      else throw new Error(`Unexpected packed symlink: ${path}`);
    }
  }
  await copy(packageRoot);
  const metadata = await json(resolve(packageRoot, 'package.json'));
  for (const name of Object.keys(metadata.dependencies ?? {}))
    if (name.startsWith('@playstack/')) await stagePackage(name);
  for (const [name, range] of Object.entries(metadata.peerDependencies ?? {})) {
    if (metadata.peerDependenciesMeta?.[name]?.optional) continue;
    if (name.startsWith('@playstack/')) await stagePackage(name);
    else {
      // This is a virtual manifest/templating contract test, not an external-peer
      // install or runtime test. Real clean installs have a separate fixture.
      const version = minVersion(range)?.version;
      assert(version, `No fixture version satisfies ${name}@${range}.`);
      if (!tree.exists(`node_modules/${name}/package.json`))
        tree.write(
          `node_modules/${name}/package.json`,
          JSON.stringify({ name, version }),
        );
    }
  }
}
for (const name of packageNames) await stagePackage(name);

const generatorModule = await import(
  resolve(
    workspaceRoot,
    'packages/plugin/dist/generators/playstack-integrate/playstack-integrate.js',
  )
);
await generatorModule.playstackIntegrateGenerator(tree, {
  packages: packageNames.join(','),
  api: 'apps/api',
  adapters: 'stripe',
  persistence: 'application',
  adoptionMode: 'shadow',
  conditions: JSON.stringify({ 'Stripe is selected': true }),
  decisions: JSON.stringify({
    'auth.transport': 'cross-origin-refresh-cookie',
    'auth.sessionProjection': 'application-session',
    'auth.credentialDelivery':
      'fixture-owned mail transport and templates; not provider-qualified',
    'auth.registration':
      'fixture-owned transactional account provisioning; not database-qualified',
    'billing.priceCatalog': 'application-plan-registry',
    'webhooks.providers': 'stripe:default',
  }),
  yes: true,
});

const plan = JSON.parse(
  tree.read('.megamono/playstack-integration-plan.json', 'utf8') ?? '{}',
);
assert(plan.unresolvedConditions.length === 0, 'Conditions remain unresolved.');
assert(plan.unresolvedDecisions.length === 0, 'Decisions remain unresolved.');
assert(
  plan.preflight.conflicts.length === 0,
  'Manifest requirements conflict.',
);
assert(
  plan.files.length === 9,
  `Expected 9 templates, received ${plan.files.length}.`,
);
assert(
  plan.commitBoundaries.length === 3,
  `Expected 3 commit boundaries, received ${plan.commitBoundaries.length}.`,
);
for (const file of plan.files) {
  assert(
    tree.exists(file.target),
    `Integration output ${file.target} is missing.`,
  );
}

process.stdout.write(
  `Verified ${plan.files.length} templates from ${packageNames.length} packed Playstack integrations in a virtual tree (external-peer metadata is synthetic; no runtime qualification).\n`,
);

// Requirements-only packages are valid, but must never look like qualified
// generated wiring. Use real published manifests, not invented templates.
const requirementsOnlyPackages = [
  '@playstack/nest-storage',
  '@playstack/cache-next',
];
for (const name of requirementsOnlyPackages) await stagePackage(name);
addProjectConfiguration(tree, 'site', {
  root: 'apps/site',
  projectType: 'application',
});
for (const cacheComponents of [false, true]) {
  await generatorModule.playstackIntegrateGenerator(tree, {
    packages: requirementsOnlyPackages.join(','),
    api: 'apps/api',
    web: 'apps/site',
    conditions: JSON.stringify({
      'on-demand revalidation is exposed': true,
      'more than one Next.js process serves the deployment': true,
      'Next.js 16 cache components are enabled': cacheComponents,
    }),
    yes: true,
  });
  const coverage = JSON.parse(
    tree.read('.megamono/playstack-integration-plan.json', 'utf8'),
  );
  assert(
    coverage.files.length === 0,
    'Storage/cache now publish templates: replace this pending gate with emitted consumer compilation/runtime fixtures.',
  );
  assert(
    coverage.readiness.verification === 'not-run',
    'Planning must not qualify application behavior.',
  );
  for (const pkg of coverage.readiness.packages) {
    assert(pkg.manifest === 'available', `Missing manifest for ${pkg.package}`);
    for (const integration of pkg.integrations) {
      assert(
        integration.templates === 'none-selected',
        'Requirements-only integration must disclose missing templates.',
      );
      assert(
        integration.wiring === 'application-owned',
        'Missing templates must retain application-owned wiring.',
      );
    }
  }
  const storage = coverage.requirements.find(
    (record) => record.package === '@playstack/nest-storage',
  );
  assert(
    storage.requirements.healthChecks.some(
      (check) => check.id === 'storage.provider',
    ),
    'Named storage readiness requirement was lost.',
  );
  const caches = coverage.requirements.filter(
    (record) => record.package === '@playstack/cache-next',
  );
  assert(
    caches.some((record) => record.id === 'next-incremental-cache'),
    'Incremental cache contract missing.',
  );
  assert(
    caches.some((record) => record.id === 'next-cache-components') ===
      cacheComponents,
    'Cache Components requirements must respect explicit selection.',
  );
  assert(
    coverage.readiness.limitations.some((message) =>
      message.includes('no active templates'),
    ),
    'Missing-wiring limitation must be explicit.',
  );
}
process.stdout.write(
  'Real storage/cache manifest planning passed for both cache selections. Generated composition qualification remains BLOCKED: these artifacts publish no templates. No storage/cache runtime tests ran.\n',
);
