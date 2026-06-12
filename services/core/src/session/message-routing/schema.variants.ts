import { defineDialectSchema } from '@makaio/storage-drizzle';
import { messageRouting } from './schema.js';
import { messageRouting as messageRoutingPg } from './schema.postgres.js';

/** Dialect variants for the message routing table. */
export const messageRoutingSchema = defineDialectSchema({ messageRouting }, { messageRouting: messageRoutingPg });
