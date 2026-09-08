import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const workspace = resolve(import.meta.dirname, '../../..');
const root = await mkdtemp(join(tmpdir(), 'megamono-email-preview-'));
const reportRoot = join(workspace, 'tmp/email-preview-consumer');
const exec = promisify(execFile);
const env = {
  ...Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  ),
  CI: 'true',
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  npm_config_cache: join(root, '.npm-cache'),
  npm_config_userconfig: join(root, '.npmrc'),
};
const run = async (command, args, cwd = root) =>
  (
    await exec(command, args, {
      cwd,
      env,
      timeout: 300_000,
      maxBuffer: 8_000_000,
    })
  ).stdout;
const put = async (file, content) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  schemaVersion: 1,
  node: process.version,
  status: 'running',
  checks: [],
  artifacts: [],
  limitations: [
    'Existing-preview adoption only; not the gated emails seed generator.',
    'Capture and synthetic loopback fixture only; no SMTP/provider, email-client, locale fan-out or production isolation qualification.',
  ],
};
async function check(id, action) {
  console.log(`Email preview: ${id}`);
  try {
    const result = String((await action()) ?? 'passed');
    await put(join(reportRoot, `${id}.log`), result);
    report.checks.push({ id, status: 'passed', sha256: hash(result) });
  } catch (error) {
    const result = `${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    await put(join(reportRoot, `${id}.log`), result);
    report.checks.push({ id, status: 'failed', sha256: hash(result) });
    throw error;
  }
}
try {
  await mkdir(reportRoot, { recursive: true });
  report.revision = (await run('git', ['rev-parse', 'HEAD'], workspace)).trim();
  report.dirty = Boolean(
    (await run('git', ['status', '--porcelain'], workspace)).trim(),
  );
  await put(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  const store = (await run('yalc', ['dir'])).trim();
  const dependencies = {};
  await check('pack', async () => {
    for (const directory of [
      join(workspace, 'packages/plugin'),
      ...[
        ['chakra-email', '0.1.0'],
        ['@chakra-email/core', '0.1.0'],
        ['@playstack/core', '0.1.0-beta.1'],
        ['@playstack/mail', '0.1.0-beta.1'],
      ].map(([name, version]) => join(store, 'packages', name, version)),
    ]) {
      const [packed] = JSON.parse(
        await run('npm', [
          'pack',
          directory,
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          root,
        ]),
      );
      dependencies[packed.name] = `file:./${packed.filename}`;
      report.artifacts.push({
        name: packed.name,
        version: packed.version,
        sha256: hash(await readFile(join(root, packed.filename))),
      });
    }
  });
  await put(join(root, 'package.json'), {
    name: 'email-preview-consumer',
    private: true,
    type: 'module',
    dependencies: {
      ...dependencies,
      nx: '23.1.1',
      '@nx/devkit': '23.1.1',
      typescript: '6.0.3',
      react: '19.2.4',
      'react-dom': '19.2.4',
    },
  });
  await check('install', () =>
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']),
  );
  await check('clean-install', () =>
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']),
  );
  await writeFile(
    join(reportRoot, 'package-lock.json'),
    await readFile(join(root, 'package-lock.json')),
  );
  await put(join(root, 'nx.json'), {});
  await put(join(root, 'libs/emails/project.json'), {
    name: 'emails',
    projectType: 'library',
    targets: {
      preview: {
        executor: 'nx:run-commands',
        cache: false,
        continuous: true,
        options: { command: 'node libs/emails/preview.mjs' },
      },
      contract: {
        executor: 'nx:run-commands',
        cache: false,
        options: { command: 'node libs/emails/verify.mjs' },
      },
    },
  });
  const inputs = {
    'libs/theme/email.mjs':
      'export const theme = { tokens: { colors: { brand: { 500: { value: "#13579b" } } } } };\n',
    'libs/emails/fixtures/welcome.json': '{"name":"Synthetic Reader"}',
    'libs/emails/templates/welcome.mjs': `import { createElement as h } from 'react';
import { ChakraEmailProvider, Html, Body, Text, render, renderPlainText } from 'chakra-email';
import { theme } from '../../theme/email.mjs';
export async function welcome(props) {
  if (!props || typeof props.name !== 'string' || !props.name.trim()) throw new Error('Invalid name');
  const email = h(ChakraEmailProvider, { theme }, h(Html, null, h(Body, null, h(Text, { color: 'brand.500' }, 'Welcome ' + props.name))));
  const html = await render(email);
  const text = await renderPlainText(email);
  if (Buffer.byteLength(html, 'utf8') > 100 * 1024) throw new Error('Email exceeds encoded limit');
  return { subject: 'Welcome ' + props.name, html, text };
}
`,
    'libs/emails/preview.mjs': `import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import props from './fixtures/welcome.json' with { type: 'json' };
import { welcome } from './templates/welcome.mjs';
export async function preview() {
  const output = await welcome(props);
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(output.html); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await preview();
  console.log('http://127.0.0.1:' + server.address().port);
  process.once('SIGTERM', () => server.close());
}
`,
    'libs/emails/verify.mjs': `import assert from 'node:assert/strict';
import { createMail } from '@playstack/mail';
import { CaptureMailProvider } from '@playstack/mail/testing';
import { welcome } from './templates/welcome.mjs';
import { preview } from './preview.mjs';
import props from './fixtures/welcome.json' with { type: 'json' };
const first = await welcome(props);
assert.deepEqual(await welcome(props), first);
for (const key of ['subject', 'html', 'text']) assert(first[key].includes(props.name));
assert(first.html.includes('#13579b'));
await assert.rejects(welcome({}), /Invalid name/);
await assert.rejects(welcome({ name: 'x'.repeat(110 * 1024) }), /encoded limit/);
const capture = new CaptureMailProvider();
const mail = createMail({ driver: capture, from: 'preview@example.test' });
await mail.send({ to: 'fixture@example.test', template: welcome, props });
assert.equal(capture.messages().length, 1);
assert.equal(capture.messages()[0].html, first.html);
await assert.rejects(mail.send({ to: 'fixture@example.test', template: welcome, props: {} }));
assert.equal(capture.messages().length, 1);
const server = await preview();
try {
  assert.equal(server.address().address, '127.0.0.1');
  const response = await fetch('http://127.0.0.1:' + server.address().port);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), first.html);
} finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
console.log('Deterministic subject/HTML/plaintext, shared theme, invalid props, 100 KiB limit, capture and loopback preview passed.');
`,
  };
  for (const [file, content] of Object.entries(inputs))
    await put(join(root, file), content);
  const require = createRequire(join(root, 'package.json'));
  const nxManifest = require.resolve('nx/package.json');
  const nx = join(dirname(nxManifest), require(nxManifest).bin.nx);
  const args = [
    nx,
    'generate',
    '@megamono/plugin:emails-adopt',
    '--project=emails',
    '--previewTarget=preview',
    '--verificationTarget=contract',
    '--templatesRoot=libs/emails/templates',
    '--fixturesRoot=libs/emails/fixtures',
    '--themeFile=libs/theme/email.mjs',
    '--reviewedLocalOnly',
    '--reviewedFixtureOnly',
    '--interactive=false',
  ];
  await check('plan', async () => {
    await run(process.execPath, [...args, '--planOnly', '--yes']);
    await assert.rejects(
      readFile(join(root, '.megamono/email-previews/emails.json')),
      { code: 'ENOENT' },
    );
  });
  await check('adopt-and-rerun', async () => {
    await run(process.execPath, [...args, '--yes']);
    const record = await readFile(
      join(root, '.megamono/email-previews/emails.json'),
      'utf8',
    );
    const project = await readFile(
      join(root, 'libs/emails/project.json'),
      'utf8',
    );
    await run(process.execPath, [...args, '--yes']);
    assert.equal(
      await readFile(
        join(root, '.megamono/email-previews/emails.json'),
        'utf8',
      ),
      record,
    );
    assert.equal(
      await readFile(join(root, 'libs/emails/project.json'), 'utf8'),
      project,
    );
    for (const [file, content] of Object.entries(inputs))
      assert.equal(await readFile(join(root, file), 'utf8'), content);
    assert.equal(JSON.parse(record).qualification, 'not-run');
  });
  await check('render-capture-loopback', () =>
    run(process.execPath, [nx, 'run', 'emails:megamono-emails-verify']),
  );
  await check('verification-failure-propagation', async () => {
    await put(
      join(root, 'libs/emails/verify.mjs'),
      'throw new Error("fixture verification failure");',
    );
    await assert.rejects(
      run(process.execPath, [nx, 'run', 'emails:megamono-emails-verify']),
      (error) =>
        `${error.stdout ?? ''}${error.stderr ?? ''}`.includes(
          'fixture verification failure',
        ),
    );
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const id of [
    'pack',
    'install',
    'clean-install',
    'plan',
    'adopt-and-rerun',
    'render-capture-loopback',
    'verification-failure-propagation',
  ]) {
    if (!report.checks.some((check) => check.id === id))
      report.checks.push({ id, status: 'not-run' });
  }
  await put(join(reportRoot, 'report.json'), report);
  await rm(root, { recursive: true, force: true });
}
