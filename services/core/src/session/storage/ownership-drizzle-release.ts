/**
 * Single-generation release phase for Drizzle session ownership storage.
 * @packageDocumentation
 */
import { and, eq } from 'drizzle-orm';
import { executeTransaction, resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { SessionOwnershipReleaseRequest, SessionOwnershipReleaseResult } from '@makaio/contracts';
import { sessionStorageSchema } from './schema.variants.js';
import { readClaimByToken } from './ownership-drizzle-reads.js';
import { lockAgentAllocation, mapClaim } from './ownership-drizzle-rows.js';

/**
 * Give up one claim generation.
 *
 * The allocation lock orders release against settlement without granting
 * authority. A missing agent remains releasable because release gives authority
 * up; it never allocates a fence.
 * @param db - Database handle.
 * @param payload - Release request.
 * @returns The modeled release outcome.
 */
export async function runRelease(
  db: MakaioDatabase,
  payload: SessionOwnershipReleaseRequest,
): Promise<SessionOwnershipReleaseResult> {
  const tables = resolveSchema(db, sessionStorageSchema);
  const { adapterSessionClaims } = tables;
  const now = Date.now();

  return executeTransaction(db, async (tx): Promise<SessionOwnershipReleaseResult> => {
    await lockAgentAllocation(tx, tables, payload.agentId);
    const generation = and(
      eq(adapterSessionClaims.claimToken, payload.claimToken),
      eq(adapterSessionClaims.agentId, payload.agentId),
    );
    if (payload.disposition === 'released') {
      const deleted = await tx
        .delete(adapterSessionClaims)
        .where(generation)
        .returning({ claimId: adapterSessionClaims.claimId });
      if (deleted.length > 0) return { outcome: 'released' };
    } else {
      const [marked] = await tx
        .update(adapterSessionClaims)
        .set({ status: payload.disposition, updatedAt: now })
        .where(generation)
        .returning();
      if (marked !== undefined) return { outcome: 'marked', claim: mapClaim(marked) };
    }
    const claim = await readClaimByToken(tx, tables, payload.claimToken);
    return claim === undefined ? { outcome: 'not-found' } : { outcome: 'not-owner', holder: mapClaim(claim) };
  });
}
