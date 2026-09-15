import { readJson, type Tree } from '@nx/devkit';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { satisfies, subset, validRange } from 'semver';

export const EXTENSION_TOOLCHAIN = {
  wxt: '0.21.4',
  vite: '8.2.2',
  esbuild: '0.28.2',
  vitest: '4.1.11',
} as const;

export function extensionTypeScript(tree: Tree): string {
  const manifest = readJson(tree, 'package.json');
  const declared = ['devDependencies', 'dependencies', 'optionalDependencies']
    .map((field) => manifest[field]?.typescript)
    .filter((value) => value !== undefined);
  const selected = declared[0] ?? '5.9.3';
  if (
    declared.some((value) => value !== selected) ||
    typeof selected !== 'string' ||
    !validRange(selected) ||
    !subset(selected, '>=5.4 <7')
  )
    throw new Error(
      'The extension requires a reviewed TypeScript range within >=5.4 <7. Align the repository declaration explicitly; catalog/workspace aliases and ambiguous ranges are not rewritten.',
    );
  return selected;
}

interface Manifest {
  name: string;
  version: string;
  engines?: { node?: string };
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function installed(
  from: string,
  name: string,
): { root: string; manifest: Manifest } | undefined {
  const resolver = createRequire(join(from, 'package.json'));
  for (const directory of resolver.resolve.paths(name) ?? []) {
    const root = join(directory, name);
    if (existsSync(join(root, 'package.json'))) {
      const manifest = JSON.parse(
        readFileSync(join(root, 'package.json'), 'utf8'),
      ) as Manifest;
      if (manifest.name !== name)
        throw new Error(`Installed identity mismatch for ${name}.`);
      return { root: realpathSync(root), manifest };
    }
  }
  return undefined;
}

/** Read manifests only; follow each installed package's own peer-resolution
 * context (including pnpm virtual-store symlinks), without importing its code. */
export function verifyExtensionToolchain(root: string): void {
  const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const issues: string[] = [];
  for (const name of ['wxt', 'vite', 'esbuild', 'vitest', 'typescript']) {
    const item = installed(root, name);
    const selected = app.devDependencies?.[name];
    if (
      !item ||
      !selected ||
      !validRange(selected) ||
      !satisfies(item.manifest.version, selected)
    ) {
      issues.push(
        `${name}: installed version is missing or does not match the application declaration`,
      );
      continue;
    }
    const { manifest } = item;
    if (
      manifest.engines?.node &&
      !satisfies(process.versions.node, manifest.engines.node)
    )
      issues.push(
        `${name}: Node ${process.versions.node} does not satisfy ${manifest.engines.node}`,
      );
    for (const [peer, range] of Object.entries(
      manifest.peerDependencies ?? {},
    )) {
      const dependency = installed(item.root, peer);
      if (!dependency && manifest.peerDependenciesMeta?.[peer]?.optional)
        continue;
      if (
        !dependency ||
        !validRange(range) ||
        !satisfies(dependency.manifest.version, range)
      )
        issues.push(`${name}: peer ${peer} must satisfy ${range}`);
      // Ensure the build and test tools use the explicitly reviewed app-local
      // compiler/bundler rather than a different compatible peer instance.
      if (dependency && ['vite', 'esbuild', 'typescript'].includes(peer)) {
        const direct = installed(root, peer);
        if (direct && dependency.manifest.version !== direct.manifest.version)
          issues.push(
            `${name}: peer ${peer} differs from the selected app-local version`,
          );
      }
    }
  }
  if (issues.length)
    throw new Error(
      `Extension toolchain verification failed:\n- ${issues.join('\n- ')}\nReview workspace overrides and resolve peers at the extension package; generation did not rewrite repository toolchain policy.`,
    );
}
