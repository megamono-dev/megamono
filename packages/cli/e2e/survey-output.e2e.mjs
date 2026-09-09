import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

// Real packed CLI and OS pipes; deliberately synthetic Nx producer. Real
// npm/Nx/generator/staging qualification lives in e2e-isolated-yalc-survey.
const workspace = resolve(import.meta.dirname, '../../..');
const root = await mkdtemp(join(tmpdir(), 'megamono-survey-output-'));
const require = createRequire(join(workspace, 'package.json'));
const put = async (file, value) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
};
try {
  const [packed] = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        join(workspace, 'packages/cli'),
        '--ignore-scripts',
        '--offline',
        '--pack-destination',
        root,
        '--json',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, npm_config_cache: join(root, 'npm-cache') },
      },
    ),
  );
  execFileSync('tar', ['-xzf', join(root, packed.filename), '-C', root]);
  for (const name of ['enquirer', 'semver', 'tslib']) {
    const target = join(root, 'package/node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(dirname(require.resolve(`${name}/package.json`)), target);
  }
  const consumer = join(root, 'consumer');
  await put(join(consumer, 'package.json'), {
    name: 'pipe-fixture',
    private: true,
  });
  await put(join(consumer, 'nx.json'), {});
  await put(join(consumer, 'node_modules/@megamono/plugin/package.json'), {
    name: '@megamono/plugin',
    version: '0.0.1',
  });
  await put(join(consumer, 'node_modules/nx/package.json'), {
    name: 'nx',
    version: '23.1.1',
    bin: { nx: './bin/cli.js' },
  });
  const survey = {
    schemaVersion: 1,
    baseline: {},
    inventory: {},
    recommendations: [],
    projects: Array.from({ length: 1500 }, (_, index) => ({
      name: `project-${index}`,
      detail: 'Unicode café 日本語 { "quoted" } '.repeat(8),
    })),
  };
  assert(Buffer.byteLength(JSON.stringify(survey)) > 65_536);
  const producer = join(consumer, 'node_modules/nx/bin/cli.js');
  const run = (mode) =>
    new Promise((resolveRun, reject) => {
      const child = spawn(
        process.execPath,
        [join(root, 'package/dist/bin.js'), 'adopt', '--format=json'],
        {
          cwd: consumer,
          env: { ...process.env, SURVEY_FIXTURE_MODE: mode },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const chunks = [],
        errors = [];
      child.stdout.on('data', (chunk) => {
        chunks.push(chunk);
        // A slow downstream consumer must not lose the tail at CLI exit.
        child.stdout.pause();
        setTimeout(() => child.stdout.resume(), 2);
      });
      child.stderr.on('data', (chunk) => errors.push(chunk));
      child.on('error', reject);
      child.on('close', (code) =>
        resolveRun({
          code,
          stdout: Buffer.concat(chunks).toString('utf8'),
          stderr: Buffer.concat(errors).toString('utf8'),
        }),
      );
    });
  await put(
    producer,
    `
const mode = process.env.SURVEY_FIXTURE_MODE;
process.stdout.write('NX Generating banner\\n');
if (mode === 'graph') { process.stdout.write('Failed to process project graph\\n'); process.exitCode = 7; }
else if (mode === 'invalid') process.stdout.write('{"schemaVersion":1');
else {
  const text = JSON.stringify(${JSON.stringify(survey)});
  for (let i = 0; i < text.length; i += 4093) process.stdout.write(text.slice(i, i + 4093));
  process.stdout.write('\\nNOTE: dry run\\n');
}
`,
  );
  const success = await run('success');
  assert.equal(success.code, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout), survey);
  assert.match(success.stderr, /NX Generating/);
  for (const [mode, code, errorCode] of [
    ['graph', 7, 'survey-command-failed'],
    ['invalid', 3, 'survey-output-invalid'],
  ]) {
    const result = await run(mode);
    assert.equal(result.code, code);
    assert.equal(result.stdout, '');
    assert.equal(
      JSON.parse(result.stderr.trim().split('\n').at(-1)).code,
      errorCode,
    );
  }
  console.log(
    `Packed CLI pipe qualification passed: ${Buffer.byteLength(success.stdout)} bytes, Unicode, slow reader, graph and malformed-output failures.`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
