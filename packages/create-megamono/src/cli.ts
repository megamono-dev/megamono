#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  APP_IDS,
  CreateMegamonoError,
  createMegamono,
  renderPlan,
  type CreateMegamonoInput,
} from './lib/create-megamono.js';

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

async function resolveInteractive(
  input: CreateMegamonoInput,
): Promise<CreateMegamonoInput> {
  if (!input.interactive || (input.name && input.apps?.length)) return input;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const name = input.name ?? (await prompt.question('Workspace name: '));
    const apps = input.apps?.length
      ? input.apps
      : commaList(
          await prompt.question(
            `Apps (${APP_IDS.join(', ')}; comma-separated): `,
          ),
        );
    return { ...input, name, apps };
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
        'service-runner': { type: 'string' },
        integrations: { type: 'string' },
        interactive: { type: 'string' },
        install: { type: 'string' },
        verify: { type: 'string' },
        'cleanup-on-failure': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    });
    if (parsed.positionals.length > 1) {
      throw new CreateMegamonoError('Expected at most one workspace name.', 2);
    }
    const interactive = booleanValue(
      '--interactive',
      parsed.values.interactive,
      stdin.isTTY,
    );
    const input = await resolveInteractive({
      name: parsed.positionals[0],
      directory: parsed.values.directory,
      apps: commaList(parsed.values.apps),
      services: commaList(parsed.values.services),
      serviceRunner: parsed.values['service-runner'],
      integrations: commaList(parsed.values.integrations),
      interactive,
      install: booleanValue('--install', parsed.values.install, true),
      verify: parsed.values.verify,
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
