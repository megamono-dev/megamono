import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  UI_LANES,
  pinManifest,
  qualificationSummary,
  selectLane,
  selectLanes,
} from './ui-qualification.mjs';
const compatibility = JSON.parse(
  readFileSync(new URL('../compatibility.json', import.meta.url), 'utf8'),
);

test('matrix selections accept direct and Nx-forwarded options without accepting unknown or duplicate lanes', () => {
  const selected = ['scaffold', 'scaffold-eslint10'];
  assert.deepEqual(
    selectLanes(['--lanes=scaffold,scaffold-eslint10']),
    selected,
  );
  assert.deepEqual(
    selectLanes(['--lanes=scaffold', 'scaffold-eslint10']),
    selected,
  );
  assert.deepEqual(selectLanes([]), Object.keys(UI_LANES));
  assert.throws(() => selectLanes(['--lanes=scaffold', '--force']));
  assert.throws(() => selectLanes(['--lanes=scaffold,scaffold']));
});

test('explicit lanes retain supported TS6 and do not change scaffold policy', () => {
  for (const name of Object.keys(UI_LANES)) {
    const selected = selectLane([`--lane=${name}`], compatibility);
    assert.equal(selected.changesScaffoldDefaults, false);
    assert.equal(selected.versions.typescript, '6.0.3');
  }
  assert.equal(selectLane([], compatibility).name, 'scaffold');
  assert.throws(() => selectLane(['--lane=../../unsafe'], compatibility));
  assert.throws(() => selectLane(['--lane=ts7'], compatibility));
  assert.throws(() => selectLane(['--force'], compatibility));
});
test('pins every selected workspace peer without mutating inputs or losing unrelated dependencies', () => {
  const source = {
    dependencies: { next: '^16', '@chakra-ui/react': '^3', unrelated: '^1' },
    devDependencies: { eslint: '^9' },
  };
  const pinned = pinManifest(source, UI_LANES['newer-ui-eslint10']);
  assert.equal(source.dependencies.next, '^16');
  assert.equal(pinned.dependencies.next, '16.3.3');
  assert.equal(pinned.dependencies['@chakra-ui/react'], '3.37.0');
  assert.equal(pinned.devDependencies.eslint, '10.6.0');
  assert.equal(pinned.dependencies.unrelated, '^1');
  assert.equal(pinned.devDependencies.typescript, undefined);
  assert.equal(
    pinManifest({}, UI_LANES.scaffold, true).devDependencies.typescript,
    '6.0.3',
  );
  assert.throws(() => pinManifest({}, { next: 'latest' }, true));
});
test('dependency installation never substitutes for lint/build/browser evidence', () => {
  const installed = [{ id: 'clean-artifact-bootstrap', status: 'passed' }];
  assert.equal(qualificationSummary(installed).status, 'incomplete');
  const failed = qualificationSummary([
    ...installed,
    { id: 'lint', status: 'failed' },
  ]);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.installation, 'passed');
  assert.equal(failed.generatedLint, 'failed');
  assert.equal(failed.stages.browser, 'not-run');
  const complete = Object.keys(failed.stages).map((id) => ({
    id,
    status: 'passed',
  }));
  assert.equal(qualificationSummary(complete).status, 'qualified');
});
