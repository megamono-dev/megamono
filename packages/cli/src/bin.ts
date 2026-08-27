#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { runMegamonoCli, type CommandResult } from './lib/cli.js';

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
  runCommand,
});

process.exitCode = result.exitCode;
