/**
 * Handler for adapter.session.discovered events.
 *
 * Routes live session discovery events from adapter watchers into the
 * sessions table via `storage:session.importUpsert`.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionDiscoveredSchema } from '@makaio/contracts';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { toSessionLineage } from './lineage-utils.js';

/**
 * Register a bus handler for `adapter.session.discovered` events.
 *
 * When a session is discovered from a log watcher:
 * 1. Validates the payload with `SessionDiscoveredSchema` (fail-fast on schema violations).
 * 2. Calls `storage:session.importUpsert` to create or enrich the session record atomically.
 *    - On first discovery: inserts a stub session with `importStatus='discovered'` and
 *      eagerly resolves `parentSessionId` / `rootSessionId` when the parent is already imported.
 *    - On re-discovery: COALESCE-merges enrichment fields (title, cwd, logFilePath)
 *      so subsequent scans can supply previously-unknown values without overwriting existing data.
 * @param bus - The bus instance to register the handler on
 * @returns Cleanup function to unsubscribe the handler
 * @example
 * ```typescript
 * import { registerSessionDiscoveredHandler } from '@makaio/services-core/session';
 *
 * const cleanup = registerSessionDiscoveredHandler(bus);
 *
 * // Later, when shutting down:
 * cleanup();
 * ```
 */
export function registerSessionDiscoveredHandler(bus: IMakaioBus): () => void {
  return bus.on(AdapterSubjects.session.discovered, async (ctx) => {
    // The bus validates events, but safeParse keeps this handler fail-fast if a
    // transport or test bypasses schema enforcement and delivers malformed data.
    const parsedPayload = SessionDiscoveredSchema.safeParse(ctx.payload);
    if (!parsedPayload.success) {
      console.error('[registerSessionDiscoveredHandler] Invalid adapter.session.discovered payload', {
        issues: parsedPayload.error.issues,
      });
      throw parsedPayload.error;
    }

    const {
      adapterId,
      adapterSessionId,
      adapterName,
      cwd,
      title,
      logFilePath,
      startedAt,
      kind,
      parentAdapterSessionId,
      forkPointMessageId,
    } = parsedPayload.data;

    const lineage = toSessionLineage({
      kind,
      parentAdapterSessionId: parentAdapterSessionId ?? null,
      forkPointMessageId: forkPointMessageId ?? null,
    });

    await bus.request(SessionStorageSubjects.importUpsert, {
      externalSessionId: adapterSessionId,
      source: adapterName,
      adapterId,
      cwd: cwd ?? null,
      ...(title !== undefined ? { title } : {}),
      ...(logFilePath !== undefined ? { logFilePath } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...lineage,
    });
  });
}
