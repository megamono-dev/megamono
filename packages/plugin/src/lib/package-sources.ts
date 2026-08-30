import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { MegamonoConfig } from './config';
import type { Diagnostic } from './diagnostics';

const scopePattern = /^@[a-z0-9][a-z0-9._-]*$/;
const registriesSchema = z.record(
  z.string().regex(scopePattern),
  z.url().refine((value) => value.startsWith('https://'), {
    message: 'Registry URLs must use HTTPS.',
  }),
);
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;
const ignoredDirectories = new Set([
  '.git',
  '.nx',
  '.yalc',
  'dist',
  'node_modules',
]);

export function parsePackageRegistries(
  source: string | undefined,
): Readonly<Record<string, string>> {
  if (source === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error('packageRegistries must be a JSON object.', {
      cause: error,
    });
  }
  const parsed = registriesSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `packageRegistries is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')}`,
    );
  }
  return Object.fromEntries(
    Object.entries(parsed.data)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([scope, registry]) => [scope, registry.replace(/\/+$/, '')]),
  );
}

export function renderPackageRegistrySection(
  registries: Readonly<Record<string, string>>,
): string {
  const lines = Object.entries(registries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scope, registry]) => `${scope}:registry=${registry}`);
  return `\n${lines.join('\n')}\n`;
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

async function packageManifests(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name))
          await visit(join(directory, entry.name));
      } else if (entry.isFile() && entry.name === 'package.json') {
        output.push(join(directory, entry.name));
      }
    }
  };
  await visit(root);
  return output.sort();
}

export async function validatePackageSources(
  root: string,
  config: MegamonoConfig,
): Promise<readonly Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const manager = config.conventions.packageManager;
  const lockfile = manager === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json';
  if (!(await exists(join(root, lockfile)))) {
    diagnostics.push({
      severity: 'error',
      code: 'package-sources-lockfile',
      path: lockfile,
      message: `Frozen CI requires the committed ${manager} lockfile.`,
    });
  }
  for (const path of ['yalc.lock', '.yalc']) {
    if (await exists(join(root, path))) {
      diagnostics.push({
        severity: 'error',
        code: 'package-sources-local-state',
        path,
        message:
          'Yalc state is development-only; CI must install reproducible registry dependencies.',
      });
    }
  }
  for (const absolutePath of await packageManifests(root)) {
    const path = relative(root, absolutePath).split('\\').join('/');
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await readFile(absolutePath, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    for (const field of dependencyFields) {
      const dependencies = manifest[field];
      if (!dependencies || typeof dependencies !== 'object') continue;
      for (const [name, specifier] of Object.entries(dependencies)) {
        if (
          typeof specifier === 'string' &&
          /^(?:file:)?\.yalc\/|^(?:link|portal):|^file:(?:\.\.\/|\/)/.test(
            specifier,
          )
        ) {
          diagnostics.push({
            severity: 'error',
            code: 'package-sources-local-dependency',
            path,
            message: `${field}.${name} uses development-only address ${specifier}. Publish it to a configured registry before CI.`,
          });
        }
      }
    }
  }
  const npmrc = (await exists(join(root, '.npmrc')))
    ? await readFile(join(root, '.npmrc'), 'utf8')
    : '';
  for (const [scope, registry] of Object.entries(
    config.packageSources.registries,
  )) {
    const expected = `${scope}:registry=${registry}`;
    if (!npmrc.split(/\r?\n/).some((line) => line.trim() === expected)) {
      diagnostics.push({
        severity: 'error',
        code: 'package-sources-registry',
        path: '.npmrc',
        message: `Configured registry routing is missing: ${expected}. Authentication remains CI-owned.`,
      });
    }
  }
  return diagnostics;
}
