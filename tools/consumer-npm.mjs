import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** npm consumers stay npm consumers when their parent task is run by pnpm. */
export function resolveConsumerNpmCli({
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  const candidates = [];
  if (env.npm_execpath) candidates.push(env.npm_execpath);
  for (const directory of (env.PATH ?? env.Path ?? '').split(
    platform === 'win32' ? ';' : ':',
  )) {
    if (!directory) continue;
    candidates.push(
      join(directory, 'npm'),
      join(directory, 'node_modules/npm/bin/npm-cli.js'),
    );
  }
  candidates.push(
    join(dirname(execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  );
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const actual = realpathSync(candidate);
    if (basename(actual) === 'npm-cli.js' && statSync(actual).isFile())
      return resolve(actual);
  }
  throw new Error(
    'An npm consumer fixture requires an installed npm CLI. Install the qualified npm version and put it on PATH; npm_execpath may belong to pnpm.',
  );
}
