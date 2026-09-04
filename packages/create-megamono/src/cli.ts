#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
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
  type CreateMegamonoInput,
} from './lib/create-megamono.js';

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

export interface InteractivePrompt {
  question(message: string): Promise<string>;
  close(): void;
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

function appSelectionQuestion(): string {
  const overview = APP_IDS.map(
    (type) => `  ${type.padEnd(9)} ${APP_TYPE_OVERVIEWS[type]}`,
  ).join('\n');
  return `Application types:\n${overview}\n\nChoose apps using type or type:name (comma-separated): `;
}

export async function resolveInteractive(
  input: CreateMegamonoInput,
  interactivePrompt?: InteractivePrompt,
): Promise<CreateMegamonoInput> {
  if (!input.interactive) return input;
  const prompt =
    interactivePrompt ?? createInterface({ input: stdin, output: stdout });
  try {
    const name = input.name ?? (await prompt.question('Workspace name: '));
    const apps = input.apps?.length
      ? input.apps
      : commaList(await prompt.question(appSelectionQuestion()));
    const databaseAdapter =
      (input.databaseAdapter ??
        (await prompt.question(
          `Database adapter (${DATABASE_ADAPTERS.join(', ')}) [prisma]: `,
        ))) ||
      'prisma';
    const styling = apps?.some((app) => {
      const type = app.split(':', 1)[0];
      return type === 'web' || type === 'site';
    })
      ? (input.styling ??
          (await prompt.question(
            `Web styling (${WEB_STYLING_OPTIONS.join(', ')}) [chakra]: `,
          ))) ||
        'chakra'
      : input.styling;
    const databaseName =
      databaseAdapter === 'none'
        ? undefined
        : (input.databaseName ??
            (await prompt.question('Database name [primary]: '))) ||
          'primary';
    const services =
      input.services !== undefined
        ? input.services
        : commaList(
            await prompt.question(
              `Services (${SERVICE_IDS.join(', ')}; comma-separated, optional): `,
            ),
          );
    const serviceRunner =
      (input.serviceRunner ??
        (await prompt.question(
          `Service runner (${SERVICE_RUNNERS.join(', ')}) [none]: `,
        ))) ||
      'none';
    return {
      ...input,
      name,
      apps,
      services,
      databaseAdapter,
      databaseName,
      styling,
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
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        directory: { type: 'string' },
        apps: { type: 'string' },
        services: { type: 'string' },
        'database-adapter': { type: 'string' },
        'database-name': { type: 'string' },
        styling: { type: 'string' },
        'service-runner': { type: 'string' },
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
      stdin.isTTY,
    );
    const input = await resolveInteractive({
      name: parsed.positionals[0],
      directory: parsed.values.directory,
      apps:
        positionalApps.length > 0
          ? positionalApps
          : commaList(parsed.values.apps),
      services: commaList(parsed.values.services),
      databaseAdapter: parsed.values['database-adapter'],
      databaseName: parsed.values['database-name'],
      styling: parsed.values.styling,
      serviceRunner: parsed.values['service-runner'],
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
