import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import { addProjectConfiguration } from '@nx/devkit';
import { resolve } from 'node:path';

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
for (const packageName of packageNames) {
  const packageRoot = resolve(
    yalcStore,
    'packages',
    ...packageName.split('/'),
    packageVersion,
  );
  const manifest = await json(
    resolve(packageRoot, 'playstack.integration.json'),
  );
  const packageJson = await readFile(
    resolve(packageRoot, 'package.json'),
    'utf8',
  );
  tree.write(`node_modules/${packageName}/package.json`, packageJson);
  tree.write(
    `node_modules/${packageName}/playstack.integration.json`,
    `${JSON.stringify(manifest)}\n`,
  );
  for (const integration of manifest.integrations) {
    for (const template of integration.templates ?? []) {
      tree.write(
        `node_modules/${packageName}/${template.source}`,
        await readFile(resolve(packageRoot, template.source)),
      );
    }
  }
}

const generatorModule = await import(
  resolve(
    workspaceRoot,
    'packages/plugin/dist/generators/playstack-integrate/playstack-integrate.js',
  )
);
await generatorModule.playstackIntegrateGenerator(tree, {
  packages: packageNames.join(','),
  api: 'apps/api',
  persistence: 'application',
  adoptionMode: 'shadow',
  conditions: JSON.stringify({ 'Stripe is selected': true }),
  decisions: JSON.stringify({
    'auth.transport': 'cross-origin-refresh-cookie',
    'auth.sessionProjection': 'application-session',
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
  plan.files.length === 7,
  `Expected 7 templates, received ${plan.files.length}.`,
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
  `Verified ${plan.files.length} templates from ${packageNames.length} packed Playstack integrations.\n`,
);
