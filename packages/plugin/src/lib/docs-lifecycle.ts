import type { MegamonoConfig } from './config';
import type { RepositoryDocument } from './docs';

export interface ArchiveRequest {
  readonly id: string;
  readonly status?: string;
  readonly reason?: string;
  readonly replacementId?: string;
  readonly completedAt?: string;
}

export interface ArchivePlan {
  readonly document: RepositoryDocument;
  readonly destinationRelativePath: string;
  readonly data: RepositoryDocument['data'];
}

export function planDocumentArchive(
  documents: readonly RepositoryDocument[],
  request: ArchiveRequest,
  now = new Date(),
): ArchivePlan {
  const document = documents.find(
    (candidate) => candidate.data.id === request.id,
  );
  if (!document) throw new Error(`Document ${request.id} does not exist.`);
  if (document.archived)
    throw new Error(`Document ${request.id} is already archived.`);

  const data = { ...document.data };
  switch (data.type) {
    case 'plan':
      if (
        !request.status ||
        !['completed', 'aborted'].includes(request.status)
      ) {
        throw new Error(
          'Plans require --status=completed or --status=aborted.',
        );
      }
      if (request.status === 'aborted' && !request.reason) {
        throw new Error('Aborted plans require --reason.');
      }
      data.status = request.status;
      data.completed_at = request.completedAt ?? now.toISOString();
      if (request.status === 'aborted') data.aborted_because = request.reason;
      break;
    case 'spec': {
      if (
        !request.status ||
        !['retired', 'superseded'].includes(request.status)
      ) {
        throw new Error(
          'Specs require --status=retired or --status=superseded.',
        );
      }
      if (request.status === 'superseded') {
        if (!request.replacementId) {
          throw new Error('Superseded specs require --replacementId.');
        }
        const replacement = documents.find(
          (candidate) => candidate.data.id === request.replacementId,
        );
        if (
          !replacement ||
          replacement.data.type !== 'spec' ||
          replacement.data.supersedes !== data.id
        ) {
          throw new Error(
            `Replacement ${request.replacementId} must be a spec that declares supersedes: ${data.id}.`,
          );
        }
      }
      data.status = request.status;
      break;
    }
    case 'research':
      if (request.status && request.status !== 'complete') {
        throw new Error('Research may only transition to --status=complete.');
      }
      data.status = 'complete';
      break;
    default:
      throw new Error(`Documents of type ${data.type} do not archive.`);
  }

  return {
    document,
    destinationRelativePath: `archives/${document.relativePath}`,
    data,
  };
}

export function findExpiredReports(
  documents: readonly RepositoryDocument[],
  config: MegamonoConfig,
  now = new Date(),
): readonly RepositoryDocument[] {
  const currentTime = now.getTime();
  return documents
    .filter((document) => document.data.type === 'report')
    .filter((document) => {
      const generatedAt = new Date(document.data.generated_at ?? '').getTime();
      const retentionDays =
        document.data.retention_days ?? config.docs.reportRetentionDays;
      return generatedAt + retentionDays * 86_400_000 < currentTime;
    })
    .sort((left, right) => left.data.id.localeCompare(right.data.id));
}
