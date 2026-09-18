#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import enquirer from 'enquirer';
import {
  runMegamonoCli,
  type CommandResult,
  type MegamonoBuildIdentity,
} from './lib/cli.js';
import { createHostedAuthOperations } from './lib/hosted-auth.js';

const { prompt } = enquirer;

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly capture?: boolean;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: options.capture
        ? ['ignore', 'pipe', 'pipe']
        : ['inherit', 'inherit', 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
    }
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        exitCode: code ?? 1,
        ...(stdout ? { stdout: stdout.trim() } : {}),
        ...(stderr ? { stderr: stderr.trim() } : {}),
        ...(signal ? { signal } : {}),
      });
    });
  });
}

async function openExternal(url: string): Promise<void> {
  const invocation =
    process.platform === 'darwin'
      ? { command: 'open', args: [url] }
      : process.platform === 'win32'
        ? { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
        : { command: 'xdg-open', args: [url] };
  const result = await runCommand(invocation.command, invocation.args, {
    cwd: process.cwd(),
    capture: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not open the authorization URL: ${result.stderr ?? `exit ${result.exitCode}`}`,
    );
  }
}

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const build = await (async (): Promise<MegamonoBuildIdentity | undefined> => {
  try {
    return JSON.parse(
      await readFile(new URL('./build-info.json', import.meta.url), 'utf8'),
    ) as MegamonoBuildIdentity;
  } catch {
    return undefined;
  }
})();

const result = await runMegamonoCli(process.argv.slice(2), {
  cwd: process.cwd(),
  version: packageJson.version,
  ...(build ? { build } : {}),
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
  hostedAuth: createHostedAuthOperations({ open: openExternal }),
  ...(process.env.MEGAMONO_SERVICE_URL
    ? { hostedServiceUrl: process.env.MEGAMONO_SERVICE_URL }
    : {}),
  ...(process.env.MEGAMONO_API_URL
    ? { hostedApiUrl: process.env.MEGAMONO_API_URL }
    : {}),
  ...(stdin.isTTY && stdout.isTTY
    ? {
        selectAppType: async (
          choices: readonly {
            readonly name: string;
            readonly message: string;
          }[],
        ) => {
          const response = await prompt<{ type: string }>({
            type: 'select',
            name: 'type',
            message: 'Which application preset should be added?',
            choices: choices.map((choice) => ({
              name: choice.name,
              message: choice.message,
            })),
          });
          return response.type;
        },
        selectWebStyling: async (
          choices: readonly {
            readonly name: string;
            readonly message: string;
          }[],
        ) => {
          const response = await prompt<{ styling: string }>({
            type: 'select',
            name: 'styling',
            message: 'How should the generated billboard be styled?',
            choices: choices.map((choice) => ({
              name: choice.name,
              message: choice.message,
            })),
          });
          return response.styling;
        },
        inputDatabaseName: async (initial: string) => {
          const response = await prompt<{ name: string }>({
            type: 'input',
            name: 'name',
            message: 'What should this database target be called?',
            initial,
          });
          return response.name;
        },
        selectDatabaseAdapter: async (
          choices: readonly {
            readonly name: string;
            readonly message: string;
          }[],
        ) => {
          const response = await prompt<{ adapter: string }>({
            type: 'select',
            name: 'adapter',
            message: 'Which database toolkit should be scaffolded?',
            choices: choices.map((choice) => ({
              name: choice.name,
              message: choice.message,
            })),
          });
          return response.adapter;
        },
        confirmAddPlan: async (message: string) => {
          const response = await prompt<{ confirmed: boolean }>({
            type: 'confirm',
            name: 'confirmed',
            message,
            initial: false,
          });
          return response.confirmed;
        },
        selectHostedAccount: async (
          accounts: readonly {
            readonly id: string;
            readonly name: string;
            readonly slug: string;
            readonly role: string;
          }[],
        ) => {
          const response = await prompt<{ account: string }>({
            type: 'select',
            name: 'account',
            message: 'Which account should this terminal use?',
            choices: accounts.map((account) => ({
              name: account.id,
              message: `${account.name} (${account.slug}) — ${account.role}`,
            })),
          });
          return response.account;
        },
        selectPlaystackPackages: async (
          choices: readonly {
            readonly name: string;
            readonly message: string;
          }[],
        ) => {
          const response = await prompt<{ products: string[] }>({
            type: 'multiselect',
            name: 'products',
            message: 'Which Playstack capabilities should this workspace use?',
            choices: choices.map((choice) => ({
              name: choice.name,
              message: choice.message,
            })),
            validate: (value) =>
              Array.isArray(value) && value.length > 0
                ? true
                : 'Select at least one Playstack capability.',
          });
          return response.products;
        },
        selectPlaystackSurface: async (
          kind: 'web' | 'api',
          choices: readonly {
            readonly name: string;
            readonly root: string;
            readonly message: string;
          }[],
        ) => {
          const response = await prompt<{ surface: string }>({
            type: 'select',
            name: 'surface',
            message: `Which ${kind} application should Playstack bind?`,
            choices: choices.map((choice) => ({
              name: choice.root,
              message: choice.message,
            })),
          });
          return response.surface;
        },
      }
    : {}),
  runCommand,
});

process.exitCode = result.exitCode;
