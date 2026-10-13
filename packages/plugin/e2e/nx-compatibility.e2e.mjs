import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(
  fileURLToPath(new URL('../../..', import.meta.url)),
);
const nxVersion = process.env.MEGAMONO_NX_VERSION ?? '23.1.1';
const typescriptVersion = process.env.MEGAMONO_TYPESCRIPT_VERSION ?? '6.0.3';
const future = process.env.MEGAMONO_FUTURE_NX === 'true';
const nxMatch = nxVersion.match(/(\d+)\.(\d+)/);
const nxMajor = Number(nxMatch?.[1] ?? 999);
const nxMinor = Number(nxMatch?.[2] ?? 0);
const supportsInferencePlugins = nxMajor >= 18;
const supportsTargetParallelism =
  nxMajor > 19 || (nxMajor === 19 && nxMinor >= 5);
const temporaryRoot = mkdtempSync(join(tmpdir(), 'megamono-nx-compatibility-'));
const fixtureRoot = join(temporaryRoot, 'fixture');
mkdirSync(fixtureRoot, { recursive: true });
let fixtureToolPath;
const packageRoots = {
  '@megamono/plugin': resolve(workspaceRoot, 'packages/plugin'),
  ...(supportsInferencePlugins
    ? {
        '@megamono/nx-apple': resolve(workspaceRoot, 'packages/nx-apple'),
        '@megamono/nx-cargo': resolve(workspaceRoot, 'packages/nx-cargo'),
        '@megamono/nx-cloudflare': resolve(
          workspaceRoot,
          'packages/nx-cloudflare',
        ),
        '@megamono/nx-extension': resolve(
          workspaceRoot,
          'packages/nx-extension',
        ),
        '@megamono/nx-render': resolve(workspaceRoot, 'packages/nx-render'),
      }
    : {}),
};

function run(command, args, cwd = fixtureRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: 'true',
      NX_DAEMON: 'false',
      NX_INTERACTIVE: 'false',
      npm_config_cache:
        process.env.MEGAMONO_NPM_CACHE ?? join(temporaryRoot, 'npm-cache'),
      ...(fixtureToolPath
        ? { PATH: `${fixtureToolPath}:${process.env.PATH ?? ''}` }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function removeTemporaryRoot() {
  const fixturePrefix = join(tmpdir(), 'megamono-nx-compatibility-');
  if (!temporaryRoot.startsWith(fixturePrefix)) {
    throw new Error(
      `Refusing to remove unexpected fixture path ${temporaryRoot}.`,
    );
  }
  execFileSync('rm', ['-rf', '--', temporaryRoot]);
}

try {
  const packedPackages = Object.fromEntries(
    Object.entries(packageRoots).map(([name, packageRoot]) => {
      const packed = run(
        'npm',
        ['pack', packageRoot, '--pack-destination', fixtureRoot, '--json'],
        workspaceRoot,
      );
      const packageFilename = JSON.parse(packed)[0]?.filename;
      assert(packageFilename, `npm pack did not report the ${name} archive.`);
      return [name, `file:./${basename(packageFilename)}`];
    }),
  );

  const npmVersion = run('npm', ['--version']).trim();
  writeJson(join(fixtureRoot, 'package.json'), {
    name: `megamono-nx-${nxVersion.replaceAll(/[^a-zA-Z0-9]+/g, '-')}`,
    version: '0.0.0',
    private: true,
    packageManager: `npm@${npmVersion}`,
    engines: { node: process.versions.node },
    devDependencies: {
      ...packedPackages,
      '@nx/devkit': nxVersion,
      nx: nxVersion,
      typescript: typescriptVersion,
    },
  });
  writeJson(
    join(fixtureRoot, 'nx.json'),
    supportsInferencePlugins
      ? {
          plugins: [
            '@megamono/nx-apple',
            '@megamono/nx-cargo',
            '@megamono/nx-cloudflare',
            '@megamono/nx-extension',
            '@megamono/nx-render',
          ],
        }
      : {},
  );
  mkdirSync(join(fixtureRoot, 'apps/demo/src'), { recursive: true });
  writeJson(join(fixtureRoot, 'apps/demo/project.json'), {
    name: 'demo',
    root: 'apps/demo',
    sourceRoot: 'apps/demo/src',
    projectType: 'application',
    targets: {},
  });
  writeFileSync(join(fixtureRoot, 'apps/demo/src/index.ts'), 'export {};\n');
  writeJson(join(fixtureRoot, 'tsconfig.base.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      strict: true,
      skipLibCheck: true,
    },
  });

  run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    ...(future ? ['--force'] : []),
  ]);
  run('npm', [
    'exec',
    'nx',
    '--',
    'generate',
    '@megamono/plugin:workspace-init',
    '--only=ci,lint,health,agents,skills',
    '--defaultPlatform=node',
    '--packageManager=npm',
    '--interactive=false',
    '--yes',
    '--bootstrap',
  ]);

  const databaseCommand = [
    'exec',
    'nx',
    '--',
    'generate',
    '@megamono/plugin:database',
    '--name=compatibility',
    '--adapter=drizzle',
    '--scope=compat',
    '--interactive=false',
    '--yes',
    '--bootstrap',
  ];
  run('npm', databaseCommand);
  const databaseConfig = readFileSync(
    join(fixtureRoot, 'libs/drizzle/compatibility/package.json'),
    'utf8',
  );
  const playstackConfig = JSON.parse(
    readFileSync(join(fixtureRoot, 'playstack.json'), 'utf8'),
  );
  assert(
    playstackConfig.databases?.compatibility?.adapter === 'drizzle' &&
      playstackConfig.databases.compatibility.dialect === 'postgresql',
    `Nx ${nxVersion} did not retain the named Drizzle target contract.`,
  );
  run('npm', databaseCommand);
  assert(
    readFileSync(
      join(fixtureRoot, 'libs/drizzle/compatibility/package.json'),
      'utf8',
    ) === databaseConfig,
    `Nx ${nxVersion} changed the database project during an idempotent rerun.`,
  );

  if (supportsInferencePlugins) {
    const appCommand = [
      'exec',
      'nx',
      '--',
      'generate',
      '@megamono/plugin:app',
      '--type=apple',
      '--name=compat-apple',
      '--directory=apps/compat-apple',
      '--scope=compat',
      '--workspaceName=Compatibility',
      '--interactive=false',
      '--yes',
      '--bootstrap',
    ];
    run('npm', appCommand);
    const appleApp = readFileSync(
      join(fixtureRoot, 'apps/compat-apple/project.json'),
      'utf8',
    );
    run('npm', appCommand);
    assert(
      readFileSync(
        join(fixtureRoot, 'apps/compat-apple/project.json'),
        'utf8',
      ) === appleApp,
      `Nx ${nxVersion} changed the application during an idempotent rerun.`,
    );
  }

  const project = JSON.parse(
    run('npm', ['exec', 'nx', '--', 'show', 'project', 'megamono', '--json']),
  );
  if (!supportsTargetParallelism) {
    assert(
      !Object.hasOwn(project.targets.import, 'parallelism'),
      `Nx ${nxVersion} received unsupported target parallelism metadata.`,
    );
  } else {
    assert(
      project.targets.import.parallelism === false,
      `Nx ${nxVersion} did not retain serialized import execution.`,
    );
  }
  const projects = run('npm', ['exec', 'nx', '--', 'show', 'projects']);
  assert(
    projects.includes('demo'),
    'The fixture application is missing from the Nx project graph.',
  );
  assert(
    projects.includes('compat-drizzle-compatibility'),
    `Nx ${nxVersion} did not register the generated database project.`,
  );
  if (supportsInferencePlugins) {
    assert(
      projects.includes('compat-compat-apple'),
      `Nx ${nxVersion} did not register the generated Apple application.`,
    );
  }
  run('npm', ['exec', 'nx', '--', 'run', 'megamono:check']);

  if (supportsInferencePlugins) {
    mkdirSync(
      join(fixtureRoot, 'apps/apple/Fixture.xcodeproj/xcshareddata/xcschemes'),
      { recursive: true },
    );
    writeFileSync(
      join(fixtureRoot, 'apps/apple/Fixture.xcodeproj/project.pbxproj'),
      'isa = PBXProject;\n',
    );
    writeFileSync(
      join(
        fixtureRoot,
        'apps/apple/Fixture.xcodeproj/xcshareddata/xcschemes/Fixture.xcscheme',
      ),
      '<Scheme />\n',
    );
    mkdirSync(join(fixtureRoot, 'crates/fixture-cargo/src'), {
      recursive: true,
    });
    writeFileSync(
      join(fixtureRoot, 'crates/fixture-cargo/Cargo.toml'),
      '[package]\nname = "fixture-cargo"\nversion = "0.1.0"\nedition = "2021"\n',
    );
    writeFileSync(
      join(fixtureRoot, 'crates/fixture-cargo/src/lib.rs'),
      'pub fn fixture() {}\n',
    );
    fixtureToolPath = join(temporaryRoot, 'fixture-tools');
    mkdirSync(fixtureToolPath, { recursive: true });
    // This fixture qualifies Nx graph APIs, not native Apple execution. Provide
    // the advertised tool on Linux too, but fail if a target tries to invoke it.
    // Real Apple build qualification runs in the macOS local-registry fixture.
    const fakeXcodePath = join(fixtureToolPath, 'xcodebuild');
    writeFileSync(
      fakeXcodePath,
      '#!/usr/bin/env node\nthrow new Error("Native Xcode execution is outside the Nx graph compatibility fixture.");\n',
    );
    chmodSync(fakeXcodePath, 0o755);
    const cargoManifest = join(fixtureRoot, 'crates/fixture-cargo/Cargo.toml');
    const cargoRoot = join(fixtureRoot, 'crates/fixture-cargo');
    const fakeCargoPath = join(fixtureToolPath, 'cargo');
    writeFileSync(
      fakeCargoPath,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  packages: [{
    id: 'fixture-cargo 0.1.0 (path+file://${cargoRoot})',
    name: 'fixture-cargo',
    manifest_path: ${JSON.stringify(cargoManifest)},
    dependencies: [],
    targets: [{ kind: ['lib'] }],
  }],
  workspace_members: ['fixture-cargo 0.1.0 (path+file://${cargoRoot})'],
  workspace_root: ${JSON.stringify(cargoRoot)},
  target_directory: ${JSON.stringify(join(cargoRoot, 'target'))},
}));
`,
    );
    chmodSync(fakeCargoPath, 0o755);
    mkdirSync(join(fixtureRoot, 'apps/worker/src'), { recursive: true });
    writeJson(join(fixtureRoot, 'apps/worker/wrangler.json'), {
      name: 'fixture-worker',
      main: 'src/index.ts',
      compatibility_date: '2026-08-23',
    });
    writeFileSync(
      join(fixtureRoot, 'apps/worker/src/index.ts'),
      'export default {};\n',
    );
    mkdirSync(join(fixtureRoot, 'apps/extension'), { recursive: true });
    writeJson(join(fixtureRoot, 'apps/extension/package.json'), {
      name: 'fixture-extension',
      private: true,
    });
    writeFileSync(
      join(fixtureRoot, 'apps/extension/wxt.config.ts'),
      'export default {};\n',
    );
    mkdirSync(join(fixtureRoot, 'apps/render-site'), { recursive: true });
    writeJson(join(fixtureRoot, 'apps/render-site/package.json'), {
      name: 'render-site',
      private: true,
    });
    writeFileSync(
      join(fixtureRoot, 'render.yaml'),
      [
        'services:',
        '  - type: web',
        '    name: render-site',
        '    runtime: node',
        '    rootDir: apps/render-site',
        '    buildCommand: npm exec nx -- run render-site:build',
        '    startCommand: npm exec nx -- run render-site:serve',
        '    healthCheckPath: /health',
        '',
      ].join('\n'),
    );
    run('npm', ['exec', 'nx', '--', 'reset']);
    const inferredProjects = run('npm', [
      'exec',
      'nx',
      '--',
      'show',
      'projects',
    ]);
    assert(
      inferredProjects.includes('worker'),
      `The packed Cloudflare plugin did not infer the Worker project. Projects:\n${inferredProjects}`,
    );
    assert(
      inferredProjects.includes('Fixture'),
      `The packed Apple plugin did not infer the Xcode project. Projects:\n${inferredProjects}`,
    );
    assert(
      inferredProjects.includes('fixture-cargo'),
      `The packed Cargo plugin did not infer the Rust project. Projects:\n${inferredProjects}`,
    );
    assert(
      inferredProjects.includes('fixture-extension'),
      `The packed extension plugin did not infer the WXT project. Projects:\n${inferredProjects}`,
    );
    assert(
      inferredProjects.includes('render-site'),
      `The packed Render plugin did not infer the Blueprint service. Projects:\n${inferredProjects}`,
    );
    const apple = JSON.parse(
      run('npm', ['exec', 'nx', '--', 'show', 'project', 'Fixture', '--json']),
    );
    assert(
      apple.targets.build.cache === true &&
        apple.metadata.technologies.includes('xcode'),
      `Nx ${nxVersion} did not retain Apple target metadata.`,
    );
    const cargo = JSON.parse(
      run('npm', [
        'exec',
        'nx',
        '--',
        'show',
        'project',
        'fixture-cargo',
        '--json',
      ]),
    );
    assert(
      cargo.targets.build.cache === false &&
        cargo.targets.build.executor === '@megamono/nx-cargo:run' &&
        cargo.targets.build.options.args[0] === 'build',
      `Nx ${nxVersion} did not retain Cargo target metadata.`,
    );
    const worker = JSON.parse(
      run('npm', ['exec', 'nx', '--', 'show', 'project', 'worker', '--json']),
    );
    const render = JSON.parse(
      run('npm', [
        'exec',
        'nx',
        '--',
        'show',
        'project',
        'render-site',
        '--json',
      ]),
    );
    assert(
      render.targets['render-build'].options.command.includes(
        'render-site:build',
      ) && render.metadata.technologies.includes('render'),
      `Nx ${nxVersion} did not retain Render target metadata.`,
    );
    if (nxMajor < 21) {
      assert(
        !Object.hasOwn(worker.targets.dev, 'continuous'),
        `Nx ${nxVersion} received unsupported continuous target metadata.`,
      );
    } else {
      assert(
        worker.targets.dev.continuous === true,
        `Nx ${nxVersion} did not retain continuous Worker targets.`,
      );
    }
  }
  const managedPaths = [
    'megamono.json',
    '.megamono/project.json',
    '.megamono/artifacts.json',
    '.github/workflows/megamono-ci.yml',
    '.github/workflows/megamono-health.yml',
    'eslint.config.mjs',
  ];
  const initCommand = [
    'exec',
    'nx',
    '--',
    'generate',
    '@megamono/plugin:workspace-init',
    '--only=ci,lint,health,agents,skills',
    '--defaultPlatform=node',
    '--packageManager=npm',
    '--interactive=false',
    '--yes',
    '--bootstrap',
  ];
  // Reconcile the newly added compatibility projects before measuring the
  // stable rerun contract.
  run('npm', initCommand);
  const beforeRerun = Object.fromEntries(
    managedPaths.map((path) => [
      path,
      readFileSync(join(fixtureRoot, path), 'utf8'),
    ]),
  );
  run('npm', initCommand);
  for (const path of managedPaths) {
    assert(
      readFileSync(join(fixtureRoot, path), 'utf8') === beforeRerun[path],
      `Nx ${nxVersion} changed ${path} during an idempotent rerun.`,
    );
  }

  writeFileSync(
    join(fixtureRoot, 'consumer.ts'),
    [
      "import type { WorkspaceInitSurvey } from '@megamono/plugin';",
      ...(supportsInferencePlugins
        ? [
            "import type { ApplePluginOptions } from '@megamono/nx-apple';",
            "import type { CargoPluginOptions } from '@megamono/nx-cargo';",
            "import type { CloudflarePluginOptions } from '@megamono/nx-cloudflare';",
            "import type { ExtensionPluginOptions } from '@megamono/nx-extension';",
            "import type { RenderPluginOptions } from '@megamono/nx-render';",
          ]
        : []),
      'const survey: WorkspaceInitSurvey | undefined = undefined;',
      ...(supportsInferencePlugins
        ? [
            'const apple: ApplePluginOptions = {};',
            'const cargo: CargoPluginOptions = {};',
            'const cloudflare: CloudflarePluginOptions = {};',
            'const extension: ExtensionPluginOptions = {};',
            'const render: RenderPluginOptions = {};',
            'void apple; void cargo; void cloudflare; void extension; void render;',
          ]
        : []),
      'void survey;',
      '',
    ].join('\n'),
  );
  run('npm', [
    'exec',
    'tsc',
    '--',
    '--noEmit',
    '--skipLibCheck',
    '--target',
    'ES2022',
    '--module',
    'Node16',
    '--moduleResolution',
    'Node16',
    'consumer.ts',
  ]);

  const workflow = readFileSync(
    join(fixtureRoot, '.github/workflows/megamono-ci.yml'),
    'utf8',
  );
  assert(
    workflow.includes(`node-version: ${process.versions.node}`),
    'Generated CI did not retain the fixture Node version.',
  );
  console.log(
    `Verified packed ${supportsInferencePlugins ? 'Megamono plugins' : '@megamono/plugin'} with Nx ${nxVersion}, TypeScript ${typescriptVersion}, and Node ${process.versions.node}.`,
  );
} catch (error) {
  const stdout = error?.stdout?.toString().trim();
  const stderr = error?.stderr?.toString().trim();
  if (stdout) console.error(stdout);
  if (stderr) console.error(stderr);
  throw error;
} finally {
  if (process.env.MEGAMONO_KEEP_FIXTURE === 'true') {
    console.error(`Retained compatibility fixture at ${fixtureRoot}`);
    process.exitCode = 1;
  } else {
    removeTemporaryRoot();
  }
}
