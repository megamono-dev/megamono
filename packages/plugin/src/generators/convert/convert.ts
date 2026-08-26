import {
  addDependenciesToPackageJson,
  formatFiles,
  logger,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import {
  analyzeConversion,
  assertConversionReady,
  collectConvertGitState,
  renderConvertReport,
  renderPersistedConvertReport,
  workspaceRelativeReportPath,
} from '../../lib/convert';
import {
  applyConversionPlan,
  convertDefaultPlatform,
  createConvertPostFlushCallback,
  hasCompletedConversion,
  normalizedConvertScope,
  setConvertWarningMode,
  writeConvertMarker,
} from '../../lib/convert-execution';
import { readPluginVersion } from '../../lib/managed-skills';
import { docsDecisionGenerator } from '../docs-decision/docs-decision';
import { workspaceInitGenerator } from '../workspace-init/workspace-init';
import type { ConvertGeneratorSchema } from './schema';

export interface ConvertGeneratorDependencies {
  readonly gitState?: Awaited<ReturnType<typeof collectConvertGitState>>;
  readonly pluginVersion?: string;
}

function normalizedMarkerPaths(options: ConvertGeneratorSchema): {
  readonly source: string;
  readonly destination: string;
} {
  const source = (options.source ?? '.')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
  return {
    source: source || '.',
    destination:
      options.destination?.replace(/^\.\//, '').replace(/\/$/, '') ||
      `apps/${options.appName}`,
  };
}

export async function convertGenerator(
  tree: Tree,
  options: ConvertGeneratorSchema,
  dependencies: ConvertGeneratorDependencies = {},
): Promise<GeneratorCallback | void> {
  const dryRun = options.dryRun === true || process.env.NX_DRY_RUN === 'true';
  const markerPaths = normalizedMarkerPaths(options);
  const marker = hasCompletedConversion(
    tree,
    options.appName,
    markerPaths.source,
    markerPaths.destination,
  );
  if (marker) {
    if (options.report && !dryRun) {
      const reportPath = workspaceRelativeReportPath(tree.root, options.report);
      tree.write(reportPath, marker.report);
      await formatFiles(tree);
    }
    logger.info(
      `Megamono conversion ${options.appName} is already applied; no structural changes made.`,
    );
    return;
  }

  const git =
    dependencies.gitState ?? (await collectConvertGitState(tree.root));
  const analysis = analyzeConversion(tree, options, git);
  const report = renderConvertReport(analysis);
  const persistedReport = renderPersistedConvertReport(analysis);
  logger.info(report.trimEnd());
  if (dryRun) return;
  assertConversionReady(analysis);

  const scope = normalizedConvertScope(options.scope);
  const execution = applyConversionPlan(tree, analysis, scope);
  const pluginVersion = dependencies.pluginVersion ?? readPluginVersion();
  const wasInitialized = tree.exists('megamono.json');
  const updateDependencies = addDependenciesToPackageJson(
    tree,
    {},
    Object.fromEntries(
      execution.installedPlugins.map((plugin) => [plugin, pluginVersion]),
    ),
  );
  const initializeWorkspace = await workspaceInitGenerator(tree, {
    only: 'docs,agents,ci,lint,skills,health,inference',
    yes: true,
    packageManager: analysis.detection.packageManager,
    defaultPlatform: convertDefaultPlatform(analysis),
    defaultScope: scope,
  });
  setConvertWarningMode(tree, analysis);
  const indexDecision = await docsDecisionGenerator(tree, {
    title: 'Adopt Megamono repository structure',
    project: analysis.appName,
    topics: ['architecture', 'convert', 'migration'],
  });
  if (options.report) {
    const reportPath = workspaceRelativeReportPath(tree.root, options.report);
    tree.write(reportPath, persistedReport);
  }
  writeConvertMarker(tree, analysis, persistedReport);
  await formatFiles(tree);

  return createConvertPostFlushCallback(
    tree.root,
    analysis,
    [...(wasInitialized ? [updateDependencies] : []), initializeWorkspace],
    indexDecision,
  );
}

export default convertGenerator;
