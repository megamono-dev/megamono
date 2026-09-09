import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const workspace = resolve(import.meta.dirname, '../../..');
const root = await mkdtemp(join(tmpdir(), 'megamono-survey-isolation-'));
const store = join(root, 'store');
const toolsRoot = join(root, 'tools');
const reportRoot = join(workspace, 'tmp/survey-isolation');
const exec = promisify(execFile);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const put = async (file, content) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
};
const env = {
  ...Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  ),
  CI: 'true',
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  NX_INTERACTIVE: 'false',
  NODE_DISABLE_COMPILE_CACHE: '1',
  NX_SKIP_NATIVE_FILE_CACHE: 'true',
  npm_config_cache: join(root, 'npm-cache'),
  npm_config_userconfig: join(root, '.npmrc'),
};
const run = async (command, args, cwd = root, extraEnv = {}) =>
  (
    await exec(command, args, {
      cwd,
      env: { ...env, ...extraEnv },
      timeout: 300_000,
      maxBuffer: 12_000_000,
    })
  ).stdout;
const report = {
  schemaVersion: 1,
  status: 'running',
  node: process.version,
  checks: [],
  artifacts: [],
  scope:
    'Real packed CLI, Yalc, npm and Nx; two synthetic consumers, not FlightPaths runtime qualification',
};
async function check(id, action) {
  console.log(`Survey isolation: ${id}`);
  try {
    const output = String((await action()) ?? 'passed');
    await put(join(reportRoot, `${id}.log`), output);
    report.checks.push({ id, status: 'passed', sha256: digest(output) });
  } catch (error) {
    const output = `${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    await put(join(reportRoot, `${id}.log`), output);
    report.checks.push({ id, status: 'failed', sha256: digest(output) });
    throw error;
  }
}
// Hash every entry, including installed files and symlink identities. Do not
// follow symlinks outside the consumer, or ignore .nx/package-manager changes.
async function snapshot(directory, relative = '') {
  const result = {};
  for (const entry of (
    await readdir(join(directory, relative), { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(relative, entry.name);
    if (entry.isSymbolicLink())
      result[file] = `link:${await readlink(join(directory, file))}`;
    else if (entry.isDirectory()) {
      result[file] = 'directory';
      Object.assign(result, await snapshot(directory, file));
    } else result[file] = digest(await readFile(join(directory, file)));
  }
  return result;
}
async function permissions(directory, writable) {
  await chmod(directory, writable ? 0o755 : 0o555);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await permissions(file, writable);
    else if (!entry.isSymbolicLink())
      await chmod(file, writable ? 0o644 : 0o444);
  }
}
let locked = false;
try {
  assert.notEqual(
    process.platform,
    'win32',
    'POSIX read-only permissions fixture; Windows ACL qualification is separate',
  );
  await mkdir(reportRoot, { recursive: true });
  await put(join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  report.revision = (await run('git', ['rev-parse', 'HEAD'], workspace)).trim();
  report.dirty = Boolean(
    (await run('git', ['status', '--porcelain'], workspace)).trim(),
  );
  const globalStore = (await run('yalc', ['dir'])).trim();
  const globalRegistry = join(globalStore, 'installations.json');
  const globalBefore = await readFile(globalRegistry);
  const tarballs = {};
  await check('pack', async () => {
    for (const directory of ['cli', 'plugin']) {
      const [packed] = JSON.parse(
        await run('npm', [
          'pack',
          join(workspace, 'packages', directory),
          '--pack-destination',
          root,
          '--ignore-scripts',
          '--json',
        ]),
      );
      tarballs[directory] = join(root, packed.filename);
      report.artifacts.push({
        name: packed.name,
        version: packed.version,
        sha256: digest(await readFile(tarballs[directory])),
      });
    }
    const plugin = join(store, 'packages/@megamono/plugin/0.0.1');
    await mkdir(plugin, { recursive: true });
    await run('tar', [
      '-xzf',
      tarballs.plugin,
      '-C',
      plugin,
      '--strip-components=1',
    ]);
    await put(join(store, 'installations.json'), {
      sentinel: ['not-a-consumer'],
    });
  });
  await put(join(toolsRoot, 'package.json'), {
    private: true,
    dependencies: {
      '@megamono/cli': `file:${tarballs.cli}`,
      yalc: '1.0.0-pre.53',
    },
  });
  await check('install-cli-and-yalc', () =>
    run(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
      toolsRoot,
    ),
  );
  // Delegate every command to real Yalc; only choose its supported in-process
  // store setting, without changing HOME or registering against the real store.
  const shim = join(root, 'bin/yalc');
  await put(
    shim,
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(join(root, 'yalc-commands.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\nrequire(${JSON.stringify(join(toolsRoot, 'node_modules/yalc/src/index.js'))}).yalcGlobal.yalcStoreMainDir = ${JSON.stringify(store)};\nrequire(${JSON.stringify(join(toolsRoot, 'node_modules/yalc/src/yalc.js'))});\n`,
  );
  await chmod(shim, 0o755);
  const lanes = [
    { name: 'int', nx: '22.7.8', typescript: '5.9.3' },
    { name: 'js', nx: '23.1.1', typescript: '6.0.3' },
  ];
  for (const lane of lanes) {
    lane.root = join(root, lane.name);
    await put(join(lane.root, 'package.json'), {
      name: `survey-${lane.name}`,
      private: true,
      devDependencies: {
        nx: lane.nx,
        '@nx/devkit': lane.nx,
        typescript: lane.typescript,
      },
    });
    await put(join(lane.root, 'nx.json'), { analytics: false });
    // Real graph/generator output, not padding appended after serialization.
    for (let index = 0; index < 220; index++) {
      await put(join(lane.root, `libs/feature-${index}/project.json`), {
        name: `@fixture-${lane.name}/feature-${index}`,
        projectType: 'library',
        tags: ['scope:shared', 'type:util', 'platform:node'],
        targets: {},
      });
    }
    await put(join(lane.root, 'apps/api/project.json'), {
      name: `@fixture-${lane.name}/api`,
      projectType: 'application',
      targets: {},
    });
    await put(
      join(lane.root, 'apps/api/src/main.ts'),
      'export const synthetic = true;\n',
    );
    await put(
      join(lane.root, 'unrelated-local-artifact.txt'),
      'Preserve unrelated files.\n',
    );
    await check(`install-${lane.name}`, () =>
      run(
        'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
        lane.root,
      ),
    );
    lane.before = await snapshot(lane.root);
  }
  const storeBefore = await snapshot(store);
  await permissions(store, false);
  locked = true;
  await check('read-only-enforced', async () => {
    await assert.rejects(
      writeFile(join(store, 'installations.json'), 'must fail'),
      { code: 'EACCES' },
    );
    await assert.rejects(
      writeFile(join(store, 'new-registration'), 'must fail'),
      { code: 'EACCES' },
    );
  });
  const scratch = join(root, 'scratch');
  await mkdir(scratch);
  for (const lane of lanes) {
    await check(`survey-${lane.name}`, async () => {
      const output = await run(
        process.execPath,
        [
          join(toolsRoot, 'node_modules/@megamono/cli/dist/bin.js'),
          'adopt',
          '--survey',
          '--format=json',
          '--local-packages=yalc',
        ],
        lane.root,
        { PATH: `${join(root, 'bin')}:${env.PATH}`, TMPDIR: scratch },
      );
      const survey = JSON.parse(output);
      assert(
        Buffer.byteLength(output) > 65_536,
        'Survey must exercise the former 64 KiB boundary',
      );
      assert.equal(
        survey.projects.filter(({ name }) =>
          name.startsWith(`@fixture-${lane.name}/feature-`),
        ).length,
        220,
      );
      lane.surveyBytes = Buffer.byteLength(output);
      assert(
        survey.projects.some(
          ({ name }) => name === `@fixture-${lane.name}/api`,
        ),
        'Real Nx inventory did not contain the nested project',
      );
      return output;
    });
    await check(`unchanged-${lane.name}`, async () => {
      assert.deepEqual(
        await snapshot(lane.root),
        lane.before,
        'Consumer bytes or filesystem entries changed',
      );
      assert.deepEqual(
        await snapshot(store),
        storeBefore,
        'Read-only Yalc store changed',
      );
      assert.equal(
        (await readdir(scratch)).filter((name) =>
          name.startsWith('megamono-survey-'),
        ).length,
        0,
        'Survey staging leaked',
      );
    });
  }
  await check('global-registry-and-command-audit', async () => {
    assert(
      (await readFile(globalRegistry)).equals(globalBefore),
      'Shared global installation registry changed',
    );
    const commands = (await readFile(join(root, 'yalc-commands.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(
      commands,
      [['dir'], ['dir']],
      'Survey invoked a mutating Yalc command',
    );
    report.globalRegistrySha256 = digest(globalBefore);
    report.storeSnapshotSha256 = digest(JSON.stringify(storeBefore));
    report.consumers = lanes.map((lane) => ({
      name: lane.name,
      nx: lane.nx,
      typescript: lane.typescript,
      entries: Object.keys(lane.before).length,
      snapshotSha256: digest(JSON.stringify(lane.before)),
    }));
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await put(join(reportRoot, 'report.json'), report);
  // Failure probes can leave a copied read-only package behind. Restore only
  // this fixture's private directory modes before removing its own scratch tree.
  if (locked) await permissions(root, true);
  await rm(root, { recursive: true, force: true });
}
