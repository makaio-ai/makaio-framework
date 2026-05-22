import {
  SessionStorageNamespace as _SessionStorageNamespace,
  SessionStorageSubjects,
  SessionWithPreviewSchema,
  SessionPreviewDataSchema,
} from '@makaio/contracts';
import { sessions, agents } from './schema.js';

export { SessionStorageSubjects };
export type { SessionPreviewData, SessionWithPreview } from '@makaio/contracts';

/**
 * Session storage namespace with Drizzle extension.
 *
 * Bus subjects are defined in `@makaio/contracts` (source of truth).
 * This namespace extends the contracts definition with the Drizzle
 * table schemas so handlers can access the `sessions` and `agents` tables.
 * @example
 * ```typescript
 * import { SessionStorageNamespace, SessionStorageSubjects } from '@makaio/services-core/session';
 *
 * // Use bus subjects
 * const { session } = await bus.request(SessionStorageSubjects.get, { sessionId: '123' });
 *
 * // Access drizzle schemas for custom queries
 * const { sessions, agents } = SessionStorageNamespace.extensions.drizzle;
 * ```
 */
export const SessionStorageNamespace = {
  ..._SessionStorageNamespace,
  extensions: {
    drizzle: { sessions, agents },
  },
};

// Re-export schema helpers that consumers import from this module.
export { SessionPreviewDataSchema, SessionWithPreviewSchema };
