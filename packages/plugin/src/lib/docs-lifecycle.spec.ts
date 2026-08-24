import { DEFAULT_MEGAMONO_CONFIG } from './config';
import type { RepositoryDocument } from './docs';
import { findExpiredReports, planDocumentArchive } from './docs-lifecycle';

function document(
  data: Partial<RepositoryDocument['data']> &
    Pick<RepositoryDocument['data'], 'id' | 'type' | 'status'>,
  relativePath: string,
): RepositoryDocument {
  return {
    absolutePath: `/workspace/docs/${relativePath}`,
    relativePath,
    archived: false,
    content: '# Fixture\n',
    data: {
      visibility: 'internal',
      projects: ['test'],
      topics: [],
      summary: 'Fixture.',
      date: '2026-08-01',
      supersedes: null,
      references: [],
      external_references: [],
      ...data,
    },
  } as RepositoryDocument;
}

describe('documentation lifecycle', () => {
  it('plans a terminal plan move without changing the source document', () => {
    const source = document(
      {
        id: 'plan-test-20260801-ship',
        type: 'plan',
        status: 'in-progress',
        branch: 'feat/ship',
      },
      'plans/test/ship.md',
    );
    const plan = planDocumentArchive(
      [source],
      { id: source.data.id, status: 'completed' },
      new Date('2026-08-23T12:00:00Z'),
    );
    expect(plan.destinationRelativePath).toBe('archives/plans/test/ship.md');
    expect(plan.data).toMatchObject({
      status: 'completed',
      completed_at: '2026-08-23T12:00:00.000Z',
    });
    expect(source.data.status).toBe('in-progress');
  });

  it('requires a matching replacement before superseding a spec', () => {
    const source = document(
      { id: 'spec-test-0001', type: 'spec', status: 'accepted' },
      'specs/test/01-source.md',
    );
    expect(() =>
      planDocumentArchive([source], {
        id: source.data.id,
        status: 'superseded',
        replacementId: 'spec-test-0002',
      }),
    ).toThrow('must be a spec');
  });

  it('uses per-report retention before the repository default', () => {
    const old = document(
      {
        id: 'report-health-20260601T000000Z',
        type: 'report',
        status: 'generated',
        generated_at: '2026-05-01T00:00:00Z',
        producer: 'health',
      },
      'reports/old.md',
    );
    const retained = document(
      {
        id: 'report-health-20260601T000001Z',
        type: 'report',
        status: 'generated',
        generated_at: '2026-06-01T00:00:01Z',
        producer: 'health',
        retention_days: 365,
      },
      'reports/retained.md',
    );
    expect(
      findExpiredReports(
        [retained, old],
        DEFAULT_MEGAMONO_CONFIG,
        new Date('2026-08-23T00:00:00Z'),
      ).map((item) => item.data.id),
    ).toEqual([old.data.id]);
  });
});
