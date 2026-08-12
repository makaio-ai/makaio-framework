/**
 * Cross-backend conformance: Drizzle backend for session ownership storage.
 *
 * Provisions a fresh SQLite database per test via `useDrizzleTestLifecycle`,
 * which registers the session, agent and ownership handlers over that database.
 * The shared suite then exercises the contract identically to the
 * memory-backend suite, so any divergence between the two backends fails here or
 * there rather than in production.
 */
import { describe } from 'vitest';
import { eq } from 'drizzle-orm';
import { resolveSchema } from '@makaio/storage-drizzle';
import { useDrizzleTestLifecycle } from './shared.js';
import { describeSessionOwnershipBehavior } from './session-ownership-behavior.js';
import { sessionStorageSchema } from '../schema.variants.js';
import { describeSessionOwnershipRequestNormalizationBehavior } from './session-ownership-request-normalization-behavior.js';

describe('registerDrizzleSessionOwnershipStorage', () => {
  const ctx = useDrizzleTestLifecycle();

  describeSessionOwnershipBehavior({
    clearClaimOwnerInstanceId: async (claimId) => {
      const { adapterSessionClaims } = resolveSchema(ctx.db, sessionStorageSchema);
      const cleared = await ctx.db
        .update(adapterSessionClaims)
        .set({ ownerInstanceId: null })
        .where(eq(adapterSessionClaims.claimId, claimId))
        .returning({ claimId: adapterSessionClaims.claimId });
      if (cleared.length === 0) throw new Error(`missing claim fixture row: ${claimId}`);
    },
  });
  describeSessionOwnershipRequestNormalizationBehavior();
});
