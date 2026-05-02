import {
  SessionEventStorageNamespace as _SessionEventStorageNamespace,
  SessionEventStorageSubjects,
} from '@makaio/contracts';
import { sessionEvents } from './schema.js';

export { SessionEventStorageSubjects };

/**
 * Session event storage namespace with Drizzle extension.
 *
 * Bus subjects are defined in `@makaio/contracts` (source of truth).
 * This namespace extends the contracts definition with the Drizzle
 * table schema so handlers can access the `sessionEvents` table.
 * @example
 * ```typescript
 * import { SessionEventStorageNamespace, SessionEventStorageSubjects } from '@makaio/services-core/session';
 *
 * // Use bus subjects
 * const { events } = await bus.request(SessionEventStorageSubjects.getEvents, {
 *   sessionId: '123',
 * });
 *
 * // Access drizzle schemas for custom queries
 * const { sessionEvents } = SessionEventStorageNamespace.extensions.drizzle;
 * ```
 */
export const SessionEventStorageNamespace = {
  ..._SessionEventStorageNamespace,
  extensions: {
    drizzle: { sessionEvents },
  },
};
