import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(
  await readFile(join(packageRoot, 'availability.json'), 'utf8'),
);

if (registry.version !== 1) {
  throw new Error(
    `Unsupported availability registry version ${registry.version}.`,
  );
}

function collection(kind, entries) {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([name, entry]) => {
      if (entry.status !== 'available') {
        if (!entry.gate) {
          throw new Error(
            `${kind} ${name} is ${entry.status} without a gate diagnostic.`,
          );
        }
        return [];
      }
      const descriptor = { ...entry };
      delete descriptor.status;
      delete descriptor.gate;
      return [[name, descriptor]];
    }),
  );
}

await Promise.all([
  writeFile(
    join(packageRoot, 'generators.json'),
    `${JSON.stringify({ generators: collection('generator', registry.generators) }, null, 2)}\n`,
  ),
  writeFile(
    join(packageRoot, 'executors.json'),
    `${JSON.stringify({ executors: collection('executor', registry.executors) }, null, 2)}\n`,
  ),
]);
