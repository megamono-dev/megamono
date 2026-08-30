import {
  addDependenciesToPackageJson,
  formatFiles,
  logger,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { compatiblePlaystackPackageVersion } from '../../lib/emissions';
import {
  PlaystackWorkspaceIntegrationError,
  assertInitializedMegamonoWorkspace,
  assertPlaystackProductInstalled,
  assertPlaystackWorkspaceCompatibility,
  declaredRootDevelopmentDependency,
  retainedLocalPackageVersion,
} from '../playstack-workspace';
import type { PlaystackLintGeneratorSchema } from './schema';

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

function plannedLintConfig(
  original: string,
  preset: 'recommended' | 'all',
): string | undefined {
  const currentImports = section(original, importsStart, importsEnd);
  const currentConfig = section(original, configStart, configEnd);
  if (currentImports !== undefined && currentImports !== importsBody) {
    throw new PlaystackWorkspaceIntegrationError(
      'The managed Playstack lint import section was modified; preserve it and resolve the conflict explicitly.',
    );
  }
  const validConfigBodies = [configBody('recommended'), configBody('all')];
  if (
    currentConfig !== undefined &&
    !validConfigBodies.includes(currentConfig)
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
  if (currentImports === importsBody && currentConfig === configBody(preset)) {
    return undefined;
  }

  let source = original;
  if (currentImports === undefined) {
    source = `${importsStart}${importsBody}${importsEnd}\n\n${source}`;
  }
  if (currentConfig === undefined) {
    const closing = source.lastIndexOf('];');
    if (!source.includes('export default [') || closing < 0) {
      throw new PlaystackWorkspaceIntegrationError(
        'eslint.config.mjs must export a flat config array before Playstack lint can be wired.',
      );
    }
    const before = source.slice(0, closing).trimEnd();
    const separator = before.endsWith('[') || before.endsWith(',') ? '' : ',';
    source = `${before}${separator}\n${configStart}${configBody(preset)}${configEnd}\n${source.slice(closing)}`;
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
  const plannedConfig = plannedLintConfig(source, preset);

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
