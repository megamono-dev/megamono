import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const workspaceRoot = resolve(import.meta.dirname, '../../..');
const compatibility = JSON.parse(
  await readFile(
    resolve(workspaceRoot, 'packages/plugin/compatibility.json'),
    'utf8',
  ),
);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? workspaceRoot,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          [
            `${command} ${args.join(' ')} exited ${
              code === null ? `after signal ${signal ?? 'unknown'}` : code
            }`,
            stdout.trim(),
            stderr.trim(),
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
    });
  });
}

function availablePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a local-registry port.'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePromise(address.port);
      });
    });
  });
}

async function waitForRegistry(registry, child, log) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Verdaccio exited before startup.\n${log()}`);
    try {
      const response = await fetch(registry);
      if (response.ok) return;
    } catch {
      // The registry has not bound its socket yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for Verdaccio at ${registry}.\n${log()}`);
}

async function writeFixture(root) {
  const files = {
    'package.json': `${JSON.stringify(
      {
        name: 'nx-apple-local-registry-fixture',
        private: true,
        devDependencies: {
          '@megamono/nx-apple': '0.0.1',
          nx: compatibility.scaffoldPackages['create-nx-workspace'],
        },
      },
      null,
      2,
    )}\n`,
    'nx.json': `${JSON.stringify(
      {
        $schema: './node_modules/nx/schemas/nx-schema.json',
        plugins: [
          {
            plugin: '@megamono/nx-apple',
            options: { scope: 'probe' },
          },
        ],
      },
      null,
      2,
    )}\n`,
    'packages/core/Package.swift': `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ProbeCore",
  products: [.library(name: "ProbeCore", targets: ["ProbeCore"])],
  targets: [
    .target(name: "ProbeCore"),
    .testTarget(name: "ProbeCoreTests", dependencies: ["ProbeCore"])
  ]
)
`,
    'packages/core/Sources/ProbeCore/ProbeCore.swift':
      'public func answer() -> Int { 42 }\n',
    'packages/core/Tests/ProbeCoreTests/ProbeCoreTests.swift': `import XCTest
@testable import ProbeCore

final class ProbeCoreTests: XCTestCase {
  func testAnswer() { XCTAssertEqual(answer(), 42) }
}
`,
    'apps/cli/Package.swift': `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ProbeApp",
  dependencies: [.package(path: "../../packages/core")],
  targets: [
    .target(
      name: "ProbeAppCore",
      dependencies: [.product(name: "ProbeCore", package: "core")]
    ),
    .executableTarget(name: "ProbeApp", dependencies: ["ProbeAppCore"]),
    .testTarget(name: "ProbeAppTests", dependencies: ["ProbeAppCore"])
  ]
)
`,
    'apps/cli/Sources/ProbeAppCore/ProbeAppCore.swift': `import ProbeCore

public func appAnswer() -> Int { answer() }
`,
    'apps/cli/Sources/ProbeApp/main.swift': `import ProbeAppCore

print(appAnswer())
`,
    'apps/cli/Tests/ProbeAppTests/ProbeAppTests.swift': `import XCTest
@testable import ProbeAppCore

final class ProbeAppTests: XCTestCase {
  func testAppAnswer() { XCTAssertEqual(appAnswer(), 42) }
}
`,
  };
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = resolve(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const temporaryRoot = await mkdtemp(
  join(tmpdir(), 'megamono-nx-apple-registry-e2e-'),
);
const fixtureRoot = resolve(temporaryRoot, 'fixture');
const npmCache = resolve(temporaryRoot, 'npm-cache');
const npmConfig = resolve(temporaryRoot, 'npmrc');
const registryConfig = resolve(temporaryRoot, 'verdaccio.json');
const swiftCache = resolve(temporaryRoot, 'swift-module-cache');
const port = await availablePort();
const registry = `http://127.0.0.1:${port}`;
await mkdir(fixtureRoot, { recursive: true });
await writeFile(
  npmConfig,
  `registry=${registry}\n//127.0.0.1:${port}/:_authToken=local-e2e-token\n`,
  'utf8',
);
await writeFile(
  registryConfig,
  `${JSON.stringify(
    {
      storage: resolve(temporaryRoot, 'registry-storage'),
      uplinks: { npmjs: { url: 'https://registry.npmjs.org/' } },
      packages: {
        '**': {
          access: '$all',
          publish: '$all',
          unpublish: '$all',
          proxy: 'npmjs',
        },
      },
      log: { type: 'stdout', format: 'pretty', level: 'warn' },
      publish: { allow_offline: true },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const verdaccio = spawn(
  process.execPath,
  [
    resolve(workspaceRoot, 'node_modules/verdaccio/bin/verdaccio'),
    '--config',
    registryConfig,
    '--listen',
    `127.0.0.1:${port}`,
  ],
  { cwd: workspaceRoot, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
);
let registryLog = '';
verdaccio.stdout.on('data', (chunk) => {
  registryLog += chunk;
});
verdaccio.stderr.on('data', (chunk) => {
  registryLog += chunk;
});

let succeeded = false;
try {
  await waitForRegistry(registry, verdaccio, () => registryLog);
  const npmEnvironment = {
    npm_config_cache: npmCache,
    npm_config_userconfig: npmConfig,
  };
  await run(
    'npm',
    [
      'publish',
      './packages/nx-apple',
      '--registry',
      registry,
      '--access',
      'public',
      '--provenance=false',
    ],
    { env: npmEnvironment },
  );
  await writeFixture(fixtureRoot);
  await run(
    'npm',
    ['install', '--registry', registry, '--audit=false', '--fund=false'],
    { cwd: fixtureRoot, env: npmEnvironment },
  );

  const nxEnvironment = {
    CODE_SIGNING_ALLOWED: 'NO',
    CLANG_MODULE_CACHE_PATH: swiftCache,
    SWIFTPM_MODULECACHE_OVERRIDE: swiftCache,
    NX_DAEMON: 'false',
    NX_CACHE_PROJECT_GRAPH: 'false',
  };
  await run(
    'npm',
    [
      'exec',
      'nx',
      '--',
      'generate',
      '@megamono/nx-apple:application',
      '--name=Acme Tools Apple',
      '--directory=apps/apple',
      '--displayName=Acme Tools',
      '--bundleIdentifier=com.acme-tools.apple',
      '--deploymentTarget=14.0',
      '--scope=probe',
      '--tags=platform:apple,scope:probe,type:app,visibility:internal',
      '--interactive=false',
      '--skipFormat',
    ],
    { cwd: fixtureRoot, env: nxEnvironment },
  );

  const generatedShow = await run(
    'npm',
    ['exec', 'nx', '--', 'show', 'project', 'acme-tools-apple', '--json'],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  const generatedProject = JSON.parse(generatedShow.stdout);
  assert(
    generatedProject.root === 'apps/apple',
    'Generated Xcode app project root is incorrect.',
  );
  assert(generatedProject.targets.build, 'Generated build target is missing.');
  assert(generatedProject.targets.test, 'Generated test target is missing.');
  assert(
    generatedProject.targets.archive,
    'Generated archive target is missing.',
  );
  assert(
    generatedProject.tags.includes('platform:apple') &&
      generatedProject.tags.includes('scope:probe'),
    'Generated Apple project tags are incomplete.',
  );
  assert(
    await readFile(
      resolve(
        fixtureRoot,
        'apps/apple/acme-tools-apple.xcodeproj/xcshareddata/xcschemes/acme-tools-apple.xcscheme',
      ),
      'utf8',
    ),
    'Generated shared scheme is missing.',
  );

  for (const target of ['build', 'test', 'archive']) {
    await run(
      'npm',
      [
        'exec',
        'nx',
        '--',
        'run',
        `acme-tools-apple:${target}`,
        '--output-style=static',
      ],
      { cwd: fixtureRoot, env: nxEnvironment },
    );
  }
  assert(
    await readFile(
      resolve(
        fixtureRoot,
        '.nx/apple/acme-tools-apple/acme-tools-apple.xcarchive/Info.plist',
      ),
      'utf8',
    ),
    'Generated Apple archive is missing.',
  );

  const show = await run(
    'npm',
    ['exec', 'nx', '--', 'show', 'project', 'ProbeApp', '--json'],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  const project = JSON.parse(show.stdout);
  assert(project.root === 'apps/cli', 'Swift app project root is incorrect.');
  assert(
    project.tags.includes('scope:probe'),
    'Configured scope tag is missing.',
  );
  assert(project.targets.build, 'Swift build target is missing.');
  assert(project.targets.test, 'Swift test target is missing.');
  assert(
    !project.targets.lint,
    'SwiftLint target was emitted without a config.',
  );
  assert(
    JSON.stringify(project.metadata?.['megamono:preflight']) ===
      JSON.stringify({
        diagnostics: [],
        requiredTools: [
          {
            executable: 'swift',
            reason: 'Swift package build and test targets',
          },
        ],
      }),
    'Packed plugin did not expose deterministic preflight metadata.',
  );

  await run(
    'npm',
    [
      'exec',
      'nx',
      '--',
      'run-many',
      '-t',
      'build,test',
      '--projects=ProbeCore,ProbeApp',
      '--output-style=static',
    ],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  await run('npm', ['exec', 'nx', '--', 'graph', '--file=graph.json'], {
    cwd: fixtureRoot,
    env: nxEnvironment,
  });
  const graph = JSON.parse(
    await readFile(resolve(fixtureRoot, 'graph.json'), 'utf8'),
  );
  assert(
    graph.graph.dependencies.ProbeApp?.some(
      ({ target, type }) => target === 'ProbeCore' && type === 'static',
    ),
    'SwiftPM local dependency did not produce a static Nx edge.',
  );
  const affected = await run(
    'npm',
    [
      'exec',
      'nx',
      '--',
      'show',
      'projects',
      '--affected',
      '--files=packages/core/Sources/ProbeCore/ProbeCore.swift',
      '--json',
    ],
    { cwd: fixtureRoot, env: nxEnvironment },
  );
  assert(
    JSON.stringify(JSON.parse(affected.stdout).sort()) ===
      JSON.stringify(['ProbeApp', 'ProbeCore']),
    `Unexpected affected projects: ${affected.stdout.trim()}`,
  );
  const installedPlugin = JSON.parse(
    await readFile(
      resolve(fixtureRoot, 'node_modules/@megamono/nx-apple/package.json'),
      'utf8',
    ),
  );
  assert(
    installedPlugin.version === '0.0.1',
    'Fixture did not install the published Apple plugin.',
  );
  succeeded = true;
  process.stdout.write(
    'nx-apple local-registry e2e passed: packed generator build/test/archive, Swift targets, static edge, and affected propagation verified.\n',
  );
} finally {
  verdaccio.kill('SIGTERM');
  await new Promise((resolvePromise) => {
    if (verdaccio.exitCode !== null) resolvePromise();
    else verdaccio.once('exit', resolvePromise);
  });
  if (succeeded) await rm(temporaryRoot, { recursive: true, force: true });
  else
    process.stderr.write(
      `Retained failed e2e workspace for inspection: ${temporaryRoot}\n`,
    );
}
