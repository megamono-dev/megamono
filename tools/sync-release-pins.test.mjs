import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { compatibilityFiles, syncReleasePins } from './sync-release-pins.mjs';

test('next and latest versions synchronize both scaffold registries without changing third-party pins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'megamono-release-pins-'));
  const put = async (file, value) => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), JSON.stringify(value, null, 2));
  };
  try {
    for (const file of compatibilityFiles)
      await put(file, {
        scaffoldPackages: { '@megamono/plugin': '0.0.1', nx: '23.1.1' },
      });
    for (const version of ['0.1.0-next.0', '0.1.0']) {
      await put('packages/plugin/package.json', {
        name: '@megamono/plugin',
        version,
      });
      await assert.rejects(syncReleasePins(root, true), /differs from release/);
      await syncReleasePins(root);
      await syncReleasePins(root, true);
      for (const file of compatibilityFiles)
        assert.deepEqual(
          JSON.parse(await readFile(join(root, file), 'utf8')).scaffoldPackages,
          { '@megamono/plugin': version, nx: '23.1.1' },
        );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
