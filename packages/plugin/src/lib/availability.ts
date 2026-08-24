import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type GeneratorAvailabilityStatus = 'available' | 'gated' | 'reserved';

export interface GeneratorAvailability {
  readonly name: string;
  readonly status: GeneratorAvailabilityStatus;
  readonly gate?: string;
}

interface AvailabilityRegistry {
  readonly version: number;
  readonly generators: Readonly<
    Record<
      string,
      {
        readonly status: GeneratorAvailabilityStatus;
        readonly gate?: string;
      }
    >
  >;
}

const registry = JSON.parse(
  readFileSync(join(__dirname, '../../availability.json'), 'utf8'),
) as AvailabilityRegistry;

if (registry.version !== 1) {
  throw new Error(
    `Unsupported Megamono availability registry version ${registry.version}.`,
  );
}

export const GENERATOR_AVAILABILITY: Readonly<
  Record<string, GeneratorAvailability>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(registry.generators).map(([name, entry]) => [
      name,
      Object.freeze({ name, status: entry.status, gate: entry.gate }),
    ]),
  ),
);

export class GeneratorAvailabilityError extends Error {
  readonly exitCode = 3;
  readonly diagnosticCode: string;

  constructor(readonly availability: GeneratorAvailability) {
    super(
      availability.status === 'available'
        ? `Generator ${availability.name} is available.`
        : `Generator ${availability.name} is ${availability.status}: ${availability.gate}`,
    );
    this.name = 'GeneratorAvailabilityError';
    this.diagnosticCode = `generator-${availability.status}`;
  }
}

export function getGeneratorAvailability(
  name: string,
): GeneratorAvailability | undefined {
  return GENERATOR_AVAILABILITY[name];
}

export function assertGeneratorAvailable(name: string): void {
  const availability = getGeneratorAvailability(name);
  if (!availability) {
    throw new GeneratorAvailabilityError({
      name,
      status: 'reserved',
      gate: 'No canonical Megamono generator uses this name.',
    });
  }
  if (availability.status !== 'available') {
    throw new GeneratorAvailabilityError(availability);
  }
}
