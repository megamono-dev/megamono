import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Qualifies the emitted default SDK with a fresh web workspace. SDK54 adoption
// has a separate lane; neither lane claims native/cloud build qualification.
const workspace = resolve(import.meta.dirname, '../../..');
const compatibility = JSON.parse(
  await readFile(join(workspace, 'packages/plugin/compatibility.json'), 'utf8'),
);
const versions = {
  nx: compatibility.scaffoldPackages['@nx/expo'],
  expo: compatibility.expoSdks.defaultVersion,
  webReact: '19.3.1',
  next: '16.4.3',
  typesReact: '19.3.0',
  typesReactDom: '19.3.0',
  typescript: '6.0.3',
  doctor: '1.21.6',
};
const root = await mkdtemp(join(tmpdir(), 'megamono-expo-default-consumer-'));
const artifacts = join(workspace, 'tmp/expo-default-consumer');
const app = join(root, 'apps/mobile');
const reportPath = join(artifacts, 'report.json');
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  scope:
    'Locally packed plugin, default SDK fresh-mobile generation, Doctor and JavaScript exports; no native/cloud/registry-publication claim.',
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  versions,
  status: 'preparing',
  checks: [],
};
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('NX_') &&
        !key.startsWith('EXPO_') &&
        !key.startsWith('GIT_'),
    ),
  ),
  CI: 'true',
  NX_DAEMON: 'false',
  NX_ISOLATE_PLUGINS: 'false',
  NX_INTERACTIVE: 'false',
  EXPO_NO_TELEMETRY: '1',
  npm_config_cache: process.env.MEGAMONO_NPM_CACHE ?? join(root, 'npm-cache'),
};
const save = () =>
  writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 25 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    killSignal: 'SIGKILL',
  });
const put = async (file, value) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
  );
};
async function check(id, action) {
  report.currentCheck = id;
  await save();
  const started = Date.now();
  console.log(`Default Expo: ${id}`);
  try {
    const output = await action();
    await put(join(artifacts, `${id}.log`), String(output ?? 'passed'));
    report.checks.push({
      id,
      status: 'passed',
      durationMs: Date.now() - started,
    });
  } catch (error) {
    await put(
      join(artifacts, `${id}.log`),
      `${error.stack}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`,
    );
    report.checks.push({
      id,
      status: 'failed',
      durationMs: Date.now() - started,
    });
    throw error;
  } finally {
    delete report.currentCheck;
    await save();
  }
}
async function files(path) {
  return (
    await Promise.all(
      (await readdir(path, { withFileTypes: true })).map((entry) => {
        const file = join(path, entry.name);
        return entry.isDirectory() ? files(file) : [file];
      }),
    )
  ).flat();
}
function noRootSdk(manifest) {
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ])
    for (const name of ['expo', 'react-native'])
      assert.equal(
        manifest[section]?.[name],
        undefined,
        `Initial root must not declare ${section}.${name}`,
      );
}
try {
  await mkdir(artifacts, { recursive: true });
  report.npm = run('npm', ['--version']).trim();
  const packed = JSON.parse(
    run('npm', [
      'pack',
      join(workspace, 'packages/plugin'),
      '--ignore-scripts',
      '--pack-destination',
      root,
      '--json',
    ]),
  )[0];
  report.packedPlugin = {
    filename: packed.filename,
    integrity: packed.integrity,
    sha256: createHash('sha256')
      .update(await readFile(join(root, packed.filename)))
      .digest('hex'),
  };
  await put(join(root, 'package.json'), {
    name: 'megamono-expo-default-consumer',
    version: '0.0.0',
    private: true,
    packageManager: 'npm@' + report.npm,
    workspaces: ['apps/*'],
    dependencies: { react: versions.webReact, 'react-dom': versions.webReact },
    devDependencies: {
      '@megamono/plugin': 'file:./' + packed.filename,
      '@nx/devkit': versions.nx,
      '@nx/expo': versions.nx,
      nx: versions.nx,
      typescript: versions.typescript,
      '@types/react': versions.typesReact,
      '@types/react-dom': versions.typesReactDom,
      'expo-doctor': versions.doctor,
    },
  });
  await put(join(root, 'apps/web/package.json'), {
    name: '@fixture/web',
    private: true,
    version: '0.0.0',
    dependencies: {
      next: versions.next,
      react: versions.webReact,
      'react-dom': versions.webReact,
    },
    nx: { tags: ['platform:web', 'scope:shared', 'type:app'] },
  });
  await put(
    join(root, 'apps/web/pages/index.tsx'),
    'export default function Page() { return <main>Independent web React</main>; }\n',
  );
  await put(join(root, 'nx.json'), {
    analytics: false,
    defaultBase: 'main',
    namedInputs: { default: ['{projectRoot}/**/*'] },
  });
  await put(join(root, 'tsconfig.base.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      esModuleInterop: true,
      skipLibCheck: true,
      paths: {},
    },
  });
  await put(join(root, 'tsconfig.json'), {
    extends: './tsconfig.base.json',
    files: [],
    references: [],
  });
  await put(
    join(root, '.gitignore'),
    'node_modules/\n.nx/\ndist/\n.expo/\nnpm-cache/\n',
  );
  await check('public-sdk-metadata', async () => {
    const url = `https://registry.npmjs.org/expo/${versions.expo}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const metadata = JSON.parse(raw);
    assert.equal(metadata.name, 'expo');
    assert.equal(metadata.version, versions.expo);
    report.publicSdkMetadata = {
      url,
      checkedAt: new Date().toISOString(),
      rawSha256: createHash('sha256').update(raw).digest('hex'),
      version: metadata.version,
      integrity: metadata.dist?.integrity,
    };
    return JSON.stringify({
      name: metadata.name,
      version: metadata.version,
      engines: metadata.engines,
      peerDependencies: metadata.peerDependencies,
    });
  });
  noRootSdk(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')));
  await check('framework-install', () =>
    run('npm', [
      'install',
      '--include=dev',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
    ]),
  );
  noRootSdk(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')));

  const require = createRequire(join(root, 'package.json'));
  assert.throws(
    () => require.resolve('expo/package.json'),
    { code: 'MODULE_NOT_FOUND' },
    'Framework install must begin without an installed Root Expo SDK.',
  );
  const nxManifest = require('nx/package.json');
  report.framework = Object.fromEntries(
    ['nx', '@nx/expo'].map((name) => {
      const manifest = require(`${name}/package.json`);
      return [
        name,
        { version: manifest.version, engines: manifest.engines ?? null },
      ];
    }),
  );
  assert.equal(nxManifest.version, versions.nx);
  assert.equal(report.framework['@nx/expo'].version, versions.nx);
  const nxBin = join(
    dirname(require.resolve('nx/package.json')),
    nxManifest.bin.nx,
  );
  const nx = (...args) => run(process.execPath, [nxBin, ...args]);
  await check('normal-feature-branch-adoption', async () => {
    run('git', ['init', '--initial-branch=main']);
    run('git', ['config', 'user.name', 'Megamono Fixture']);
    run('git', ['config', 'user.email', 'fixture@example.invalid']);
    run('git', ['config', 'commit.gpgSign', 'false']);
    await mkdir(join(root, '.git/fixture-hooks'), { recursive: true });
    run('git', ['config', 'core.hooksPath', join(root, '.git/fixture-hooks')]);
    run('git', ['add', '--all']);
    run('git', ['commit', '--message', 'Prepare default web workspace']);
    run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    run('git', [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]);
    run('git', ['switch', '--create', 'fixture/default-expo']);
    const output = nx(
      'generate',
      '@megamono/plugin:workspace-init',
      '--only=ci',
      '--yes',
      '--interactive=false',
    );
    run('git', ['add', '--all']);
    run('git', ['commit', '--message', 'Adopt Megamono CI']);
    assert.equal(run('git', ['status', '--porcelain']).trim(), '');
    return output;
  });
  const rootBefore = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  );
  noRootSdk(rootBefore);
  const webBefore = await readFile(join(root, 'apps/web/package.json'), 'utf8');
  await check('normal-mobile-generation-and-install', () =>
    nx(
      'generate',
      '@megamono/plugin:app',
      '--type=mobile',
      '--name=mobile',
      '--scope=fixture',
      '--yes',
      '--interactive=false',
    ),
  );
  const rootAfter = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  );
  noRootSdk(rootAfter);
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ])
    for (const [name, value] of Object.entries(rootBefore[section] ?? {}))
      assert.equal(
        rootAfter[section]?.[name],
        value,
        `Generation must preserve ${section}.${name}`,
      );
  assert.equal(
    await readFile(join(root, 'apps/web/package.json'), 'utf8'),
    webBefore,
  );
  const local = createRequire(join(app, 'package.json'));
  const sdk = local('expo/package.json');
  const react = local('react/package.json');
  assert.equal(sdk.version, versions.expo);
  const selectedSdk =
    compatibility.expoSdks.snapshots[sdk.version.split('.')[0]];
  assert.equal(react.version, selectedSdk.requirements.react);
  assert.equal(
    local('react-native/package.json').version,
    selectedSdk.requirements['react-native'],
  );
  assert.equal(require('react/package.json').version, versions.webReact);
  report.resolved = {
    expo: sdk.version,
    expoEngines: sdk.engines ?? null,
    nativeEngines: local('react-native/package.json').engines ?? null,
    react: react.version,
    native: local('react-native/package.json').version,
    webReact: require('react/package.json').version,
    doctor: local('expo-doctor/package.json').version,
    babelPreset: local('babel-preset-expo/package.json').version,
    typesReact: local('@types/react/package.json').version,
  };
  const sdkResponse = await fetch(
    `https://registry.npmjs.org/expo/${sdk.version}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  assert.equal(sdkResponse.status, 200);
  const sdkRaw = await sdkResponse.text();
  const sdkMetadata = JSON.parse(sdkRaw);
  report.resolvedSdkMetadata = {
    url: `https://registry.npmjs.org/expo/${sdk.version}`,
    checkedAt: new Date().toISOString(),
    version: sdkMetadata.version,
    rawSha256: createHash('sha256').update(sdkRaw).digest('hex'),
    integrity: sdkMetadata.dist?.integrity,
  };
  const project = JSON.parse(nx('show', 'project', 'fixture-mobile', '--json'));
  const exportTarget = Object.entries(project.targets).find(
    ([, value]) =>
      (value.command ?? value.options?.command) === 'expo export' ||
      value.executor === '@nx/expo:export',
  );
  assert(exportTarget, 'Generated export target must exist.');
  assert(
    exportTarget[1].dependsOn.some(
      (dependency) =>
        dependency === 'expo-doctor' || dependency.target === 'expo-doctor',
    ),
  );
  assert.equal(
    project.targets['expo-doctor'].executor,
    '@megamono/plugin:expo-doctor',
  );
  const metro = await readFile(join(app, 'metro.config.js'), 'utf8');
  const manifestBefore = await readFile(join(app, 'package.json'), 'utf8');
  const lockBefore = await readFile(join(root, 'package-lock.json'));
  const inferredArgs =
    exportTarget[1].options?.args ?? exportTarget[1].args ?? '';
  assert(
    typeof inferredArgs === 'string' ||
      (Array.isArray(inferredArgs) &&
        inferredArgs.every((value) => typeof value === 'string')),
  );
  const commandArgs = [
    Array.isArray(inferredArgs) ? inferredArgs.join(' ') : inferredArgs,
    '--platform all --source-maps --no-bytecode --max-workers 1',
  ]
    .filter(Boolean)
    .join(' ');
  const exportOptions =
    (exportTarget[1].command ?? exportTarget[1].options?.command)
      ? ['--args=' + commandArgs]
      : ['--platform=all', '--sourceMaps', '--maxWorkers=1'];
  report.exportQualification = {
    target: exportTarget[0],
    inferredArgs,
    options: exportOptions,
  };
  await check('doctor-and-platform-exports', () =>
    nx(
      'run',
      'fixture-mobile:' + exportTarget[0],
      '--skip-nx-cache',
      '--output-style=static',
      ...exportOptions,
    ),
  );
  assert.equal(await readFile(join(app, 'metro.config.js'), 'utf8'), metro);
  assert.equal(
    await readFile(join(app, 'package.json'), 'utf8'),
    manifestBefore,
  );
  assert.deepEqual(await readFile(join(root, 'package-lock.json')), lockBefore);
  await check('native-bundle-react-isolation', async () => {
    const maps = (await files(join(app, 'dist'))).filter((file) =>
      file.endsWith('.map'),
    );
    for (const platform of ['ios', 'android']) {
      const selected = maps.filter((file) => file.includes(`/${platform}/`));
      assert(selected.length);
      const implementations = [];
      const modules = [];
      for (const file of selected) {
        const map = JSON.parse(await readFile(file, 'utf8'));
        map.sources.forEach((source, index) => {
          if (/node_modules\/react(?:-dom)?\//.test(source))
            modules.push(source);
          if (/node_modules\/react\/cjs\/react\.production\.js$/.test(source))
            implementations.push({
              source,
              content: map.sourcesContent[index],
            });
        });
      }
      assert.equal(implementations.length, 1);
      for (const source of modules)
        assert.match(source, /apps\/mobile\/node_modules\/react(?:-dom)?\//);
      assert(implementations[0].content.includes(`"${react.version}"`));
      assert(!implementations[0].content.includes(`"${versions.webReact}"`));
    }
    return JSON.stringify({
      maps: maps.map((file) => file.slice(app.length + 1)),
    });
  });
  await check('generated-typecheck', () =>
    project.targets.typecheck
      ? nx(
          'run',
          'fixture-mobile:typecheck',
          '--skip-nx-cache',
          '--output-style=static',
        )
      : run(process.execPath, [
          require.resolve('typescript/bin/tsc'),
          '--project',
          'apps/mobile/tsconfig.app.json',
          '--noEmit',
        ]),
  );
  await check('generated-default-jest', () => {
    assert(project.targets.test);
    return nx(
      'run',
      'fixture-mobile:test',
      '--runInBand',
      '--watch=false',
      '--no-watchman',
      '--skip-nx-cache',
      '--output-style=static',
    );
  });
  assert.equal(await readFile(join(app, 'metro.config.js'), 'utf8'), metro);
  assert.equal(
    await readFile(join(app, 'package.json'), 'utf8'),
    manifestBefore,
  );
  assert.deepEqual(await readFile(join(root, 'package-lock.json')), lockBefore);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  try {
    const lock = await readFile(join(root, 'package-lock.json'));
    report.lockfileSha256 = createHash('sha256').update(lock).digest('hex');
    await writeFile(join(artifacts, 'package-lock.json'), lock);
  } catch {
    /* Installation can fail before producing a lockfile. */
  }
  report.updatedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify(report, null, 2));
  if (process.env.MEGAMONO_KEEP_EXPO_FIXTURE === 'true')
    console.log('Default Expo fixture retained: ' + root);
  else await rm(root, { recursive: true, force: true });
}
