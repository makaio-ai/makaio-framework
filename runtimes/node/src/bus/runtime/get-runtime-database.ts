import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { RuntimeSubjects } from './namespace.js';

/**
 * Resolve the runtime database handle with `db` narrowed to
 * {@link MakaioDatabase}.
 *
 * Wraps the `runtime.database` request so the single cast from the opaque
 * wire shape lives here — at the runtime boundary — instead of being repeated
 * at every consumer. For storage handler registration prefer
 * `registerDrizzleHandlers` from `@makaio/storage-drizzle`, which receives the
 * handle through the extension storage lifecycle; this helper covers typed
 * ad-hoc access outside that seam.
 * @typeParam TSchema - Drizzle table schema record. Defaults to an empty schema.
 * @param bus - Connected bus instance.
 * @returns The runtime's Drizzle database handle.
 * @throws When no runtime registered a database provider (memory-only runtimes).
 */
export async function getRuntimeDatabase<TSchema extends Record<string, unknown> = Record<string, never>>(
  bus: IMakaioBus,
): Promise<MakaioDatabase<TSchema>> {
  const { db } = await bus.request(RuntimeSubjects.database, {});
  return db as MakaioDatabase<TSchema>;
}
