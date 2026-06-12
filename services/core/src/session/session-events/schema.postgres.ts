/**
 * Postgres face for the session events table.
 *
 * The table is defined once via `defineDualTable` in `schema.ts`; this file
 * exposes its Postgres face under the canonical name so the Postgres migration
 * chain and the dialect-variant aggregate keep resolving it.
 */
import { sessionEventsDual } from './schema.js';

/** Postgres face of the `session_events` table. */
export const sessionEvents = sessionEventsDual.postgres;
