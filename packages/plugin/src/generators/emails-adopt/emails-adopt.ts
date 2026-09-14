import {
  getProjects,
  logger,
  updateProjectConfiguration,
  type Tree,
} from '@nx/devkit';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolvedProjects } from '../../lib/resolved-projects';

export interface EmailsAdoptSchema {
  project: string;
  previewTarget: string;
  verificationTarget: string;
  templatesRoot: string;
  fixturesRoot: string;
  themeFile: string;
  reviewedLocalOnly?: boolean;
  reviewedFixtureOnly?: boolean;
  planOnly?: boolean;
  yes?: boolean;
}

function workspacePath(value: string): string {
  if (
    !value ||
    posix.isAbsolute(value) ||
    value.includes('\\') ||
    value
      .split('/')
      .some(
        (part) => !part || ['.', '..', '.git', 'node_modules'].includes(part),
      )
  ) {
    throw new Error(
      `Expected a repository-relative email input path: ${value}`,
    );
  }
  return value;
}

/** Adopt application-owned email code; never install, import or run that code. */
export async function emailsAdoptGenerator(
  tree: Tree,
  options: EmailsAdoptSchema,
): Promise<void> {
  const project = (await resolvedProjects(tree)).get(options.project);
  if (!project) throw new Error(`Unknown Nx email project: ${options.project}`);
  if (
    options.reviewedLocalOnly !== true ||
    options.reviewedFixtureOnly !== true
  ) {
    throw new Error(
      'Review that the existing preview binds only to loopback and uses synthetic fixtures without production environment/recipient data; pass reviewedLocalOnly and reviewedFixtureOnly explicitly. These declarations are not runtime certification.',
    );
  }
  const preview = project.targets?.[options.previewTarget];
  const verification = project.targets?.[options.verificationTarget];
  if (!preview || !verification)
    throw new Error(
      'Select existing preview and verification targets; adoption never invents application commands.',
    );
  if (
    options.previewTarget === options.verificationTarget ||
    [options.previewTarget, options.verificationTarget].includes(
      'megamono-emails-verify',
    )
  ) {
    throw new Error(
      'Preview and verification must be distinct targets and cannot refer to the generated verification aggregator.',
    );
  }
  if (
    preview.cache !== false ||
    Object.values(preview.configurations ?? {}).some(
      (configuration) => configuration.cache === true,
    )
  ) {
    throw new Error(
      'The existing preview target must explicitly disable caching. Review that target before adoption.',
    );
  }
  for (const key of ['templatesRoot', 'fixturesRoot'] as const) {
    const directory = workspacePath(options[key]);
    if (!tree.children(directory).length)
      throw new Error(`Missing or empty ${key}: ${directory}`);
  }
  if (verification.continuous === true || verification.cache !== false) {
    throw new Error(
      'The verification target must explicitly disable caching and run to completion (not continuous).',
    );
  }
  const themeFile = workspacePath(options.themeFile);
  if (!tree.exists(themeFile))
    throw new Error(`Missing application-owned theme: ${themeFile}`);
  const target = {
    executor: 'nx:run-commands',
    cache: false,
    dependsOn: [options.verificationTarget],
    options: { command: 'node -e "process.exit(0)"' },
  };
  const existing = project.targets?.['megamono-emails-verify'];
  if (existing && !isDeepStrictEqual(existing, target)) {
    throw new Error(
      'Existing megamono-emails-verify target differs; no application target was overwritten.',
    );
  }
  const recordPath = `.megamono/email-previews/${encodeURIComponent(options.project)}.json`;
  const record = {
    version: 1,
    project: options.project,
    ownership: 'application',
    previewTarget: options.previewTarget,
    verificationTarget: options.verificationTarget,
    templatesRoot: options.templatesRoot,
    fixturesRoot: options.fixturesRoot,
    themeFile,
    reviewedLocalOnly: true,
    reviewedFixtureOnly: true,
    qualification: 'not-run',
    requiredChecks: [
      'subject-html-plaintext',
      'invalid-props',
      'encoded-size-limit',
      'loopback-preview',
      'synthetic-fixtures',
      'capture-delivery',
    ],
    limitations: [
      'Review declarations do not prove runtime isolation.',
      'No provider, deliverability or recipient-locale fan-out qualification.',
      'No preview command or renderer is executed during adoption.',
    ],
  };
  const plan = {
    writes: options.yes === true && !options.planOnly,
    project: options.project,
    files: [recordPath],
    projectConfiguration: `Add verification aggregator to existing Nx project ${options.project}`,
    target: 'megamono-emails-verify',
    preserved: [
      options.templatesRoot,
      options.fixturesRoot,
      themeFile,
      options.previewTarget,
    ],
    suggestedCommit: 'chore(emails): adopt existing preview and verification',
  };
  if (tree.exists(recordPath)) {
    const previous = JSON.parse(tree.read(recordPath, 'utf8') ?? '{}');
    if (!isDeepStrictEqual(previous, record))
      throw new Error(
        `Existing adoption mapping differs at ${recordPath}; review and update it explicitly before rerunning.`,
      );
  }
  logger.info(JSON.stringify(plan, null, 2));
  if (!plan.writes) return;
  const editableProject = getProjects(tree).get(options.project) ?? {
    root: project.root,
    name: options.project,
    projectType: project.projectType,
    tags: project.tags,
  };
  if (!existing)
    updateProjectConfiguration(tree, options.project, {
      ...editableProject,
      targets: { ...editableProject.targets, 'megamono-emails-verify': target },
    });
  if (!tree.exists(recordPath))
    tree.write(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

export default emailsAdoptGenerator;
