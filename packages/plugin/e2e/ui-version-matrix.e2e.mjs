import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { selectLanes } from './ui-qualification.mjs';

const workspace = resolve(import.meta.dirname, '../../..');
const output = join(workspace, 'tmp/ui-bootstrap');
const args = process.argv.slice(2);
const names = selectLanes(args);
const summaryFile = join(
  output,
  args.length ? `matrix-${names.join('-')}.json` : 'matrix.json',
);
await mkdir(output, { recursive: true });
const summary = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  status: 'running',
  selectedLanes: names,
  lanes: [],
};
await writeFile(summaryFile, JSON.stringify(summary, null, 2));
for (const name of names) {
  console.log(`Qualifying UI lane: ${name}`);
  const started = Date.now();
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, 'ui-bootstrap.e2e.mjs'), `--lane=${name}`],
    { cwd: workspace, env: process.env, stdio: 'inherit' },
  );
  const code = await new Promise((resolveCode, reject) => {
    child.once('error', reject);
    child.once('exit', (exit) => resolveCode(exit ?? 1));
  });
  try {
    const report = JSON.parse(
      await readFile(join(output, name, 'report.json'), 'utf8'),
    );
    if (Date.parse(report.startedAt) < started)
      throw new Error('Stale lane report.');
    summary.lanes.push({
      name,
      exitCode: code,
      selected: report.lane.versions,
      resolved: report.versions,
      qualification: report.qualification,
      ...(report.failure ? { failure: report.failure } : {}),
    });
  } catch (error) {
    summary.lanes.push({ name, exitCode: code || 1, failure: error.message });
  }
  await writeFile(summaryFile, JSON.stringify(summary, null, 2));
}
summary.status = summary.lanes.every(
  (lane) => lane.exitCode === 0 && lane.qualification?.status === 'qualified',
)
  ? 'passed'
  : 'failed';
await writeFile(summaryFile, JSON.stringify(summary, null, 2));
if (summary.status !== 'passed') process.exitCode = 1;
