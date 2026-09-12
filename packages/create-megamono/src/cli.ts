#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { input as textInput, select, checkbox } from '@inquirer/prompts';
import { stdin, stdout } from 'node:process';
import {
  APP_IDS,
  CreateMegamonoError,
  DATABASE_ADAPTERS,
  SERVICE_IDS,
  SERVICE_RUNNERS,
  WEB_STYLING_OPTIONS,
  createMegamono,
  renderPlan,
  normalizeAppInstances,
  validatePackageNames,
  type CreateMegamonoInput,
} from './lib/create-megamono.js';
import { PACKAGE_MANAGERS } from './lib/package-manager.js';

export const APP_TYPE_OVERVIEWS = {
  web: 'Next.js product, dashboard, or admin web app',
  api: 'NestJS HTTP API or backend service',
  worker: 'Cloudflare Worker for edge or background work',
  mobile: 'Expo React Native app for iOS and Android',
  desktop: 'Tauri desktop app',
  apple: 'Native Swift/Xcode app (macOS required)',
  site: 'Next.js marketing, documentation, or public site',
  extension: 'Browser extension',
} as const satisfies Record<(typeof APP_IDS)[number], string>;

export const HELP = `Usage: create-megamono <name> [type[:name] ...] [options]

App types:
${APP_IDS.map((type) => `  ${type.padEnd(9)} ${APP_TYPE_OVERVIEWS[type]}`).join('\n')}

Use positional descriptors or --apps=<comma-separated descriptors>, not both.
Names are optional; repeated types need distinct names.
Interactive menus: arrows to navigate, Space to toggle services, Enter to continue.
Interactive apps: add, name, edit, or remove instances before continuing.
Next, optionally add publishable TypeScript packages (suggested when no apps are selected).

Options:
  --apps=                 Explicitly create without applications
  --packages=<names>      Named TypeScript libraries under packages/; empty skips setup
  --package-scope=<name>  npm scope (default: workspace name)
  --package-access=<mode> restricted (default) or public; does not publish
  --styling=<choice>       ${WEB_STYLING_OPTIONS.join(', ')}
  --router=pages|app       Next.js router for web/site apps (default: pages)
  --local-packages=yalc    Use locally published packages and their dependency closure
  --package-manager=<name> npm, pnpm, yarn, bun
  --interactive=false     Disable guided prompts
  --database-adapter=<id>  ${DATABASE_ADAPTERS.join(', ')}
  --services=<ids>         ${SERVICE_IDS.join(', ')}
  --service-runner=<id>    ${SERVICE_RUNNERS.join(', ')}
  --springbar              Shortcut for --service-runner=springbar; never starts services
  --dry-run               Print the plan without creating a workspace
  --version [--json]      Print installed build identity
  --help, -h              Show help without prompts, installs, or writes

Examples:
  create-megamono toolkit --packages=core,client --package-access=public --local-packages=yalc --interactive=false
  create-megamono studio site:marketing extension:grids extension:guides api web:admin
  create-megamono studio --apps=site,api --styling=chakra --local-packages=yalc --interactive=false --dry-run
`;

export interface InteractivePrompt {
  question(
    message: string,
    initial?: string,
    validate?: (value: string) => true | string,
  ): Promise<string>;
  select(
    message: string,
    choices: readonly string[],
    initial: string,
    labels?: Readonly<Record<string, string>>,
  ): Promise<string>;
  multiselect(message: string, choices: readonly string[]): Promise<string[]>;
  close(): void;
}

export function createInteractivePrompt(): InteractivePrompt {
  const prompt = async <T>(ask: () => Promise<T>): Promise<T> => {
    try {
      return await ask();
    } catch (error) {
      if (error instanceof Error && error.name === 'ExitPromptError')
        throw new CreateMegamonoError(
          'Workspace creation cancelled. No workspace was created.',
          130,
        );
      throw error;
    }
  };
  return {
    question: async (message, initial, validate) => {
      const sections = message.split('\n\n');
      const label = sections.pop() ?? message;
      if (sections.length) stdout.write(`${sections.join('\n\n')}\n\n`);
      return prompt(() =>
        textInput({
          message: label,
          default: initial,
          validate,
        }),
      );
    },
    select: async (message, choices, initial, labels) => {
      return prompt(() =>
        select({
          message,
          pageSize: 10,
          choices: choices.map((value) => ({
            value,
            ...(labels ? { name: labels[value] ?? value } : {}),
          })),
          default: initial,
        }),
      );
    },
    multiselect: async (message, choices) => {
      return prompt(() =>
        checkbox({
          message: `${message} (optional)`,
          choices: choices.map((value) => ({ value })),
        }),
      );
    },
    // Inquirer closes each prompt and restores the terminal after submission.
    close: () => undefined,
  };
}

interface BuildIdentity {
  readonly schemaVersion: 1;
  readonly package: string;
  readonly version: string;
  readonly revision: string;
  readonly dirty: boolean;
  readonly buildId: string;
}

function buildIdentity(): BuildIdentity {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  try {
    return JSON.parse(
      readFileSync(new URL('./build-info.json', import.meta.url), 'utf8'),
    ) as BuildIdentity;
  } catch {
    return {
      schemaVersion: 1,
      package: 'create-megamono',
      version: manifest.version,
      revision: 'development',
      dirty: true,
      buildId: 'development',
    };
  }
}

function commaList(value: string | undefined): string[] | undefined {
  return value
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function booleanValue(
  label: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new CreateMegamonoError(`${label} must be true or false.`, 2);
}

export async function selectApplications(
  prompt: InteractivePrompt,
): Promise<string[]> {
  const apps: { type: (typeof APP_IDS)[number]; name: string }[] = [];
  const descriptors = () =>
    apps.map(({ type, name }) => (name === type ? type : `${type}:${name}`));
  while (true) {
    const summary = apps.length
      ? apps.map(({ type, name }) => `  ${type} → apps/${name}`).join('\n')
      : '  No applications added yet.';
    const action = await prompt.select(
      `Applications\n${summary}`,
      apps.length ? ['add', 'edit', 'remove', 'continue'] : ['add', 'continue'],
      apps.length ? 'continue' : 'add',
      {
        add: 'Add application',
        edit: 'Edit application',
        remove: 'Remove application',
        continue: apps.length ? 'Continue' : 'Continue without applications',
      },
    );
    if (action === 'continue') return descriptors();
    let index = apps.length;
    if (action === 'edit' || action === 'remove') {
      const choices = apps.map((_, i) => String(i));
      const chosen = await prompt.select(
        action === 'edit'
          ? 'Which application should be edited?'
          : 'Which application should be removed?',
        [...choices, 'back'],
        choices[0],
        {
          ...Object.fromEntries(
            apps.map(({ type, name }, i) => [
              String(i),
              `${type} → apps/${name}`,
            ]),
          ),
          back: 'Back to applications',
        },
      );
      if (chosen === 'back') continue;
      index = Number(chosen);
      if (action === 'remove') {
        apps.splice(index, 1);
        continue;
      }
    }
    const existing = apps[index];
    const type = await prompt.select(
      'Application type',
      [...APP_IDS, 'back'],
      existing?.type ?? 'web',
      {
        ...Object.fromEntries(
          APP_IDS.map((id) => [id, `${id} — ${APP_TYPE_OVERVIEWS[id]}`]),
        ),
        back: 'Back to applications',
      },
    );
    if (type === 'back') continue;
    let suggestedName = existing?.name ?? type;
    for (
      let suffix = 2;
      apps.some((app, i) => i !== index && app.name === suggestedName);
      suffix++
    ) {
      suggestedName = `${type}-${suffix}`;
    }
    const validate = (value: string): true | string => {
      try {
        normalizeAppInstances([
          ...descriptors().filter((_, i) => i !== index),
          `${type}:${value}`,
        ]);
        return true;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const name = await prompt.question(
      'Application name (directory under apps/)',
      suggestedName,
      validate,
    );
    const result = validate(name);
    if (result !== true) throw new CreateMegamonoError(result, 2);
    const [app] = normalizeAppInstances([`${type}:${name}`]);
    apps[index] = app;
  }
}

export async function selectPackages(
  prompt: InteractivePrompt,
  noApps: boolean,
): Promise<string[]> {
  const enabled = await prompt.select(
    'Set up publishable packages?',
    ['yes', 'no'],
    noApps ? 'yes' : 'no',
  );
  if (enabled === 'no') return [];
  const packages: string[] = [];
  while (true) {
    const action = await prompt.select(
      `Publishable packages${packages.length ? `: ${packages.join(', ')}` : ''}`,
      packages.length ? ['add', 'remove', 'continue'] : ['add', 'continue'],
      packages.length ? 'continue' : 'add',
      {
        add: 'Add TypeScript package',
        remove: 'Remove package',
        continue: 'Continue',
      },
    );
    if (action === 'continue') return packages;
    if (action === 'remove') {
      const name = await prompt.select('Remove package', packages, packages[0]);
      packages.splice(packages.indexOf(name), 1);
      continue;
    }
    const validate = (name: string): true | string => {
      try {
        validatePackageNames([...packages, name]);
        return true;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    const name = await prompt.question(
      'Package name',
      packages.length ? undefined : 'core',
      validate,
    );
    const result = validate(name);
    if (result !== true) throw new CreateMegamonoError(result, 2);
    packages.push(name);
  }
}

export async function resolveInteractive(
  input: CreateMegamonoInput,
  interactivePrompt?: InteractivePrompt,
): Promise<CreateMegamonoInput> {
  if (!input.interactive) return input;
  if (!interactivePrompt && (!stdin.isTTY || !stdout.isTTY)) {
    throw new CreateMegamonoError(
      'Interactive setup requires a terminal. Pass --interactive=false and supply options through flags.',
      2,
    );
  }
  const prompt = interactivePrompt ?? createInteractivePrompt();
  try {
    const name = input.name ?? (await prompt.question('Workspace name: '));
    const apps =
      input.apps ??
      (input.packages !== undefined ? [] : await selectApplications(prompt));
    const packages =
      input.packages ?? (await selectPackages(prompt, apps.length === 0));
    const packageScope = packages.length
      ? (input.packageScope ??
        (await prompt.question(
          'Package scope (without @)',
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, ''),
        )))
      : input.packageScope;
    const packageAccess = packages.length
      ? (input.packageAccess ??
        (await prompt.select(
          'Package access',
          ['restricted', 'public'],
          'restricted',
        )))
      : input.packageAccess;
    const packageManager =
      input.packageManager ??
      (await prompt.select('Package manager', PACKAGE_MANAGERS, 'npm'));
    const databaseAdapter =
      (input.databaseAdapter ??
        (await prompt.select(
          'Database adapter',
          DATABASE_ADAPTERS,
          apps.length ? 'prisma' : 'none',
        ))) ||
      (apps.length ? 'prisma' : 'none');
    const styling = apps?.some((app) => {
      const type = app.split(':', 1)[0];
      return type === 'web' || type === 'site';
    })
      ? (input.styling ??
          (await prompt.select(
            'Web styling',
            WEB_STYLING_OPTIONS,
            'chakra',
          ))) ||
        'chakra'
      : input.styling;
    const databaseName =
      databaseAdapter === 'none'
        ? undefined
        : (input.databaseName ??
            (await prompt.question('Database name', 'primary'))) ||
          'primary';
    const router = apps?.some((app) =>
      ['web', 'site'].includes(app.split(':', 1)[0]),
    )
      ? (input.router ??
        ((await prompt.select('Next.js router', ['pages', 'app'], 'pages')) ||
          'pages'))
      : input.router;
    const services =
      input.services !== undefined
        ? input.services
        : await prompt.multiselect('Services', SERVICE_IDS);
    const serviceRunner =
      (input.serviceRunner ??
        (await prompt.select('Service runner', SERVICE_RUNNERS, 'none'))) ||
      'none';
    return {
      ...input,
      name,
      apps,
      packages,
      packageScope,
      packageAccess,
      packageManager,
      services,
      databaseAdapter,
      databaseName,
      styling,
      router,
      serviceRunner,
    };
  } finally {
    prompt.close();
  }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  try {
    if (argv.includes('--help') || argv.includes('-h')) {
      stdout.write(HELP);
      return 0;
    }
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        directory: { type: 'string' },
        apps: { type: 'string' },
        packages: { type: 'string' },
        'package-scope': { type: 'string' },
        'package-access': { type: 'string' },
        services: { type: 'string' },
        'database-adapter': { type: 'string' },
        'database-name': { type: 'string' },
        styling: { type: 'string' },
        router: { type: 'string' },
        'service-runner': { type: 'string' },
        springbar: { type: 'boolean' },
        integrations: { type: 'string' },
        interactive: { type: 'string' },
        install: { type: 'string' },
        verify: { type: 'string' },
        'local-packages': { type: 'string' },
        'package-manager': { type: 'string' },
        'cleanup-on-failure': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
    });
    if (parsed.values.version) {
      const identity = buildIdentity();
      stdout.write(
        `${parsed.values.json ? JSON.stringify(identity, null, 2) : identity.version}\n`,
      );
      return 0;
    }
    if (parsed.positionals.length === 0 && !stdin.isTTY) {
      throw new CreateMegamonoError('Expected a workspace name.', 2);
    }
    const positionalApps = parsed.positionals.slice(1);
    if (positionalApps.length > 0 && parsed.values.apps !== undefined) {
      throw new CreateMegamonoError(
        'Pass app descriptors positionally or with --apps, not both.',
        2,
      );
    }
    const interactive = booleanValue(
      '--interactive',
      parsed.values.interactive,
      Boolean(stdin.isTTY && stdout.isTTY),
    );
    if (
      parsed.values.springbar &&
      parsed.values['service-runner'] &&
      parsed.values['service-runner'] !== 'springbar'
    ) {
      throw new CreateMegamonoError(
        '--springbar conflicts with --service-runner=none.',
        2,
      );
    }
    const input = await resolveInteractive({
      name: parsed.positionals[0],
      directory: parsed.values.directory,
      apps:
        positionalApps.length > 0
          ? positionalApps
          : commaList(parsed.values.apps),
      services: commaList(parsed.values.services),
      packages: commaList(parsed.values.packages),
      packageScope: parsed.values['package-scope'],
      packageAccess: parsed.values['package-access'],
      databaseAdapter: parsed.values['database-adapter'],
      databaseName: parsed.values['database-name'],
      styling: parsed.values.styling,
      router: parsed.values.router,
      serviceRunner: parsed.values.springbar
        ? 'springbar'
        : parsed.values['service-runner'],
      integrations: commaList(parsed.values.integrations),
      interactive,
      install: booleanValue('--install', parsed.values.install, true),
      verify: parsed.values.verify,
      localPackages: parsed.values['local-packages'],
      packageManager: parsed.values['package-manager'],
      cleanupOnFailure: parsed.values['cleanup-on-failure'],
      dryRun: parsed.values['dry-run'],
    });
    const plan = await createMegamono(input);
    stdout.write(`${renderPlan(plan)}\n`);
    if (plan.springbarResult) {
      stdout.write(`${plan.springbarResult.message}\n`);
      if (plan.springbarResult.retry) {
        stdout.write(
          `Springbar MCP retry payload:\n${JSON.stringify(plan.springbarResult.retry, null, 2)}\n`,
        );
      }
    }
    return 0;
  } catch (error) {
    const exitCode = error instanceof CreateMegamonoError ? error.exitCode : 1;
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return exitCode;
  }
}

export function isMainModule(
  moduleUrl = import.meta.url,
  executablePath = process.argv[1],
): boolean {
  if (!executablePath) return false;
  try {
    return (
      realpathSync(fileURLToPath(moduleUrl)) === realpathSync(executablePath)
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await main();
}
