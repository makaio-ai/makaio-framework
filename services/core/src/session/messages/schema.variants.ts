import { defineDialectSchema, type DualColumnRef } from '@makaio/storage-drizzle';
import { messages } from './schema.js';
import { messages as messagesPg } from './schema.postgres.js';

/** Dialect variants for the messages table. */
export const messagesSchema = defineDialectSchema({ messages }, { messages: messagesPg });

/**
 * Foreign-key target for the `messages.message_id` primary key, as a dual
 * column-pair thunk consumable by `defineDualTable` `references()`.
 *
 * The `messages` table is a hand-written twin (the full-text-search escape
 * hatch), so it has no `columnPair` accessor of its own. This thunk stands in
 * for one: it pairs the SQLite and Postgres `messageId` faces under a single
 * key so referencing dual tables resolve the dialect-correct column without
 * importing both twin faces themselves.
 * @returns The SQLite and Postgres `messageId` columns as a dual column-pair.
 */
export const messageIdColumnPair: DualColumnRef = () => ({
  sqlite: messages.messageId,
  postgres: messagesPg.messageId,
});
