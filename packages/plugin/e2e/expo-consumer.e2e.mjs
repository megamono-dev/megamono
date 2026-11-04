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
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

// An explicit regression lane, not a declaration that every Expo SDK is supported.
// SDK 54 is the adopted app's constrained React 19.1 / RN 0.81 combination.
const versions = {
  expo: '54.0.38',
  'react-native': '0.81.5',
  mobileReact: '19.1.0',
  webReact: '19.2.5',
  'expo-doctor': '1.21.6',
  'babel-preset-expo': '54.0.12',
  '@babel/core': '7.29.0',
  nx: '23.3.1',
  typescript: '6.0.3',
};
const workspace = resolve(import.meta.dirname, '../../..');
const artifacts = join(workspace, 'tmp/expo-consumer');
const root = await mkdtemp(join(tmpdir(), 'megamono-expo-consumer-'));
const mobile = join(root, 'apps/mobile');
const generated = join(root, 'apps/generated');
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  scope:
    'Packed plugin adoption and new mobile generation, Expo Doctor, and JavaScript bundle qualification; no native or cloud build.',
  versions,
  checks: [],
  status: 'running',
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
const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 20 * 1024 * 1024,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const put = async (file, value) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
};
async function check(id, action) {
  console.log(`Expo consumer: ${id}`);
  report.currentCheck = id;
  await put(join(artifacts, `${id}.log`), 'running\n');
  await put(join(artifacts, 'report.json'), report);
  try {
    const output = await action();
    await put(join(artifacts, `${id}.log`), String(output ?? 'passed'));
    report.checks.push({ id, status: 'passed' });
  } catch (error) {
    await put(
      join(artifacts, `${id}.log`),
      `${error.stack}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`,
    );
    report.checks.push({ id, status: 'failed' });
    throw error;
  } finally {
    delete report.currentCheck;
    await put(join(artifacts, 'report.json'), report);
  }
}
async function files(path) {
  return (
    await Promise.all(
      (await readdir(path, { withFileTypes: true })).map(async (entry) => {
        const name = join(path, entry.name);
        return entry.isDirectory() ? files(name) : [name];
      }),
    )
  ).flat();
}

try {
  await mkdir(artifacts, { recursive: true });
  await put(join(artifacts, 'report.json'), report);
  report.node = process.version;
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
  };
  const packageJson = {
    name: 'megamono-expo-consumer',
    version: '0.0.0',
    private: true,
    packageManager: `npm@${report.npm}`,
    workspaces: ['apps/*'],
    dependencies: { react: versions.webReact, 'react-dom': versions.webReact },
    devDependencies: {
      '@megamono/plugin': `file:./${packed.filename}`,
      '@nx/devkit': versions.nx,
      nx: versions.nx,
      typescript: versions.typescript,
      '@babel/core': versions['@babel/core'],
      'babel-preset-expo': versions['babel-preset-expo'],
      'expo-doctor': versions['expo-doctor'],
    },
  };
  const mobilePackage = {
    name: '@fixture/mobile',
    version: '0.0.0',
    private: true,
    main: 'index.js',
    dependencies: {
      expo: versions.expo,
      'react-native': versions['react-native'],
      react: versions.mobileReact,
      'react-dom': versions.mobileReact,
    },
    expo: { autolinking: { exclude: ['react', 'react-dom'] } },
    nx: {
      tags: ['platform:mobile', 'scope:shared', 'type:app'],
      targets: {
        build: {
          executor: 'nx:run-commands',
          cache: false,
          options: {
            cwd: 'apps/mobile',
            command: 'node ../../tools/export-mobile.cjs',
          },
        },
      },
    },
  };
  await put(join(root, 'package.json'), packageJson);
  await put(join(root, 'nx.json'), { analytics: false });
  await put(join(root, '.gitignore'), 'node_modules/\n.nx/\ndist/\n.expo/\n');
  await put(join(mobile, 'package.json'), mobilePackage);
  await put(join(mobile, 'app.json'), {
    expo: {
      name: 'Megamono Expo consumer',
      slug: 'megamono-expo-consumer',
      version: '1.0.0',
      platforms: ['ios', 'android'],
    },
  });
  await put(
    join(mobile, 'babel.config.js'),
    "module.exports = { presets: ['babel-preset-expo'] };\n",
  );
  await put(
    join(mobile, 'index.js'),
    "import { jsx } from 'react/jsx-runtime';\nimport { Text } from 'react-native';\nimport { registerRootComponent } from 'expo';\nfunction App() { return jsx(Text, { children: 'Megamono Expo regression' }); }\nregisterRootComponent(App);\n",
  );
  // Preserve Expo's SDK-owned defaults. Resolve the mobile React singleton even
  // for imports originating in a hoisted React Native module; do not globally
  // override the web application's independent React installation.
  const metro = `const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
const originalResolveRequest = config.resolver.resolveRequest;
const mobileEntry = require.resolve('./index.js');
config.resolver.resolveRequest = (context, name, platform) =>
  (originalResolveRequest ?? context.resolveRequest)(
    /^(react|react-dom)(\\/|$)/.test(name) ? { ...context, originModulePath: mobileEntry } : context,
    name, platform,
  );
module.exports = config;
`;
  await put(join(mobile, 'metro.config.js'), metro);
  await put(
    join(root, 'tools/export-mobile.cjs'),
    "const { writeFileSync } = require('node:fs');\nconst { execFileSync } = require('node:child_process');\nwriteFileSync('export-started', 'yes');\nexecFileSync(process.execPath, [require.resolve('expo/bin/cli', { paths: [process.cwd()] }), 'export', '--platform', 'all', '--source-maps', '--no-bytecode', '--max-workers', '1'], { stdio: 'inherit' });\n",
  );
  await put(join(root, 'apps/web/package.json'), {
    name: '@fixture/web',
    version: '0.0.0',
    private: true,
    dependencies: { react: versions.webReact, 'react-dom': versions.webReact },
    nx: { tags: ['platform:web', 'scope:shared', 'type:app'] },
  });
  await check('install', () =>
    run('npm', [
      'install',
      '--include=dev',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
    ]),
  );
  const require = createRequire(join(root, 'package.json'));
  const mobileRequire = createRequire(join(mobile, 'package.json'));
  report.resolved = Object.fromEntries(
    ['expo', 'react-native', 'react', 'react-dom'].map((name) => [
      name,
      mobileRequire(`${name}/package.json`).version,
    ]),
  );
  report.resolved.webReact = require('react/package.json').version;
  report.resolved.doctor = require('expo-doctor/package.json').version;
  const nxManifest = require('nx/package.json');
  const nxBin = join(
    dirname(require.resolve('nx/package.json')),
    nxManifest.bin.nx,
  );
  const nx = (...args) => run(process.execPath, [nxBin, ...args]);
  await check('adopt-and-preserve', async () => {
    const output = nx(
      'generate',
      '@megamono/plugin:workspace-init',
      '--only=ci',
      '--yes',
      '--interactive=false',
      '--bootstrap',
    );
    assert.equal(
      await readFile(join(mobile, 'metro.config.js'), 'utf8'),
      metro,
    );
    assert.equal(
      JSON.parse(await readFile(join(mobile, 'package.json'), 'utf8'))
        .dependencies.react,
      versions.mobileReact,
    );
    assert.equal(
      JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
        .dependencies.react,
      versions.webReact,
    );
    const project = JSON.parse(
      nx('show', 'project', '@fixture/mobile', '--json'),
    );
    assert.equal(
      project.targets['expo-doctor'].executor,
      '@megamono/plugin:expo-doctor',
    );
    assert(
      project.targets.build.dependsOn.some(
        (dependency) =>
          dependency === 'expo-doctor' || dependency.target === 'expo-doctor',
      ),
    );
    return output;
  });
  await check('metro-and-react-isolation', () =>
    run(process.execPath, [
      '-e',
      `
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const mobile = createRequire(path.resolve('apps/mobile/package.json'));
assert.equal(mobile('react/package.json').version, '${versions.mobileReact}');
assert.equal(require('react/package.json').version, '${versions.webReact}');
const config = mobile('./metro.config.js');
const defaults = mobile('expo/metro-config').getDefaultConfig(path.resolve('apps/mobile'));
assert.deepEqual(config.watchFolders, defaults.watchFolders);
assert.deepEqual(config.resolver.nodeModulesPaths, defaults.resolver.nodeModulesPaths);
assert.equal(config.projectRoot, defaults.projectRoot);
assert.equal(config.transformer.babelTransformerPath, defaults.transformer.babelTransformerPath);
console.log('SDK-owned Metro defaults and isolated React versions verified.');
`,
    ]),
  );
  await check('doctor-and-platform-exports', () =>
    nx(
      'run',
      '@fixture/mobile:build',
      '--skip-nx-cache',
      '--output-style=static',
    ),
  );
  await check('bundle-react-isolation', async () => {
    const maps = (await files(join(mobile, 'dist'))).filter((path) =>
      path.endsWith('.map'),
    );
    for (const platform of ['ios', 'android']) {
      const selected = maps.filter((path) => path.includes(`/${platform}/`));
      assert(selected.length, `No ${platform} source map produced.`);
      const reactSources = [];
      const reactModuleSources = [];
      for (const file of selected) {
        const map = JSON.parse(await readFile(file, 'utf8'));
        map.sources.forEach((source, index) => {
          if (/node_modules\/react(?:-dom)?\//.test(source)) {
            reactModuleSources.push(source);
          }
          if (/node_modules\/react\/cjs\/react\.production\.js$/.test(source))
            reactSources.push({ source, content: map.sourcesContent[index] });
        });
      }
      assert.equal(
        reactSources.length,
        1,
        `${platform} must contain exactly one React production implementation.`,
      );
      assert(
        reactModuleSources.some((source) =>
          source.endsWith('/react/jsx-runtime.js'),
        ),
      );
      for (const source of reactModuleSources) {
        assert.match(
          source,
          /apps\/mobile\/node_modules\/react(?:-dom)?\//,
          `${platform} must resolve every React entry point inside the mobile application.`,
        );
      }
      assert.match(
        reactSources[0].source,
        /apps\/mobile\/node_modules\/react\//,
      );
      assert(
        reactSources[0].content.includes(`"${versions.mobileReact}"`),
        `${platform} must bundle the mobile React version.`,
      );
      assert(
        !reactSources[0].content.includes(`"${versions.webReact}"`),
        `${platform} must not bundle the web React version.`,
      );
    }
    return JSON.stringify({
      maps: maps.map((file) => file.slice(mobile.length + 1)),
    });
  });
  await check('doctor-blocks-incompatible-build', async () => {
    await rm(join(mobile, 'export-started'));
    const manifest = await readFile(join(mobile, 'package.json'), 'utf8');
    const lock = await readFile(join(root, 'package-lock.json'));
    let failure;
    try {
      // Doctor validates the installed dependency graph, not only declarations.
      // Exercise an actual incompatible SDK combination.
      run('npm', [
        'install',
        '--workspace=@fixture/mobile',
        `react@${versions.webReact}`,
        `react-dom@${versions.webReact}`,
        '--save-exact',
        '--no-audit',
        '--no-fund',
        '--registry=https://registry.npmjs.org',
      ]);
      assert.equal(
        run(
          process.execPath,
          ['-p', "require('react/package.json').version"],
          mobile,
        ).trim(),
        versions.webReact,
      );
      try {
        nx(
          'run',
          '@fixture/mobile:build',
          '--skip-nx-cache',
          '--output-style=static',
        );
      } catch (error) {
        failure = error;
      }
    } finally {
      await put(join(mobile, 'package.json'), manifest);
      await writeFile(join(root, 'package-lock.json'), lock);
      run('npm', [
        'ci',
        '--include=dev',
        '--no-audit',
        '--no-fund',
        '--registry=https://registry.npmjs.org',
      ]);
    }
    assert(failure, 'Incompatible installed React should fail Doctor.');
    const output = stripVTControlCharacters(
      `${failure.stdout}\n${failure.stderr}`,
    );
    assert.match(output, /react\s+19\.1\.0\s+19\.2\.5/);
    assert.match(output, /Expo Doctor failed/);
    await assert.rejects(readFile(join(mobile, 'export-started')), {
      code: 'ENOENT',
    });
    return output;
  });
  await check('generated-toolchain-install', async () => {
    const tooling = run('npm', [
      'install',
      '--save-dev',
      '--save-exact',
      `@nx/expo@${versions.nx}`,
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
    ]);
    const sdk = run('npm', [
      'install',
      '--save-exact',
      `expo@${versions.expo}`,
      `react-native@${versions['react-native']}`,
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
    ]);
    // The fixture starts as a small JS workspace; a generated TypeScript Expo
    // app uses the repository-owned base configuration rather than a test-only
    // Metro configuration or source replacement.
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
    // Exercise normal adoption mutation preflight on a clean feature branch.
    // Cached origin refs are local fixture metadata; no remote is contacted.
    run('git', ['init', '--initial-branch=main']);
    run('git', ['config', 'user.name', 'Megamono Fixture']);
    run('git', ['config', 'user.email', 'fixture@example.invalid']);
    run('git', ['config', 'commit.gpgSign', 'false']);
    await mkdir(join(root, '.git/fixture-hooks'), { recursive: true });
    run('git', ['config', 'core.hooksPath', join(root, '.git/fixture-hooks')]);
    run('git', ['add', '--all']);
    run('git', ['commit', '--message', 'test: prepare adopted Expo workspace']);
    run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    run('git', [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    ]);
    run('git', ['switch', '--create', 'fixture/generated-mobile']);
    return `${tooling}\n${sdk}`;
  });
  let generatedExportTarget;
  let generatedExportIsCommand;
  let generatedExportArguments;
  let generatedProject;
  let generatedMetro;
  await check('generate-mobile-and-preserve-web', async () => {
    const rootBefore = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    );
    const webBefore = await readFile(
      join(root, 'apps/web/package.json'),
      'utf8',
    );
    const existingMobile = await readFile(join(mobile, 'package.json'), 'utf8');
    const command = [
      'generate',
      '@megamono/plugin:app',
      '--type=mobile',
      '--name=generated',
      '--scope=fixture',
      '--yes',
      '--interactive=false',
      '--skipInstall',
    ];
    const discovery = nx('list', '@megamono/plugin');
    const help = nx('generate', '@megamono/plugin:app', '--help');
    const preview = nx(...command, '--dry-run');
    await assert.rejects(readFile(join(generated, 'package.json')), {
      code: 'ENOENT',
    });
    const output = nx(...command);
    const rootAfter = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    );
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
          `Generation must retain ${section}.${name}.`,
        );
    assert.equal(
      await readFile(join(root, 'apps/web/package.json'), 'utf8'),
      webBefore,
    );
    assert.equal(
      await readFile(join(mobile, 'package.json'), 'utf8'),
      existingMobile,
    );
    assert.equal(
      await readFile(join(mobile, 'metro.config.js'), 'utf8'),
      metro,
    );
    const manifest = JSON.parse(
      await readFile(join(generated, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.dependencies.react, versions.mobileReact);
    assert.equal(manifest.dependencies['react-dom'], versions.mobileReact);
    assert.equal(
      manifest.dependencies['react-native'],
      versions['react-native'],
    );
    assert.equal(manifest.dependencies.expo, versions.expo);
    generatedMetro = await readFile(join(generated, 'metro.config.js'), 'utf8');
    return `${discovery}\n${help}\n${preview}\n${output}`;
  });
  await check('generated-install-and-targets', () => {
    const output = run('npm', [
      'install',
      '--include=dev',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
    ]);
    const project = JSON.parse(
      nx('show', 'project', 'fixture-generated', '--json'),
    );
    generatedProject = project;
    assert.equal(
      project.targets['expo-doctor'].executor,
      '@megamono/plugin:expo-doctor',
    );
    const target = Object.entries(project.targets).find(
      ([, value]) =>
        (value.command ?? value.options?.command) === 'expo export' ||
        value.executor === '@nx/expo:export',
    );
    assert(
      target,
      'Maintained Expo export target must be inferred for the generated app.',
    );
    generatedExportTarget = target[0];
    generatedExportIsCommand =
      (target[1].command ?? target[1].options?.command) === 'expo export';
    const existingArgs = target[1].options?.args;
    assert(
      existingArgs === undefined ||
        typeof existingArgs === 'string' ||
        (Array.isArray(existingArgs) &&
          existingArgs.every((value) => typeof value === 'string')),
      'The generated Expo export arguments must retain their supported string/array shape.',
    );
    generatedExportArguments = [
      Array.isArray(existingArgs) ? existingArgs.join(' ') : existingArgs,
      '--platform all --source-maps --no-bytecode --max-workers 1',
    ]
      .filter(Boolean)
      .join(' ');
    assert(
      target[1].dependsOn.some(
        (dependency) =>
          dependency === 'expo-doctor' || dependency.target === 'expo-doctor',
      ),
    );
    const local = createRequire(join(generated, 'package.json'));
    assert.equal(local('react/package.json').version, versions.mobileReact);
    assert.equal(require('react/package.json').version, versions.webReact);
    report.generated = {
      project: 'fixture-generated',
      exportTarget: generatedExportTarget,
      react: local('react/package.json').version,
      expo: local('expo/package.json').version,
    };
    return output;
  });
  await check('generated-doctor-and-exports', async () => {
    const manifest = await readFile(join(generated, 'package.json'), 'utf8');
    const lock = await readFile(join(root, 'package-lock.json'));
    const output = nx(
      'run',
      `fixture-generated:${generatedExportTarget}`,
      '--skip-nx-cache',
      ...(generatedExportIsCommand
        ? [`--args=${generatedExportArguments}`]
        : ['--platform=all', '--sourceMaps', '--maxWorkers=1']),
      '--output-style=static',
    );
    assert.equal(
      await readFile(join(generated, 'package.json'), 'utf8'),
      manifest,
      'Export must not rewrite the generated dependency manifest.',
    );
    assert.deepEqual(
      await readFile(join(root, 'package-lock.json')),
      lock,
      'Export must not rewrite the consumer lockfile.',
    );
    return output;
  });
  await check('generated-bundle-react-isolation', async () => {
    assert.equal(
      await readFile(join(generated, 'metro.config.js'), 'utf8'),
      generatedMetro,
      'Qualification must not replace the generated Metro configuration.',
    );
    const maps = (await files(join(generated, 'dist'))).filter((file) =>
      file.endsWith('.map'),
    );
    for (const platform of ['ios', 'android']) {
      const selected = maps.filter((file) => file.includes(`/${platform}/`));
      assert(selected.length, `No generated ${platform} source map produced.`);
      const react = [];
      const modules = [];
      for (const file of selected) {
        const map = JSON.parse(await readFile(file, 'utf8'));
        map.sources.forEach((source, index) => {
          if (/node_modules\/react(?:-dom)?\//.test(source))
            modules.push(source);
          if (/node_modules\/react\/cjs\/react\.production\.js$/.test(source))
            react.push({ source, content: map.sourcesContent[index] });
        });
      }
      assert.equal(
        react.length,
        1,
        `Generated ${platform} must contain one React implementation.`,
      );
      assert(
        modules.some((source) => source.endsWith('/react/jsx-runtime.js')),
      );
      for (const source of modules)
        assert.match(
          source,
          /apps\/generated\/node_modules\/react(?:-dom)?\//,
          `Generated ${platform} React entry points must remain app-local.`,
        );
      assert(react[0].content.includes(`"${versions.mobileReact}"`));
      assert(!react[0].content.includes(`"${versions.webReact}"`));
    }
    return JSON.stringify({
      maps: maps.map((file) => file.slice(generated.length + 1)),
    });
  });
  await check('generated-typecheck', () => {
    if (generatedProject.targets.typecheck)
      return nx(
        'run',
        'fixture-generated:typecheck',
        '--skip-nx-cache',
        '--output-style=static',
      );
    // Legacy Expo presets do not expose a typecheck target. Check the exact
    // generated application configuration with the installed compiler instead.
    return run(process.execPath, [
      require.resolve('typescript/bin/tsc'),
      '--project',
      'apps/generated/tsconfig.app.json',
      '--noEmit',
    ]);
  });
  await check('generated-default-unit-tests', () => {
    assert(
      generatedProject.targets.test,
      'The maintained preset must provide its default unit-test target.',
    );
    return nx(
      'run',
      'fixture-generated:test',
      '--runInBand',
      '--watch=false',
      '--no-watchman',
      '--skip-nx-cache',
      '--output-style=static',
    );
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error.message;
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    const lock = await readFile(join(root, 'package-lock.json'));
    report.lockfileSha256 = createHash('sha256').update(lock).digest('hex');
    await writeFile(join(artifacts, 'package-lock.json'), lock);
  } catch {
    /* Installation may fail before producing a lockfile. */
  }
  await put(join(artifacts, 'report.json'), report);
  if (process.env.MEGAMONO_KEEP_EXPO_FIXTURE === 'true')
    console.log(`Expo fixture retained: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
