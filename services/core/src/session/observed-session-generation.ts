/**
 * Compaction-ordinal advances for observed sessions.
 *
 * The `generation` column counts provider compactions. Two seams write it,
 * because one key cannot reach every row:
 * - hook-observed sessions are addressed by the `(source, adapterSessionId)`
 *   import identity, through `storage:session.rebindObserved`;
 * - adapter-managed sessions carry no `source` — nothing on the managed path
 *   writes one — so that key can never match them, and they are addressed by
 *   `sessionId` through `storage:session.update`.
 *
 * Both advances are best-effort and relative to the stored value. Storage
 * increments in SQL, so the ordinal stays monotonic and repeat-free even when
 * two advances race; a miss leaves it where it was, which consumers read as
 * "no new generation" rather than as a wrong one.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from './storage/namespace.js';

/**
 * Advance a hook-observed session's compaction ordinal and nothing else.
 *
 * A rebind request carrying no locality field writes no locality column, so this
 * reuses the seam that already owns the ordinal instead of adding a second
 * writer for it. A `'not-found'` outcome (or absent storage) is left alone: the
 * row a continuation has never seen is not invented here.
 * @param bus - Bus the write is issued on
 * @param adapterSessionId - External session id whose row should advance
 * @param source - Import identity the row is stored under
 */
export async function advanceObservedGeneration(
  bus: IMakaioBus,
  adapterSessionId: string,
  source: string,
): Promise<void> {
  await bus.requestOptional(SessionStorageSubjects.rebindObserved, {
    externalSessionId: adapterSessionId,
    source,
    startMode: 'compact',
  });
}

/**
 * Advance an adapter-managed session's compaction ordinal.
 *
 * Prefers the framework session id the managed-session gate remembered from
 * `client.runtime.started`, because that id does not move. Falling back to a
 * lookup by provider session id is correct only while the session has never
 * rotated: `getByAdapterSessionId` compares the immutable origin column, so
 * after a confirmed rotation the live id lives in `currentAdapterSessionId` and
 * the origin comparison misses the very row it is looking for.
 *
 * The fallback also finds nothing until settlement mirrors the provider session
 * id onto the session row. A compaction that resolves to no row is not counted
 * rather than fabricating one, which is the same rule the hook-observed path
 * follows.
 * @param bus - Bus the lookup and write are issued on
 * @param adapterSessionId - Provider session id reported by the hook
 * @param knownSessionId - Framework session id from the gate, when one is known
 */
export async function advanceManagedGeneration(
  bus: IMakaioBus,
  adapterSessionId: string,
  knownSessionId: string | undefined,
): Promise<void> {
  const sessionId = knownSessionId ?? (await resolveManagedSessionId(bus, adapterSessionId));
  if (sessionId === undefined) {
    if (process.env['MAKAIO_DEBUG'] === 'true') {
      console.debug('[ObservedSessionIngestion] Managed compaction reached no row; ordinal not advanced', {
        adapterSessionId,
      });
    }
    return;
  }
  await bus.requestOptional(SessionStorageSubjects.update, { sessionId, advanceGeneration: true });
}

/**
 * Resolve a managed session's framework id from its provider session id.
 *
 * The source-less lookup the managed path requires: managed rows carry no
 * `source`, so the two-column import identity cannot address them.
 * @param bus - Bus the lookup is issued on
 * @param adapterSessionId - Provider session id reported by the hook
 * @returns The framework session id, or `undefined` when no row matches
 */
async function resolveManagedSessionId(bus: IMakaioBus, adapterSessionId: string): Promise<string | undefined> {
  const lookup = await bus.requestOptional(SessionStorageSubjects.getByAdapterSessionId, { adapterSessionId });
  if (!lookup.handled || lookup.data.session === null) return undefined;
  return lookup.data.session.sessionId;
}
