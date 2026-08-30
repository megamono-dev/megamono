#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import enquirer from 'enquirer';
import { runMegamonoCli, type CommandResult } from './lib/cli.js';

const { prompt } = enquirer;

async function runCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly capture?: boolean },
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: process.env,
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

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const result = await runMegamonoCli(process.argv.slice(2), {
  cwd: process.cwd(),
  version: packageJson.version,
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
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
