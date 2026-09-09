import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const workspace = resolve(import.meta.dirname, '../../..');
const require = createRequire(join(workspace, 'package.json'));
// Resolve through the declared Nx dependency chain, not accidental root hoisting.
const nextRequire = createRequire(require.resolve('@nx/next/package.json'));
const webpackRequire = createRequire(
  nextRequire.resolve('@nx/webpack/package.json'),
);
const webpack = webpackRequire('webpack');
const root = await mkdtemp(join(tmpdir(), 'megamono-webpack-evidence-'));
try {
  const [packed] = JSON.parse(
    execFileSync(
      'npm',
      [
        'pack',
        join(workspace, 'packages/plugin'),
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
  await mkdir(join(root, 'package/node_modules'), { recursive: true });
  for (const name of ['typescript', 'tslib'])
    await symlink(
      dirname(require.resolve(`${name}/package.json`)),
      join(root, 'package/node_modules', name),
    );
  const packedRequire = createRequire(join(root, 'package/consumer.cjs'));
  const { createWebpackRuntimeEvidence } = packedRequire(
    '@megamono/plugin/webpack',
  );
  const { verifyRuntimeDependencies } = packedRequire(
    './dist/lib/runtime-verification.js',
  );
  await writeFile(
    join(root, 'package/consumer.ts'),
    `import { createWebpackRuntimeEvidence, type WebpackRuntimeEvidence } from '@megamono/plugin/webpack';\nexport const record: Promise<WebpackRuntimeEvidence> = createWebpackRuntimeEvidence({ outputPath: '/not-executed', stats: {} });\n`,
  );
  await writeFile(
    join(root, 'package/tsconfig.consumer.json'),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        module: 'nodenext',
        target: 'es2022',
        types: [],
      },
      files: ['consumer.ts'],
    }),
  );
  execFileSync(
    process.execPath,
    [
      require.resolve('typescript/bin/tsc'),
      '--project',
      join(root, 'package/tsconfig.consumer.json'),
    ],
    { cwd: root, stdio: 'pipe' },
  );
  await writeFile(join(root, 'package.json'), '{"private":true}');
  await writeFile(
    join(root, 'entry.js'),
    'module.exports = () => Promise.all([import("./lazy.js"), import("./other.js")]).then(([a, b]) => a.value + b.value);',
  );
  await writeFile(join(root, 'lazy.js'), 'export const value = 42;');
  await writeFile(join(root, 'other.js'), 'export const value = 0;');
  const outputPath = join(root, 'dist');
  for (const chunkFilename of [
    '[id].js',
    '[id].[contenthash].js',
    'chunks/[id].[contenthash].js',
  ]) {
    const stats = await new Promise((accept, reject) => {
      const compiler = webpack({
        mode: 'production',
        target: 'node',
        devtool: false,
        entry: join(root, 'entry.js'),
        output: {
          path: outputPath,
          filename: 'main.js',
          chunkFilename,
          clean: true,
          library: { type: 'commonjs2' },
        },
        optimization: { minimize: false },
      });
      compiler.run((error, result) =>
        compiler.close((closeError) =>
          error || closeError || result.hasErrors()
            ? reject(error ?? closeError ?? new Error(result.toString()))
            : accept(result),
        ),
      );
    });
    const evidence = await createWebpackRuntimeEvidence({
      outputPath,
      stats: stats.toJson({
        all: false,
        version: true,
        hash: true,
        errors: true,
        assets: true,
        chunks: true,
        ids: true,
      }),
    });
    await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence));
    const report = await verifyRuntimeDependencies({
      workspaceRoot: root,
      projectRoot: '.',
      project: 'api',
      outputPath: 'dist',
      webpackEvidence: 'evidence.json',
    });
    assert.deepEqual(report.findings, [], JSON.stringify(report, null, 2));
    assert.equal(report.webpackEvidence.qualifiedLoads, 1);
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        'require(process.argv[1])().then(n => console.log(String(n)))',
        join(outputPath, 'main.js'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(output.trim(), '42');
    const chunk = Object.keys(evidence.assets).find(
      (name) => name !== 'main.js',
    );
    await writeFile(
      join(outputPath, chunk),
      (await readFile(join(outputPath, chunk), 'utf8')) +
        '\n// changed after evidence',
    );
    assert(
      (
        await verifyRuntimeDependencies({
          workspaceRoot: root,
          projectRoot: '.',
          project: 'api',
          outputPath: 'dist',
          webpackEvidence: 'evidence.json',
        })
      ).findings.some(({ code }) => code === 'runtime-evidence-invalid'),
    );
  }
  console.log(
    `Packed Webpack evidence passed with Webpack ${webpack.version}: real Node lazy chunks, ID/contenthash filenames, child-process smoke and stale evidence rejection. No container qualification claimed.`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
