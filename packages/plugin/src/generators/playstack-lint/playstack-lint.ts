import {
  addDependenciesToPackageJson,
  formatFiles,
  logger,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { compatiblePlaystackPackageVersion } from '../../lib/emissions';
import { appendEslintFlatConfig } from '../../lib/eslint-flat-config';
import {
  PlaystackWorkspaceIntegrationError,
  assertInitializedMegamonoWorkspace,
  assertPlaystackProductInstalled,
  assertPlaystackWorkspaceCompatibility,
  declaredRootDevelopmentDependency,
  retainedLocalPackageVersion,
} from '../playstack-workspace';
import type { PlaystackLintGeneratorSchema } from './schema';
import { format } from 'prettier';

const importsStart = '// megamono playstack lint imports start';
const importsEnd = '// megamono playstack lint imports end';
const configStart = '  // megamono playstack lint config start';
const configEnd = '  // megamono playstack lint config end';
const importsBody = `
import { configs as playstackLintConfigs } from '@playstack/lint';

const playstackLintWarnings = (config) => ({
  ...config,
  rules: Object.fromEntries(
    Object.entries(config.rules ?? {}).map(([id, value]) => [
      id,
      Array.isArray(value) ? ['warn', ...value.slice(1)] : 'warn',
    ]),
  ),
});
`;

function configBody(preset: 'recommended' | 'all'): string {
  return `
  playstackLintWarnings(playstackLintConfigs.${preset}),
`;
}

function section(
  source: string,
  start: string,
  end: string,
): string | undefined {
  const starts = source.split(start).length - 1;
  const ends = source.split(end).length - 1;
  if (starts !== ends || starts > 1) {
    throw new PlaystackWorkspaceIntegrationError(
      `eslint.config.mjs has malformed ${start} delimiters.`,
    );
  }
  if (starts === 0) return undefined;
  const from = source.indexOf(start) + start.length;
  return source.slice(from, source.indexOf(end, from));
}

async function plannedLintConfig(
  original: string,
  preset: 'recommended' | 'all',
): Promise<string | undefined> {
  const currentImports = section(original, importsStart, importsEnd);
  const currentConfig = section(original, configStart, configEnd);
  // Compare formatted syntax, not consumer-owned quote/semicolon/indent choices.
  // Keep comments and actual expressions in the comparison so edits still fail.
  const canonical = (source: string) =>
    format(source, {
      parser: 'babel',
      semi: true,
      singleQuote: true,
      trailingComma: 'all',
    });
  const importsMatch =
    currentImports !== undefined &&
    (await canonical(currentImports)) === (await canonical(importsBody));
  if (currentImports !== undefined && !importsMatch) {
    throw new PlaystackWorkspaceIntegrationError(
      'The managed Playstack lint import section was modified; preserve it and resolve the conflict explicitly.',
    );
  }
  const canonicalConfig = (body: string) =>
    canonical(`export default [${body}]`);
  const validConfigBodies = await Promise.all(
    [configBody('recommended'), configBody('all')].map(canonicalConfig),
  );
  const normalizedConfig =
    currentConfig === undefined
      ? undefined
      : await canonicalConfig(currentConfig);
  if (
    currentConfig !== undefined &&
    (normalizedConfig === undefined ||
      !validConfigBodies.includes(normalizedConfig))
  ) {
    throw new PlaystackWorkspaceIntegrationError(
      'The managed Playstack lint config section was modified; preserve it and resolve the conflict explicitly.',
    );
  }
  if ((currentImports === undefined) !== (currentConfig === undefined)) {
    throw new PlaystackWorkspaceIntegrationError(
      'eslint.config.mjs has partial Playstack lint wiring.',
    );
  }
  if (
    importsMatch &&
    normalizedConfig === (await canonicalConfig(configBody(preset)))
  ) {
    return undefined;
  }

  let source = original;
  if (currentImports === undefined) {
    source = `${importsStart}${importsBody}${importsEnd}\n\n${source}`;
  }
  if (currentConfig === undefined) {
    const updated = appendEslintFlatConfig(
      source,
      `${configStart}${configBody(preset)}${configEnd}`,
    );
    if (updated === undefined) {
      throw new PlaystackWorkspaceIntegrationError(
        'eslint.config.mjs must export a flat config array before Playstack lint can be wired.',
      );
    }
    source = updated;
  } else {
    source = source.replace(
      `${configStart}${currentConfig}${configEnd}`,
      `${configStart}${configBody(preset)}${configEnd}`,
    );
  }
  return source;
}

export async function playstackLintGenerator(
  tree: Tree,
  options: PlaystackLintGeneratorSchema,
): Promise<GeneratorCallback | void> {
  assertInitializedMegamonoWorkspace(tree);
  const products = assertPlaystackProductInstalled(tree);
  assertPlaystackWorkspaceCompatibility(tree, { eslint: true });
  const preset = options.preset ?? 'recommended';
  if (!['recommended', 'all'].includes(preset)) {
    throw new PlaystackWorkspaceIntegrationError(
      'preset must be recommended or all.',
    );
  }
  const source = tree.read('eslint.config.mjs', 'utf8');
  if (!source) {
    throw new PlaystackWorkspaceIntegrationError(
      'eslint.config.mjs is missing; initialize the Megamono lint module first.',
    );
  }
  // Resolve the complete file plan before a dependency or config mutation.
  const plannedConfig = await plannedLintConfig(source, preset);

  logger.info(`# Playstack lint plan

- Products: ${products.join(', ')}
- Preset: ${preset}
- Initial severity: warning
- Dependency: @playstack/lint
- Config: eslint.config.mjs
`);
  if (options.dryRun === true || process.env.NX_DRY_RUN === 'true') return;

  if (plannedConfig !== undefined) {
    tree.write('eslint.config.mjs', plannedConfig);
  }
  const compatibleVersion = compatiblePlaystackPackageVersion(
    'playstack-lint',
    '@playstack/lint',
  );
  const dependencyVersion = retainedLocalPackageVersion(
    tree,
    '@playstack/lint',
    compatibleVersion,
  );
  if (
    plannedConfig === undefined &&
    declaredRootDevelopmentDependency(tree, '@playstack/lint') ===
      dependencyVersion
  ) {
    return;
  }
  const install = addDependenciesToPackageJson(
    tree,
    {},
    {
      '@playstack/lint': dependencyVersion,
    },
  );
  await formatFiles(tree);
  return install;
}

export default playstackLintGenerator;
