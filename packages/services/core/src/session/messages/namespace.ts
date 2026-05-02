import {
  MessageStorageNamespace as _MessageStorageNamespace,
  MessageStorageSubjects,
  MessagePageCursorSchema,
} from '@makaio/contracts';
import { messages } from './schema.js';

export { MessageStorageSubjects, MessagePageCursorSchema };
export type { MessagePageCursor } from '@makaio/contracts';

/**
 * Message storage namespace with Drizzle extension.
 *
 * Bus subjects are defined in `@makaio/contracts` (source of truth).
 * This namespace extends the contracts definition with the Drizzle
 * table schema so handlers can access the `messages` table.
 * @example
 * ```typescript
 * import { MessageStorageNamespace, MessageStorageSubjects } from '@makaio/services-core/session';
 *
 * // Use bus subjects
 * const { message } = await bus.request(MessageStorageSubjects.get, { messageId: '123' });
 *
 * // Access drizzle schemas for custom queries
 * const { messages } = MessageStorageNamespace.extensions.drizzle;
 * ```
 */
export const MessageStorageNamespace = {
  ..._MessageStorageNamespace,
  extensions: {
    drizzle: { messages },
  },
};
