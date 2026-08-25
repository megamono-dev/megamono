import { normalizePath } from '@nx/devkit';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export interface WranglerConfig extends Record<string, unknown> {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  pages_build_output_dir?: string;
  env?: Record<string, Record<string, unknown>>;
}

export interface CloudflareDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path: string;
}

export interface WranglerConfigRecord {
  configPath: string;
  root: string;
  config?: WranglerConfig;
  diagnostics: CloudflareDiagnostic[];
  executable: boolean;
}

export interface WranglerConfigSelection {
  configPath?: string;
}

function workspacePath(workspaceRoot: string, path: string): string {
  return normalizePath(relative(workspaceRoot, path)) || '.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function diagnostic(
  configPath: string,
  code: string,
  message: string,
): CloudflareDiagnostic {
  return { severity: 'error', code, message, path: configPath };
}

export function parseWranglerConfig(
  source: string,
  configPath: string,
): { config?: WranglerConfig; diagnostics: CloudflareDiagnostic[] } {
  try {
    let parsed: unknown;
    if (configPath.endsWith('.toml')) {
      parsed = parseToml(source);
    } else {
      const errors: Array<{ error: number; offset: number; length: number }> =
        [];
      parsed = parseJsonc(source, errors, {
        allowTrailingComma: true,
        disallowComments: false,
        allowEmptyContent: false,
      });
      if (errors.length > 0) {
        return {
          diagnostics: [
            diagnostic(
              configPath,
              'cloudflare-config-parse',
              `Cannot parse ${configPath}: ${errors
                .map(
                  (error) =>
                    `${printParseErrorCode(error.error)} at offset ${error.offset}`,
                )
                .join(', ')}.`,
            ),
          ],
        };
      }
    }
    if (!isRecord(parsed)) {
      return {
        diagnostics: [
          diagnostic(
            configPath,
            'cloudflare-config-shape',
            `${configPath} must contain a top-level object or TOML table.`,
          ),
        ],
      };
    }
    const config = parsed as WranglerConfig;
    if (typeof config.pages_build_output_dir === 'string') {
      return {
        config,
        diagnostics: [
          diagnostic(
            configPath,
            'cloudflare-pages-unsupported',
            `${configPath} configures Cloudflare Pages. Pages and Pages Functions are outside the v1 @megamono/nx-cloudflare contract.`,
          ),
        ],
      };
    }
    return { config, diagnostics: [] };
  } catch (error) {
    return {
      diagnostics: [
        diagnostic(
          configPath,
          'cloudflare-config-parse',
          `Cannot parse ${configPath}: ${error instanceof Error ? error.message : String(error)}.`,
        ),
      ],
    };
  }
}

function normalizedSelection(
  workspaceRoot: string,
  configPath: string | undefined,
): string | undefined {
  if (!configPath) return undefined;
  return isAbsolute(configPath)
    ? workspacePath(workspaceRoot, configPath)
    : normalizePath(configPath).replace(/^\.\//, '');
}

export async function collectWranglerConfigs(
  configFiles: readonly string[],
  workspaceRoot: string,
  selection: WranglerConfigSelection = {},
): Promise<WranglerConfigRecord[]> {
  const selectedPath = normalizedSelection(workspaceRoot, selection.configPath);
  const grouped = new Map<string, string[]>();
  for (const file of configFiles) {
    const configPath = isAbsolute(file)
      ? workspacePath(workspaceRoot, file)
      : normalizePath(file).replace(/^\.\//, '');
    const root = normalizePath(dirname(configPath)) || '.';
    grouped.set(root, [...(grouped.get(root) ?? []), configPath]);
  }

  const records: WranglerConfigRecord[] = [];
  for (const [root, unsortedCandidates] of [...grouped.entries()].sort()) {
    const candidates = [...new Set(unsortedCandidates)].sort();
    const selected =
      candidates.length === 1
        ? candidates[0]
        : candidates.find((candidate) => candidate === selectedPath);
    if (!selected) {
      const configPath = candidates[0];
      records.push({
        configPath,
        root,
        diagnostics: [
          diagnostic(
            configPath,
            'cloudflare-config-collision',
            `Multiple Wrangler configs exist in ${root}: ${candidates.join(', ')}. Set the plugin configPath option to select one.`,
          ),
        ],
        executable: false,
      });
      continue;
    }
    try {
      const parsed = parseWranglerConfig(
        await readFile(resolve(workspaceRoot, selected), 'utf8'),
        selected,
      );
      records.push({
        configPath: selected,
        root,
        config: parsed.config,
        diagnostics: parsed.diagnostics,
        executable: Boolean(parsed.config) && parsed.diagnostics.length === 0,
      });
    } catch (error) {
      records.push({
        configPath: selected,
        root,
        diagnostics: [
          diagnostic(
            selected,
            'cloudflare-config-read',
            `Cannot read ${selected}: ${error instanceof Error ? error.message : String(error)}.`,
          ),
        ],
        executable: false,
      });
    }
  }
  return records;
}
