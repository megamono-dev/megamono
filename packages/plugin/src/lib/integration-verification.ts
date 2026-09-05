import type {
  ProjectConfiguration,
  TargetConfiguration,
  Tree,
} from '@nx/devkit';
import { isMap, isSeq, parseDocument } from 'yaml';

export interface IntegrationVerificationPlan {
  readonly project: string;
  readonly target: string;
  readonly configuration: TargetConfiguration;
  readonly mappings: Readonly<Record<string, string>>;
  readonly workflow?: {
    readonly path: string;
    readonly content: string;
    readonly job: string;
  };
}

export function planIntegrationVerification(
  tree: Tree,
  projects: ReadonlyMap<string, ProjectConfiguration>,
  required: readonly string[],
  options: {
    verification?: string;
    verificationProject?: string;
    ciWorkflow?: string;
    ciJob?: string;
  },
): IntegrationVerificationPlan | undefined {
  if (
    !options.verification &&
    !options.verificationProject &&
    !options.ciWorkflow &&
    !options.ciJob
  )
    return undefined;
  if (!options.verification || !options.verificationProject)
    throw new Error(
      'Verification wiring requires --verification=<JSON test-to-Nx-target map> and --verificationProject=<Nx name>.',
    );
  const project = projects.get(options.verificationProject);
  if (!project || !/^[@\w./-]+$/.test(options.verificationProject))
    throw new Error(
      `Unknown or unsafe verification project ${options.verificationProject}.`,
    );
  const mappings: unknown = JSON.parse(options.verification);
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings))
    throw new Error('--verification must be a JSON object.');
  const entries = Object.entries(mappings);
  if (
    !required.length ||
    required.some((id) => !Object.hasOwn(mappings, id)) ||
    entries.some(([id]) => !required.includes(id))
  )
    throw new Error(
      'Verification must map every active package:integration:test requirement, with no unknown keys.',
    );
  const target = 'playstack-verify';
  const dependencies = new Map<
    string,
    { projects: string[]; target: string }
  >();
  for (const [id, value] of entries) {
    if (typeof value !== 'string' || !/^[@\w./-]+:[\w-]+$/.test(value))
      throw new Error(
        `Verification ${id} must name an existing project:target, not a shell command.`,
      );
    const [name, targetName] = value.split(':');
    if (!projects.get(name)?.targets?.[targetName])
      throw new Error(
        `Verification ${id} references missing Nx target ${value}.`,
      );
    if (targetName === target)
      throw new Error(
        'Verification mappings cannot depend on a playstack-verify aggregator.',
      );
    dependencies.set(value, { projects: [name], target: targetName });
  }
  const configuration: TargetConfiguration = {
    executor: 'nx:noop',
    cache: false,
    dependsOn: [...dependencies.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value),
    metadata: {
      description:
        'Reviewed Playstack integration contract checks. The mapped targets remain application-owned.',
    },
  };
  const existing = project.targets?.[target];
  if (existing && JSON.stringify(existing) !== JSON.stringify(configuration))
    throw new Error(
      `${options.verificationProject}:${target} already exists with different configuration; review it before replacing the target.`,
    );
  let workflow: IntegrationVerificationPlan['workflow'];
  if (options.ciWorkflow || options.ciJob) {
    const path = options.ciWorkflow ?? '';
    const jobName = options.ciJob ?? '';
    if (
      !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(path) ||
      !/^[\w-]+$/.test(jobName)
    )
      throw new Error(
        'CI integration requires an existing .github/workflows/*.yml path and explicit --ciJob.',
      );
    const content = tree.read(path, 'utf8');
    if (content === null)
      throw new Error(
        `CI workflow ${path} does not exist; existing-workflow integration never creates a replacement pipeline.`,
      );
    const document = parseDocument(content);
    if (document.errors.length)
      throw new Error(`CI workflow ${path} is invalid YAML.`);
    const job = document.getIn(['jobs', jobName], true);
    if (!isMap(job)) throw new Error(`CI job ${jobName} does not exist.`);
    const steps = job.get('steps', true);
    if (!isSeq(steps))
      throw new Error(
        'The selected CI job must have an explicit steps sequence; reusable jobs remain repository-owned.',
      );
    const invocation = `${options.verificationProject}:${target}`;
    // Resolve the installed Nx bin. No package-manager reconciliation or fetch.
    const script = `const p=require.resolve('nx/package.json');const b=require(p).bin;const r=require('node:child_process').spawnSync(process.execPath,[require('node:path').resolve(require('node:path').dirname(p),typeof b==='string'?b:b.nx),'run',process.argv[1]],{stdio:'inherit'});process.exit(r.status??1)`;
    const step = {
      name: 'Verify Playstack integration contracts',
      id: 'megamono-playstack-verification',
      'working-directory': '.',
      run: `node -e "${script}" -- ${invocation}`,
    };
    const prior = steps.items.find(
      (item) => isMap(item) && item.get('id') === step.id,
    );
    if (isMap(prior) && JSON.stringify(prior.toJSON()) !== JSON.stringify(step))
      throw new Error(
        'The existing Playstack CI verification step differs from the reviewed proposal.',
      );
    if (!prior) steps.add(document.createNode(step));
    workflow = {
      path,
      job: jobName,
      content: prior ? content : document.toString(),
    };
  }
  return {
    project: options.verificationProject,
    target,
    configuration,
    mappings: mappings as Record<string, string>,
    ...(workflow ? { workflow } : {}),
  };
}
