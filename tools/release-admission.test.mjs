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
import { parse } from 'yaml';

const runner = fileURLToPath(new URL('./qualify-release.mjs', import.meta.url));

test('consumer runtime switches never execute the authoring pnpm cache CLI', () => {
  const workflow = parse(
    readFileSync(
      new URL('../.github/workflows/nx-compatibility.yml', import.meta.url),
      'utf8',
    ),
  );
  for (const job of ['stable', 'portfolio']) {
    const steps = workflow.jobs[job].steps;
    const authoring = steps.find(
      (step) => step.uses === 'actions/setup-node@v5',
    );
    assert.equal(authoring.with['node-version'], 24);
    assert.equal(authoring.with.cache, 'pnpm');
    const consumerIndex = steps.findIndex(
      (step) => step.with?.['node-version'] === '${{ matrix.node }}',
    );
    assert(consumerIndex > 0);
    assert.equal(steps[consumerIndex].with['package-manager-cache'], false);
    for (const step of steps.slice(consumerIndex + 1)) {
      if (step.run?.includes('pnpm exec'))
        assert.match(step.if ?? '', /matrix\.node == 24/);
    }
  }
});

function qualify(t, refusedCommand, phase = 'checks') {
  const directory = mkdtempSync(join(tmpdir(), 'megamono-release-admission-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  const log = join(directory, 'commands.jsonl');
  mkdirSync(bin);
  const pnpm = join(bin, 'pnpm');
  writeFileSync(
    pnpm,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args.join(' ') === ${JSON.stringify(refusedCommand)}) process.exit(42);
`,
  );
  chmodSync(pnpm, 0o755);
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
    'exec nx run @megamono/plugin:e2e-expo-consumer --skip-nx-cache --output-style=stream';
  const { result, commands } = qualify(t, refused, 'consumers');
  assert.notEqual(result.status, 0);
  assert.equal(commands.at(-1).join(' '), refused);
  assert(
    !commands.some((args) =>
      args.includes('@megamono/plugin:e2e-convert-local-registry'),
    ),
  );
});
