import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const version = '0.1.0-next.1';
const releaseTags = [`megamono@${version}`, `create-megamono@${version}`];

async function fixture(t, initialVersion = version) {
  const root = await mkdtemp(join(tmpdir(), 'megamono-release-commit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const put = async (file, content) => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  };
  const json = (file, value) =>
    put(file, `${JSON.stringify(value, null, 2)}\n`);
  await json('package.json', { name: 'release-commit-fixture', private: true });
  await put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  await put('source.ts', 'export const value = 1;\n');
  await json('packages/plugin/package.json', {
    name: '@megamono/plugin',
    version: initialVersion,
  });
  await json('packages/create-megamono/package.json', {
    name: 'create-megamono',
    version: initialVersion,
  });
  for (const name of ['plugin', 'create-megamono'])
    await json(`packages/${name}/compatibility.json`, {
      scaffoldPackages: { '@megamono/plugin': initialVersion },
    });
  await mkdir(join(root, 'tools'));
  for (const name of ['commit-release.mjs', 'sync-release-pins.mjs'])
    await cp(new URL(name, import.meta.url), join(root, 'tools', name));
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release Test');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('add', '.');
  git('commit', '-m', 'Initial fixture');
  const initial = git('rev-parse', 'HEAD');
  const run = () =>
    spawnSync(process.execPath, ['tools/commit-release.mjs'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
  const assertReleased = () => {
    assert.notEqual(git('rev-parse', 'HEAD'), initial);
    assert.equal(
      git('log', '-1', '--format=%s'),
      `chore(release): megamono ${version}, create-megamono ${version}`,
    );
    for (const tag of releaseTags) {
      assert.equal(git('cat-file', '-t', `refs/tags/${tag}`), 'tag');
      assert.equal(
        git('rev-parse', `${tag}^{commit}`),
        git('rev-parse', 'HEAD'),
      );
    }
    assert.equal(git('status', '--porcelain'), '');
  };
  const assertUnreleased = () => {
    assert.equal(git('rev-parse', 'HEAD'), initial);
    assert.equal(git('tag', '--list'), '');
  };
  return {
    root,
    git,
    put,
    json,
    initial,
    run,
    assertReleased,
    assertUnreleased,
  };
}

test('releasing an already-recorded version creates an empty release commit and annotated tags', async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  f.assertReleased();
  assert.equal(
    f.git('rev-parse', 'HEAD^{tree}'),
    f.git('rev-parse', `${f.initial}^{tree}`),
  );
});

test('allowed manifest and lockfile changes are committed with the release', async (t) => {
  const f = await fixture(t, '0.1.0-next.0');
  await f.json('packages/plugin/package.json', {
    name: '@megamono/plugin',
    version,
  });
  await f.json('packages/create-megamono/package.json', {
    name: 'create-megamono',
    version,
  });
  for (const name of ['plugin', 'create-megamono'])
    await f.json(`packages/${name}/compatibility.json`, {
      scaffoldPackages: { '@megamono/plugin': version },
    });
  await f.json('package.json', {
    name: 'release-commit-fixture',
    private: true,
    version,
  });
  await f.put('pnpm-lock.yaml', 'lockfileVersion: 9\nsettings: {}\n');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  f.assertReleased();
  assert.deepEqual(
    f
      .git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')
      .split('\n'),
    [
      'package.json',
      'packages/create-megamono/compatibility.json',
      'packages/create-megamono/package.json',
      'packages/plugin/compatibility.json',
      'packages/plugin/package.json',
      'pnpm-lock.yaml',
    ],
  );
});

for (const kind of [
  'unstaged',
  'staged',
  'untracked',
  'staged-then-restored',
]) {
  test(`unrelated ${kind} changes prevent a release commit and tags`, async (t) => {
    const f = await fixture(t);
    await f.json('package.json', {
      name: 'release-commit-fixture',
      private: true,
      version,
    });
    if (kind === 'untracked') await f.put('unrelated.txt', 'unexpected\n');
    else {
      await f.put('source.ts', 'export const value = 2;\n');
      if (kind !== 'unstaged') f.git('add', 'source.ts');
      if (kind === 'staged-then-restored')
        await f.put('source.ts', 'export const value = 1;\n');
    }
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Release changes must be limited/);
    f.assertUnreleased();
  });
}

test('either existing release tag prevents a new release commit or partial tagging', async (t) => {
  for (const existing of releaseTags) {
    const f = await fixture(t);
    f.git('tag', '-a', existing, '-m', 'Existing release');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Release tag already exists/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.initial);
    assert.equal(f.git('tag', '--list'), existing);
  }
});

test('compatibility-pin drift prevents tagging and does not silently rewrite evidence', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'packages/create-megamono/compatibility.json');
  await f.json('packages/create-megamono/compatibility.json', {
    scaffoldPackages: {},
  });
  const before = await readFile(path, 'utf8');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differs from canonical/);
  assert.equal(await readFile(path, 'utf8'), before);
  f.assertUnreleased();
});
