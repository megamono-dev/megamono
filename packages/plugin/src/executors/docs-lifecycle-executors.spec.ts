import type { ExecutorContext } from '@nx/devkit';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MEGAMONO_CONFIG } from '../lib/config';
import docsArchiveExecutor from './docs-archive/docs-archive';
import docsPruneReportsExecutor from './docs-prune-reports/docs-prune-reports';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'megamono-lifecycle-'));
  await mkdir(join(root, 'docs', 'plans', 'test'), { recursive: true });
  await mkdir(join(root, 'docs', 'reports'), { recursive: true });
  await mkdir(join(root, 'docs', 'archives'), { recursive: true });
  await writeFile(
    join(root, 'megamono.json'),
    `${JSON.stringify(DEFAULT_MEGAMONO_CONFIG)}\n`,
  );
  return root;
}

function context(root: string): ExecutorContext {
  return { root } as ExecutorContext;
}

describe('documentation lifecycle executors', () => {
  it('keeps archive dry-run mutation-free and applies the same path plan', async () => {
    const root = await fixture();
    const source = join(root, 'docs', 'plans', 'test', 'ship.md');
    const destination = join(
      root,
      'docs',
      'archives',
      'plans',
      'test',
      'ship.md',
    );
    await writeFile(
      source,
      `---
id: plan-test-20260801-ship
type: plan
status: in-progress
visibility: internal
projects: [test]
topics: [plans]
summary: Ship the fixture.
date: 2026-08-01
supersedes: null
references: []
external_references: []
branch: feat/ship
---

# Ship
`,
    );
    try {
      expect(
        await docsArchiveExecutor(
          {
            id: 'plan-test-20260801-ship',
            status: 'completed',
            completedAt: '2026-08-23T12:00:00Z',
            dryRun: true,
          },
          context(root),
        ),
      ).toEqual({ success: true });
      expect(await exists(source)).toBe(true);
      expect(await exists(destination)).toBe(false);

      expect(
        await docsArchiveExecutor(
          {
            id: 'plan-test-20260801-ship',
            status: 'completed',
            completedAt: '2026-08-23T12:00:00Z',
          },
          context(root),
        ),
      ).toEqual({ success: true });
      expect(await exists(source)).toBe(false);
      expect(await readFile(destination, 'utf8')).toContain(
        'status: completed',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('previews expired reports and deletes only with confirm', async () => {
    const root = await fixture();
    const report = join(root, 'docs', 'reports', 'old.md');
    await writeFile(
      report,
      `---
id: report-health-20260501T000000Z
type: report
status: generated
visibility: internal
projects: [test]
topics: [health]
summary: Old health report.
date: 2026-05-01
supersedes: null
references: []
external_references: []
producer: health
generated_at: 2026-05-01T00:00:00Z
---

# Report
`,
    );
    try {
      expect(
        await docsPruneReportsExecutor(
          { now: '2026-08-23T00:00:00Z' },
          context(root),
        ),
      ).toEqual({ success: true });
      expect(await exists(report)).toBe(true);
      expect(
        await docsPruneReportsExecutor(
          { now: '2026-08-23T00:00:00Z', confirm: true },
          context(root),
        ),
      ).toEqual({ success: true });
      expect(await exists(report)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
