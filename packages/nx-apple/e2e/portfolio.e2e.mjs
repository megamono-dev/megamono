import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import apple from '../dist/index.js';

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    const append = (value, chunk) =>
      `${value}${chunk}`.slice(-(options.maxCapture ?? 100_000));
    if (options.capture) {
      child.stdout.on('data', (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr = append(stderr, chunk);
      });
    }
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (process.platform !== 'darwin')
  throw new Error('The nx-apple portfolio e2e requires macOS.');

const portfolioRoot = resolve(requiredEnvironment('NX_APPLE_PORTFOLIO_ROOT'));
const manifest = requiredEnvironment('NX_APPLE_PORTFOLIO_MANIFEST');
const scheme = requiredEnvironment('NX_APPLE_PORTFOLIO_SCHEME');
const destination =
  process.env.NX_APPLE_PORTFOLIO_DESTINATION?.trim() || 'platform=macOS';
const configuration =
  process.env.NX_APPLE_PORTFOLIO_CONFIGURATION?.trim() || 'Debug';
const requestedTargets = (
  process.env.NX_APPLE_PORTFOLIO_TARGETS || 'build,test,archive'
)
  .split(',')
  .map((target) => target.trim())
  .filter(Boolean);
assert(
  requestedTargets.length > 0,
  'At least one portfolio target is required.',
);

const manifestPath = resolve(portfolioRoot, manifest);
await access(manifestPath, constants.R_OK);
const initialStatus = (
  await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: portfolioRoot,
    capture: true,
  })
).stdout;

const nxRoot = resolve(portfolioRoot, '.nx');
const nxRootExisted = await pathExists(nxRoot);
await mkdir(nxRoot, { recursive: true });
const outputRoot = await mkdtemp(join(nxRoot, 'megamono-nx-apple-portfolio-'));
const derivedDataPath = relative(portfolioRoot, outputRoot);
let succeeded = false;
let cleaned = false;

async function cleanGeneratedOutputs() {
  if (nxRootExisted) await rm(outputRoot, { recursive: true, force: true });
  else await rm(nxRoot, { recursive: true, force: true });
  cleaned = true;
}

try {
  const collected = await apple.collectAppleManifests(
    [relative(portfolioRoot, manifestPath)],
    portfolioRoot,
  );
  assert(
    collected.diagnostics.length === 0,
    `Apple discovery produced diagnostics:\n${collected.diagnostics
      .map(({ message }) => message)
      .join('\n')}`,
  );
  const entries = apple.projectsFromAppleManifests(
    collected.records,
    portfolioRoot,
    { scheme, destination, configuration, derivedDataPath },
  );
  const projects = entries.flatMap(([, result]) =>
    Object.values(result.projects),
  );
  assert(
    projects.length === 1,
    `Expected one project, received ${projects.length}.`,
  );
  const [project] = projects;
  const preflight = project.metadata?.['megamono:preflight'];
  assert(
    !preflight?.diagnostics?.length,
    `Project preflight produced diagnostics:\n${(preflight?.diagnostics ?? [])
      .map(({ message }) => message)
      .join('\n')}`,
  );

  for (const targetName of requestedTargets) {
    const target = project.targets?.[targetName];
    assert(target, `Inferred target ${targetName} is missing.`);
    const targetCommand = target.options?.command;
    assert(
      typeof targetCommand === 'string' && targetCommand.length > 0,
      `Inferred target ${targetName} has no command.`,
    );
    process.stdout.write(
      `nx-apple portfolio: running ${project.name}:${targetName}\n`,
    );
    await run('/bin/sh', ['-c', targetCommand], {
      cwd: portfolioRoot,
      capture: true,
    });
  }

  if (requestedTargets.includes('archive')) {
    await access(
      resolve(outputRoot, `${project.name}.xcarchive`),
      constants.R_OK,
    );
  }
  await cleanGeneratedOutputs();
  const finalStatus = (
    await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: portfolioRoot,
      capture: true,
    })
  ).stdout;
  assert(
    finalStatus === initialStatus,
    `Portfolio worktree changed during validation.\nBefore:\n${initialStatus}\nAfter:\n${finalStatus}`,
  );
  succeeded = true;
  process.stdout.write(
    `nx-apple portfolio e2e passed: ${project.name} ${requestedTargets.join(', ')}.\n`,
  );
} finally {
  if (succeeded && !cleaned) await cleanGeneratedOutputs();
  else if (!succeeded && !cleaned)
    process.stderr.write(
      `Retained failed portfolio output for inspection: ${outputRoot}\n`,
    );
}
