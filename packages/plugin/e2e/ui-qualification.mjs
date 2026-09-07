import assert from 'node:assert/strict';
import { satisfies } from 'semver';

const combination = (next, chakra, eslint, eslintJs) =>
  Object.freeze({
    next,
    '@chakra-ui/react': chakra,
    typescript: '6.0.3',
    eslint,
    'eslint-config-next': next,
    '@eslint/js': eslintJs,
  });
// Explicit fixture pins, not scaffold defaults or a supported-package matrix.
export const UI_LANES = Object.freeze({
  scaffold: combination('16.1.7', '3.36.1', '9.39.5', '9.39.5'),
  'scaffold-eslint10': combination('16.1.7', '3.36.1', '10.6.0', '10.0.1'),
  'newer-ui': combination('16.3.3', '3.37.0', '9.39.5', '9.39.5'),
  'newer-ui-eslint10': combination('16.3.3', '3.37.0', '10.6.0', '10.0.1'),
});

export function selectLanes(args) {
  if (!args.length) return Object.keys(UI_LANES);
  assert(
    args[0].startsWith('--lanes='),
    'Use --lanes=<comma-separated lane names>.',
  );
  // Nx run-commands may forward a comma-separated option as separate words.
  const names = [
    ...args[0].slice('--lanes='.length).split(','),
    ...args.slice(1),
  ];
  assert(
    names.length &&
      names.every((name) => Object.hasOwn(UI_LANES, name)) &&
      new Set(names).size === names.length,
    'Select distinct known UI lanes.',
  );
  return names;
}

export function selectLane(args, compatibility) {
  assert(
    args.length <= 1 && (!args.length || args[0].startsWith('--lane=')),
    'Use --lane=<name>.',
  );
  const name = args[0]?.slice('--lane='.length) ?? 'scaffold';
  assert(Object.hasOwn(UI_LANES, name), `Unknown UI lane: ${name}`);
  const versions = UI_LANES[name];
  assert.equal(
    UI_LANES.scaffold['@chakra-ui/react'],
    compatibility.scaffoldPackages['@chakra-ui/react'],
    'Update the scaffold qualification lane when Chakra defaults change.',
  );
  assert.equal(
    versions.typescript,
    compatibility.scaffoldPackages.typescript,
    'Update the qualification lanes when TypeScript defaults change.',
  );
  assert(satisfies(versions.typescript, compatibility.toolchains.typescript));
  assert(satisfies(versions.eslint, compatibility.playstackIntegration.eslint));
  return {
    name,
    versions,
    scope: 'generated Next UI fixture only',
    changesScaffoldDefaults: false,
  };
}

export function pinManifest(manifest, versions, root = false) {
  const result = structuredClone(manifest);
  for (const [name, version] of Object.entries(versions)) {
    assert(
      /^\d+\.\d+\.\d+$/.test(version),
      `Qualification requires an exact stable pin: ${name}`,
    );
    if (
      !root &&
      !result.dependencies?.[name] &&
      !result.devDependencies?.[name]
    )
      continue;
    const group = [
      'typescript',
      'eslint',
      'eslint-config-next',
      '@eslint/js',
    ].includes(name)
      ? 'devDependencies'
      : 'dependencies';
    for (const key of ['dependencies', 'devDependencies'])
      if (result[key]) delete result[key][name];
    result[group] = { ...result[group], [name]: version };
  }
  return result;
}

export function qualificationSummary(checks) {
  const status = (id) =>
    checks.find((check) => check.id === id)?.status ?? 'not-run';
  const stages = Object.fromEntries(
    [
      'isolated-artifacts',
      'install-clis',
      'create-workspace',
      'select-version-combination',
      'chakra-plan',
      'chakra-install',
      'app-ui-plan',
      'app-ui-install',
      'integration-plan',
      'integrate-templates',
      'compose-and-preserve-theme',
      'clean-artifact-bootstrap',
      'selected-versions',
      'clean-graph',
      'lint',
      'build',
      'typecheck',
      'browser',
    ].map((id) => [id, status(id)]),
  );
  return {
    status: checks.some((check) => check.status === 'failed')
      ? 'failed'
      : Object.values(stages).every((value) => value === 'passed')
        ? 'qualified'
        : 'incomplete',
    installation: status('clean-artifact-bootstrap'),
    generatedLint: status('lint'),
    stages,
    note: 'A supported ESLint peer range or successful install is not a generated lint-stack qualification. No scaffold support ranges are widened by this report.',
  };
}
