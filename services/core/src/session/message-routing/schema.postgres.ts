/**
 * Postgres face for the message routing table.
 *
 * The table is defined once via `defineDualTable` in `schema.ts`; this file
 * exposes its Postgres face under the canonical name so the Postgres migration
 * chain and the dialect-variant aggregate keep resolving it.
 */
import { messageRoutingDual } from './schema.js';

/** Postgres face of the `message_routing` table. */
export const messageRouting = messageRoutingDual.postgres;
