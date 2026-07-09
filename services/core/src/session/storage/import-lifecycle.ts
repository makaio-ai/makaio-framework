import type { IMakaioSession, ImportUpsertRequest } from '@makaio/contracts';

/**
 * Resolve the initial lifecycle status for a newly created imported session.
 * @param payload - Import upsert request payload
 * @returns Initial lifecycle status
 */
export function resolveImportCreateStatus(payload: Pick<ImportUpsertRequest, 'activation'>): IMakaioSession['status'] {
  return payload.activation === 'live' ? 'active' : 'discovered';
}
