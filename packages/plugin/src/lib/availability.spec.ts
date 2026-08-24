import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GENERATOR_AVAILABILITY,
  GeneratorAvailabilityError,
  assertGeneratorAvailable,
  getGeneratorAvailability,
} from './availability';

interface AvailabilityEntry {
  readonly status: string;
  readonly gate?: string;
  readonly [key: string]: unknown;
}

interface CollectionRegistry {
  readonly generators: Record<string, AvailabilityEntry>;
  readonly executors: Record<string, AvailabilityEntry>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'));
}

function publishedEntries(
  entries: Readonly<Record<string, AvailabilityEntry>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([name, entry]) => {
      if (entry.status !== 'available') return [];
      const descriptor: Record<string, unknown> = { ...entry };
      delete descriptor.status;
      delete descriptor.gate;
      return [[name, descriptor]];
    }),
  );
}

describe('published collection availability', () => {
  const availability = readJson('availability.json') as CollectionRegistry;
  const generators = readJson('generators.json') as {
    readonly generators: Record<string, unknown>;
  };
  const executors = readJson('executors.json') as {
    readonly executors: Record<string, unknown>;
  };

  it('publishes exactly the available generators and executors', () => {
    expect(generators.generators).toEqual(
      publishedEntries(availability.generators),
    );
    expect(executors.executors).toEqual(
      publishedEntries(availability.executors),
    );
    expect(Object.keys(GENERATOR_AVAILABILITY)).toEqual(
      Object.keys(availability.generators),
    );
  });

  it('requires a diagnostic for every gated or reserved generator', () => {
    for (const [name, entry] of Object.entries(availability.generators)) {
      if (entry.status === 'available') continue;
      expect(entry.gate, name).toBeTruthy();
      expect(() => assertGeneratorAvailable(name)).toThrow(
        GeneratorAvailabilityError,
      );
    }
  });

  it('reports stable gated, available, and unknown outcomes', () => {
    expect(getGeneratorAvailability('docs-spec')?.status).toBe('available');
    expect(getGeneratorAvailability('integration-sentry')).toMatchObject({
      status: 'gated',
      gate: expect.stringContaining('fixture contract'),
    });
    expect(() => assertGeneratorAvailable('docs-spec')).not.toThrow();
    expect(() => assertGeneratorAvailable('not-a-generator')).toThrow(
      /No canonical Megamono generator uses this name/,
    );
  });
});
