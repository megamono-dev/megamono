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
