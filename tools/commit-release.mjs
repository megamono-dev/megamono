import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatibilityFiles, syncReleasePins } from './sync-release-pins.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
await syncReleasePins(root, true);
const directories = [
  'cli',
  'plugin',
  'nx-apple',
  'nx-cargo',
  'nx-cloudflare',
  'nx-extension',
  'nx-render',
  'nx-laravel',
  'nx-phpnative',
  'create-megamono',
];
const allowed = new Set([
  'package.json',
  'package-lock.json',
  ...compatibilityFiles,
  ...directories.map((name) => `packages/${name}/package.json`),
]);
const changed = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
if (!changed.length || changed.some((path) => !allowed.has(path)))
  throw new Error(
    'Release changes must be limited to version manifests, lockfile, and compatibility pins.',
  );
const manifest = async (name) =>
  JSON.parse(
    await readFile(join(root, 'packages', name, 'package.json'), 'utf8'),
  );
const megamono = (await manifest('plugin')).version;
const create = (await manifest('create-megamono')).version;
const tags = [`megamono@${megamono}`, `create-megamono@${create}`];
for (const tag of tags)
  if (git('tag', '--list', tag))
    throw new Error(`Release tag already exists: ${tag}`);
git('add', '--', ...changed);
git(
  'commit',
  '-m',
  `chore(release): megamono ${megamono}, create-megamono ${create}`,
);
for (const tag of tags) git('tag', '-a', tag, '-m', tag);
