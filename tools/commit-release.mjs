import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatibilityFiles, syncReleasePins } from './sync-release-pins.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const gitOutput = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const git = (...args) => gitOutput(...args).trim();
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
  'pnpm-lock.yaml',
  ...compatibilityFiles,
  ...directories.map((name) => `packages/${name}/package.json`),
]);
// Inspect the index separately: a staged source edit can be hidden from the
// HEAD-to-worktree diff by restoring only its working copy. Include untracked
// files as well so allowing an empty release never weakens the path guard.
const changed = [
  ...new Set(
    [
      ...gitOutput('diff', '--name-only', '--no-renames', '-z', 'HEAD').split(
        '\0',
      ),
      ...gitOutput(
        'diff',
        '--cached',
        '--name-only',
        '--no-renames',
        '-z',
      ).split('\0'),
      ...gitOutput('ls-files', '--others', '--exclude-standard', '-z').split(
        '\0',
      ),
    ].filter(Boolean),
  ),
];
const unexpected = changed.filter((path) => !allowed.has(path));
if (unexpected.length)
  throw new Error(
    `Release changes must be limited to version manifests, lockfile, and compatibility pins. Unexpected paths: ${unexpected.join(', ')}`,
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
if (changed.length) git('add', '--', ...changed);
git(
  'commit',
  // Exact prerelease versions may already be committed for local review. Still
  // record a distinct release revision for the annotated tags and provenance.
  '--allow-empty',
  '-m',
  `chore(release): megamono ${megamono}, create-megamono ${create}`,
);
for (const tag of tags) git('tag', '-a', tag, '-m', tag);
