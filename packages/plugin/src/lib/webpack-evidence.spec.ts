import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWebpackRuntimeEvidence,
  webpackChunkLoadOffsets,
} from './webpack-evidence';
import { verifyRuntimeDependencies } from './runtime-verification';

const source = `
function __webpack_require__() {}
__webpack_require__.u = (chunkId) => "" + chunkId + ".js";
__webpack_require__.f = {};
__webpack_require__.f.require = (chunkId, promises) => {
  var loaded = require("./" + __webpack_require__.u(chunkId));
};
__webpack_require__.e(123);
`;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(main = source, chunk = 'exports.value = 42;') {
  const root = await mkdtemp(join(tmpdir(), 'webpack-evidence-'));
  roots.push(root);
  const outputPath = join(root, 'dist');
  await mkdir(outputPath);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: {} }),
  );
  await writeFile(join(outputPath, 'main.js'), main);
  await writeFile(join(outputPath, '123.js'), chunk);
  const stats = {
    version: '5.110.1',
    hash: 'fixture-build',
    errors: [],
    assets: [
      { name: 'main.js', size: Buffer.byteLength(main) },
      { name: '123.js', size: Buffer.byteLength(chunk) },
    ],
    chunks: [
      { id: 'main', files: ['main.js'] },
      { id: 123, files: ['123.js'] },
    ],
  };
  const evidence = await createWebpackRuntimeEvidence({ outputPath, stats });
  const path = join(root, 'evidence.json');
  await writeFile(path, JSON.stringify(evidence));
  const verify = (withEvidence = true) =>
    verifyRuntimeDependencies({
      workspaceRoot: root,
      projectRoot: '.',
      project: 'api',
      outputPath: 'dist',
      ...(withEvidence ? { webpackEvidence: 'evidence.json' } : {}),
    });
  return { root, outputPath, path, evidence, stats, verify };
}
describe('Webpack Node chunk evidence', () => {
  it('requires opt-in and binds the known loader to hashed emitted chunks', async () => {
    const f = await fixture();
    expect((await f.verify(false)).findings).toEqual([
      expect.objectContaining({ code: 'runtime-analysis-incomplete' }),
    ]);
    expect(await f.verify()).toMatchObject({
      findings: [],
      webpackEvidence: { qualifiedLoads: 1, compilationHash: 'fixture-build' },
    });
  });
  it.each(['stale', 'missing', 'extra', 'symlink'])(
    'fails closed for %s output',
    async (mode) => {
      const f = await fixture();
      if (mode === 'stale')
        await writeFile(join(f.outputPath, '123.js'), 'changed');
      if (mode === 'missing' || mode === 'symlink')
        await rm(join(f.outputPath, '123.js'));
      if (mode === 'extra')
        await writeFile(join(f.outputPath, 'extra.js'), 'exports.value = 0');
      if (mode === 'symlink')
        await symlink(
          join(f.outputPath, 'main.js'),
          join(f.outputPath, '123.js'),
        );
      expect((await f.verify()).findings).toContainEqual(
        expect.objectContaining({ code: 'runtime-evidence-invalid' }),
      );
    },
  );
  it('does not waive external dependencies in lazy chunks', async () => {
    const f = await fixture(
      source,
      'module.exports = require("lazy-dependency")',
    );
    expect((await f.verify()).findings).toContainEqual(
      expect.objectContaining({
        code: 'runtime-dependency-missing',
        package: 'lazy-dependency',
      }),
    );
  });
  it.each([
    source + '\nrequire(process.env.MODULE);',
    source + '\nimport(process.env.MODULE);',
    source.replace(
      '__webpack_require__.e(123)',
      '__webpack_require__.e(process.env.CHUNK)',
    ),
    source.replace('"" + chunkId + ".js"', 'process.env.MODULE'),
    source.replace('"" + chunkId + ".js"', '"../" + chunkId + ".js"'),
    source.replace('"" + chunkId + ".js"', '"other.js"'),
    source + '\n__webpack_require__.u = () => "other.js";',
    source + '\n__webpack_require__["u"] = () => "other.js";',
    source + '\nObject.assign(__webpack_require__, {u: () => "other.js"});',
    source + '\nconst alias = __webpack_require__; alias.u = () => "other.js";',
    source + '\n__webpack_require__.f.require(process.env.CHUNK, []);',
    source.replace('var loaded', 'chunkId = process.env.CHUNK; var loaded'),
    source.replace(
      '__webpack_require__.f.require =',
      'function unknown() {}\nunknown.loader =',
    ),
  ])('leaves unqualified dynamic loads open: %s', async (main) => {
    const f = await fixture(main);
    expect((await f.verify()).findings).toContainEqual(
      expect.objectContaining({ code: 'runtime-analysis-incomplete' }),
    );
  });
  it('rejects corrupt/unsafe evidence and failed or incomplete stats', async () => {
    const f = await fixture();
    for (const stats of [
      { ...f.stats, errors: ['build failed'] },
      { ...f.stats, children: [] },
      { ...f.stats, assets: [{ name: '../escape.js', size: 1 }] },
      { ...f.stats, assets: [] },
    ]) {
      await expect(
        createWebpackRuntimeEvidence({ outputPath: f.outputPath, stats }),
      ).rejects.toThrow();
    }
    await writeFile(f.path, '{');
    expect((await f.verify()).findings).toContainEqual(
      expect.objectContaining({ code: 'runtime-evidence-invalid' }),
    );
    await writeFile(
      f.path,
      JSON.stringify({ ...f.evidence, chunks: { 123: ['../escape.js'] } }),
    );
    expect((await f.verify()).findings).toContainEqual(
      expect.objectContaining({ code: 'runtime-evidence-invalid' }),
    );
  });
  it('rejects a forged graph that points the getter at a different chunk', async () => {
    const f = await fixture();
    expect(
      webpackChunkLoadOffsets(source, 'main.js', {
        ...f.evidence,
        chunks: { 123: ['main.js'] },
      }).size,
    ).toBe(0);
    expect(await readFile(join(f.outputPath, 'main.js'), 'utf8')).toBe(source);
  });
});
