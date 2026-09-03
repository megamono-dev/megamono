import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

export type ContainerFindingCode =
  | 'container-lockfile-not-copied'
  | 'container-production-install-missing'
  | 'container-unlocked-install'
  | 'container-workspace-manifest-not-copied'
  | 'dockerfile-missing';

export interface ContainerFinding {
  readonly code: ContainerFindingCode;
  readonly severity: 'error' | 'warning';
  readonly instruction?: string;
  readonly message: string;
}

export interface ContainerVerificationReport {
  readonly schemaVersion: 1;
  readonly dockerfile: string;
  readonly packageManager: string | null;
  readonly stages: readonly string[];
  readonly findings: readonly ContainerFinding[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function instructions(source: string): readonly string[] {
  return source
    .replace(/\\\r?\n\s*/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function copied(entries: readonly string[], name: string): boolean {
  return entries.some(
    (entry) =>
      /^(?:COPY|ADD)\s/i.test(entry) &&
      new RegExp(`(?:^|[\\s/"'])${name.replace('.', '\\.')}([\\s"']|$)`).test(
        entry,
      ),
  );
}

function managerInstall(
  entry: string,
  manager: string,
): { locked: boolean; production: boolean } | null {
  if (!/^RUN\s/i.test(entry)) return null;
  if (manager === 'pnpm' && /\bpnpm\s+(?:install|i|deploy)\b/.test(entry))
    return {
      locked: /--frozen-lockfile\b/.test(entry),
      production: /(?:--prod\b|--only[=\s]+prod(?:uction)?\b)/.test(entry),
    };
  if (manager === 'npm' && /\bnpm\s+(?:ci|install|i)\b/.test(entry))
    return {
      locked: /\bnpm\s+ci\b/.test(entry),
      production: /(?:--omit[=\s]+dev\b|--only[=\s]+prod(?:uction)?\b)/.test(
        entry,
      ),
    };
  if (manager === 'yarn' && /\byarn\s+install\b/.test(entry))
    return {
      locked: /(?:--frozen-lockfile\b|--immutable\b)/.test(entry),
      production: /--production\b/.test(entry),
    };
  if (manager === 'bun' && /\bbun\s+install\b/.test(entry))
    return {
      locked: /--frozen-lockfile\b/.test(entry),
      production: /--production\b/.test(entry),
    };
  return null;
}

export async function verifyContainerDefinition(options: {
  readonly workspaceRoot: string;
  readonly dockerfile: string;
}): Promise<ContainerVerificationReport> {
  const path = resolve(options.workspaceRoot, options.dockerfile);
  const rootManifest = JSON.parse(
    await readFile(join(options.workspaceRoot, 'package.json'), 'utf8'),
  ) as { readonly packageManager?: string };
  const manager = rootManifest.packageManager?.split('@')[0] ?? null;
  if (!(await exists(path)))
    return {
      schemaVersion: 1,
      dockerfile: options.dockerfile,
      packageManager: manager,
      stages: [],
      findings: [
        {
          code: 'dockerfile-missing',
          severity: 'error',
          message: `${options.dockerfile} does not exist.`,
        },
      ],
    };
  const entries = instructions(await readFile(path, 'utf8'));
  const stages = entries.flatMap((entry, index) => {
    const match = entry.match(/^FROM\s+\S+(?:\s+AS\s+(\S+))?/i);
    return match ? [match[1]?.toLowerCase() ?? `stage-${index + 1}`] : [];
  });
  const findings: ContainerFinding[] = [];
  const installEntries = manager
    ? entries.flatMap((entry) => {
        const install = managerInstall(entry, manager);
        return install ? [{ entry, ...install }] : [];
      })
    : [];
  const lockfile =
    manager === 'pnpm'
      ? 'pnpm-lock.yaml'
      : manager === 'npm'
        ? 'package-lock.json'
        : manager === 'yarn'
          ? 'yarn.lock'
          : manager === 'bun'
            ? 'bun.lock'
            : null;
  if (installEntries.length > 0 && lockfile && !copied(entries, lockfile))
    findings.push({
      code: 'container-lockfile-not-copied',
      severity: 'error',
      message: `${options.dockerfile} runs ${manager} install without copying ${lockfile} into the build context.`,
    });
  if (
    installEntries.length > 0 &&
    manager === 'pnpm' &&
    !copied(entries, 'pnpm-workspace.yaml')
  )
    findings.push({
      code: 'container-workspace-manifest-not-copied',
      severity: 'error',
      message:
        'A pnpm container install must copy pnpm-workspace.yaml so workspace package resolution matches the repository.',
    });
  for (const install of installEntries)
    if (!install.locked)
      findings.push({
        code: 'container-unlocked-install',
        severity: 'error',
        instruction: install.entry,
        message: `Container install is not frozen: ${install.entry}.`,
      });
  if (
    installEntries.length > 0 &&
    !installEntries.some(({ production }) => production) &&
    !entries.some(
      (entry) =>
        /^COPY\s+--from=/i.test(entry) &&
        /(?:node_modules|\/deploy\b)/.test(entry),
    )
  )
    findings.push({
      code: 'container-production-install-missing',
      severity: 'warning',
      message:
        'No production-only install or copied production dependency tree was detected; the final image may include development dependencies.',
    });
  return {
    schemaVersion: 1,
    dockerfile: relative(options.workspaceRoot, path),
    packageManager: manager,
    stages,
    findings,
  };
}

export function serializeContainerVerificationReport(
  report: ContainerVerificationReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
