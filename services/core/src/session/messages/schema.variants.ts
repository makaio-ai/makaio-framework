import { defineDialectSchema } from '@makaio/storage-drizzle';
import { messages } from './schema.js';
import { messages as messagesPg } from './schema.postgres.js';

/** Dialect variants for the messages table. */
export const messagesSchema = defineDialectSchema({ messages }, { messages: messagesPg });
