import { logger, type PromiseExecutor } from '@nx/devkit';
import { readMegamonoConfig } from '../../lib/config';
import {
  adoptedStructuralRules,
  checkAdoptionRatchets,
} from '../../lib/adoption-ratchets';
import { evaluateIdentityBaseline } from '../../lib/identity-baseline';
import {
  formatDiagnostic,
  hasErrors,
  type Diagnostic,
} from '../../lib/diagnostics';
import { validateRepositoryDocs } from '../../lib/docs';
import { analyzeWorkspaceStructure } from '../../lib/structural-check';
import { checkProjectPreflights } from '../../lib/project-preflight';
import { validateInstalledSkills } from '../../lib/managed-skills';
import { validateManagedArtifactRegistry } from '../../lib/managed-artifacts';
import { validatePackageSources } from '../../lib/package-sources';
import type { CheckExecutorSchema } from './schema';

const runExecutor: PromiseExecutor<CheckExecutorSchema> = async (
  options,
  context,
) => {
  try {
    const config = await readMegamonoConfig(
      context.root,
      options.config ?? 'megamono.json',
    );
    const diagnostics: Diagnostic[] = [];
    const rawDiagnostics: Diagnostic[] = [];
    const add = (findings: readonly Diagnostic[]) => {
      diagnostics.push(...findings);
      rawDiagnostics.push(...findings);
    };
    const acceptedDecisions = new Set<string>();
    const adoptedModules = new Set(config.adoption.modules);
    const packageSourceProfile =
      options.profile ??
      (options.ci || process.env.CI === 'true' ? 'ci' : undefined);
    if (options.ci && options.profile && options.profile !== 'ci') {
      throw new Error('--ci cannot be combined with a non-ci --profile.');
    }
    if (!options.skipDocs && adoptedModules.has('docs')) {
      const docs = await validateRepositoryDocs(
        context.root,
        config,
        options.docsRoot,
      );
      add(docs.diagnostics);
      for (const document of docs.documents) {
        if (
          document.data.type === 'decision' &&
          document.data.status === 'accepted'
        ) {
          acceptedDecisions.add(document.data.id);
        }
      }
    }
    const structure = await analyzeWorkspaceStructure(
      context.root,
      context.projectGraph,
      config,
      acceptedDecisions,
      adoptedStructuralRules(config),
    );
    diagnostics.push(...structure.diagnostics);
    rawDiagnostics.push(...structure.rawDiagnostics);
    add(await checkProjectPreflights(context.projectGraph));
    add(validateInstalledSkills(context.root));
    add(validateManagedArtifactRegistry(context.root));
    if (packageSourceProfile)
      add(
        await validatePackageSources(context.root, config, {
          profile: packageSourceProfile,
        }),
      );
    const baseline = evaluateIdentityBaseline(structure.diagnostics, config);
    diagnostics.push(...baseline.errors);
    diagnostics.push(...checkAdoptionRatchets(diagnostics, config));
    const success = !hasErrors(diagnostics);
    if (options.json) {
      logger.info(
        JSON.stringify(
          {
            schemaVersion: 1,
            purpose: 'validation',
            success,
            policy: {
              warningBaseline: config.adoption.warningBaseline ?? null,
              ratchets: config.adoption.ratchets,
            },
            raw: rawDiagnostics,
            allowed: structure.allowed,
            baselined: baseline.baselined,
            new: baseline.new,
            resolved: baseline.resolved,
            errors: diagnostics.filter(
              (diagnostic) => diagnostic.severity === 'error',
            ),
            diagnostics,
          },
          null,
          2,
        ),
      );
      return { success };
    }
    for (const diagnostic of diagnostics) {
      const message = formatDiagnostic(diagnostic);
      if (diagnostic.severity === 'error') logger.error(message);
      else logger.warn(message);
    }
    if (!success) return { success: false };
    if (options.verbose) logger.info('Megamono structural checks passed.');
    return { success: true };
  } catch (error) {
    if (options.json) {
      const diagnostic: Diagnostic = {
        severity: 'error',
        code: 'check-failed',
        message: (error as Error).message,
      };
      logger.info(
        JSON.stringify(
          {
            schemaVersion: 1,
            purpose: 'validation',
            success: false,
            raw: [],
            allowed: [],
            baselined: [],
            new: [],
            resolved: [],
            errors: [diagnostic],
            diagnostics: [diagnostic],
          },
          null,
          2,
        ),
      );
      return { success: false };
    }
    logger.error((error as Error).message);
    return { success: false };
  }
};

export default runExecutor;
