import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyContainerDefinition } from './container-verification';

describe('container verification', () => {
  it('detects a pnpm install that relies on an incomplete and mutable context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-container-'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@11.24.0' }),
    );
    await writeFile(
      join(root, 'Dockerfile'),
      [
        'FROM node:24 AS build',
        'COPY package.json ./',
        'RUN pnpm install',
        '',
      ].join('\n'),
    );

    const report = await verifyContainerDefinition({
      workspaceRoot: root,
      dockerfile: 'Dockerfile',
    });

    expect(report.findings.map(({ code }) => code)).toEqual([
      'container-lockfile-not-copied',
      'container-workspace-manifest-not-copied',
      'container-unlocked-install',
      'container-production-install-missing',
    ]);
  });

  it('accepts a frozen production pnpm install with workspace inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'megamono-container-'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@11.24.0' }),
    );
    await writeFile(
      join(root, 'Dockerfile'),
      [
        'FROM node:24',
        'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./',
        'RUN pnpm install --prod --frozen-lockfile',
        '',
      ].join('\n'),
    );

    expect(
      (
        await verifyContainerDefinition({
          workspaceRoot: root,
          dockerfile: 'Dockerfile',
        })
      ).findings,
    ).toEqual([]);
  });
});
