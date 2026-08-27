import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GENERATOR_AVAILABILITY } from './availability';
import {
  PLAYSTACK_EMISSIONS,
  compatiblePlaystackPackageVersion,
  getPlaystackEmission,
} from './emissions';

function sourceFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap((name) => {
      const path = join(root, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
    })
    .sort();
}

describe('Playstack emission registry', () => {
  it('uses unique packages and canonical generator names', () => {
    expect(new Set(PLAYSTACK_EMISSIONS.map((entry) => entry.package)).size).toBe(
      PLAYSTACK_EMISSIONS.length,
    );
    for (const emission of PLAYSTACK_EMISSIONS) {
      expect(emission.generators.length, emission.package).toBeGreaterThan(0);
      for (const generator of emission.generators) {
        if (generator.startsWith('@megamono/')) continue;
        expect(
          GENERATOR_AVAILABILITY[generator],
          `${emission.package} references unknown generator ${generator}`,
        ).toBeDefined();
      }
    }
  });

  it('registers every Playstack package named by a generator source', () => {
    const root = join(process.cwd(), 'src/generators');
    for (const path of sourceFiles(root)) {
      const source = readFileSync(path, 'utf8');
      const packages = [
        ...source.matchAll(/['"](@playstack\/[a-z0-9][a-z0-9._-]*)/g),
      ].map((match) => match[1]);
      for (const packageName of new Set(packages)) {
        expect(
          getPlaystackEmission(packageName),
          `${relative(process.cwd(), path)} emits unregistered ${packageName}`,
        ).toBeDefined();
      }
    }
  });

  it('provides the gated content generator with its exact tested version', () => {
    expect(
      compatiblePlaystackPackageVersion('content-lib', '@playstack/content'),
    ).toBe('0.1.0-beta.1');
    expect(() =>
      compatiblePlaystackPackageVersion('theme', '@playstack/chakra'),
    ).toThrow(/no compatible version/);
  });
});
