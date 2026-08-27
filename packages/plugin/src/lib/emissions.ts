import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type EmissionAvailability = 'gated' | 'available' | 'reserved';
export type EmissionDependencyType = 'runtime' | 'development';
export type EmissionTier = 'free' | 'pro-optional';

export interface PlaystackEmission {
  readonly package: `@playstack/${string}`;
  readonly generators: readonly string[];
  readonly purpose: string;
  readonly dependencyType: EmissionDependencyType;
  readonly requiredTier: EmissionTier;
  readonly compatibleVersion: string | null;
  readonly availability: EmissionAvailability;
}

interface EmissionRegistry {
  readonly schemaVersion: number;
  readonly emissions: readonly PlaystackEmission[];
}

const registry = JSON.parse(
  readFileSync(join(__dirname, '../../emissions.json'), 'utf8'),
) as EmissionRegistry;

if (registry.schemaVersion !== 1) {
  throw new Error(
    `Unsupported Megamono emission registry version ${registry.schemaVersion}.`,
  );
}

const packages = new Set<string>();
for (const emission of registry.emissions) {
  if (!/^@playstack\/[a-z0-9][a-z0-9._-]*$/.test(emission.package)) {
    throw new Error(`Invalid emitted Playstack package ${emission.package}.`);
  }
  if (packages.has(emission.package)) {
    throw new Error(`Duplicate emitted Playstack package ${emission.package}.`);
  }
  packages.add(emission.package);
}

export const PLAYSTACK_EMISSIONS: readonly PlaystackEmission[] = Object.freeze(
  registry.emissions.map((emission) =>
    Object.freeze({
      ...emission,
      generators: Object.freeze([...emission.generators]),
    }),
  ),
);

export function getPlaystackEmission(
  packageName: string,
): PlaystackEmission | undefined {
  return PLAYSTACK_EMISSIONS.find(
    (emission) => emission.package === packageName,
  );
}

export function compatiblePlaystackPackageVersion(
  generator: string,
  packageName: string,
): string {
  const emission = getPlaystackEmission(packageName);
  if (!emission || !emission.generators.includes(generator)) {
    throw new Error(
      `${generator} emits unregistered Playstack package ${packageName}.`,
    );
  }
  if (!emission.compatibleVersion) {
    throw new Error(
      `${generator} is gated because ${packageName} has no compatible version.`,
    );
  }
  return emission.compatibleVersion;
}
