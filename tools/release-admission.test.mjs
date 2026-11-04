import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./qualify-release.mjs', import.meta.url));

function qualify(t, refusedCommand, phase = 'checks') {
  const directory = mkdtempSync(join(tmpdir(), 'megamono-release-admission-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  const log = join(directory, 'commands.jsonl');
  mkdirSync(bin);
  const npm = join(bin, 'npm');
  writeFileSync(
    npm,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args.join(' ') === ${JSON.stringify(refusedCommand)}) process.exit(42);
`,
  );
  chmodSync(npm, 0o755);
  const result = spawnSync(process.execPath, [runner], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      MEGAMONO_QUALIFY_PHASE: phase,
    },
  });
  return {
    result,
    commands: readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  };
}

test('a failed installed-artifact check prevents audit, builds, and release qualification', (t) => {
  const { result, commands } = qualify(t, 'run tooling:check');
  assert.notEqual(result.status, 0);
  assert.deepEqual(commands, [['run', 'tooling:check']]);
});

test('a failed tooling consumer fixture prevents audit, builds, and release qualification', (t) => {
  const { result, commands } = qualify(t, 'run tooling:test');
  assert.notEqual(result.status, 0);
  assert.deepEqual(commands, [
    ['run', 'tooling:check'],
    ['run', 'tooling:test'],
  ]);
});

test('an unignored advisory prevents builds and release qualification', (t) => {
  const { result, commands } = qualify(t, 'run security:audit');
  assert.notEqual(result.status, 0);
  assert.deepEqual(commands, [
    ['run', 'tooling:check'],
    ['run', 'tooling:test'],
    ['run', 'security:audit'],
  ]);
});

test('a failed packed Expo qualification prevents subsequent release consumers', (t) => {
  const refused =
    'exec nx -- run @megamono/plugin:e2e-expo-consumer --skip-nx-cache --output-style=stream';
  const { result, commands } = qualify(t, refused, 'consumers');
  assert.notEqual(result.status, 0);
  assert.equal(commands.at(-1).join(' '), refused);
  assert(
    !commands.some((args) =>
      args.includes('@megamono/plugin:e2e-convert-local-registry'),
    ),
  );
});
