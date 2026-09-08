import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { checkEmittedTypeScript } from './emitted-typescript.mjs';

test('paired tests compile even when production tsconfig excludes them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'megamono-emitted-types-'));
  try {
    await writeFile(join(root, 'package.json'), '{"type":"commonjs"}');
    await symlink(
      resolve(import.meta.dirname, '../../../node_modules'),
      join(root, 'node_modules'),
      'dir',
    );
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ exclude: ['**/*.spec.ts'] }),
    );
    await writeFile(
      join(root, 'controller.ts'),
      'export function checkout(input: { idempotencyKey: string }) { return input; }',
    );
    const files = ['controller.ts', 'controller.spec.ts'];
    await writeFile(
      join(root, files[1]),
      'import { checkout } from "./controller.js"; checkout({});',
    );
    const failed = checkEmittedTypeScript(root, files);
    assert.equal(failed.passed, false);
    assert(
      failed.diagnostics.some(
        (item) => item.code === 2345 && item.message.includes('idempotencyKey'),
      ),
    );
    await writeFile(
      join(root, files[1]),
      'import { checkout } from "./controller.js"; checkout({ idempotencyKey: "fixture" });',
    );
    assert.deepEqual(checkEmittedTypeScript(root, files).diagnostics, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
